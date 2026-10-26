using System.Collections.Concurrent;

namespace EMP.Lyrics
{
    internal sealed class LyricsService : IDisposable
    {
        private const int MaxConcurrentRequests = 2;
        private static readonly TimeSpan FailureCooldown = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan LookupTimeout = TimeSpan.FromSeconds(30);

        private readonly LyricsClient client = new();
        private readonly LyricsCache cache = new();
        private readonly SemaphoreSlim requestGate = new(MaxConcurrentRequests, MaxConcurrentRequests);
        private readonly CancellationTokenSource shutdown = new();
        private readonly ConcurrentDictionary<string, Lazy<Task<LyricsResult>>> inFlight = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, byte> upgradesInFlight = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, DateTimeOffset> recentFailures = new(StringComparer.OrdinalIgnoreCase);
        private readonly Action<LyricsLookup, LyricsResult>? onSyncedUpgrade;
        private int disposed;

        public LyricsService(Action<LyricsLookup, LyricsResult>? onSyncedUpgrade = null)
        {
            this.onSyncedUpgrade = onSyncedUpgrade;
        }

        /// <summary>
        /// Never throws. A request for a track that is already loading, for example because it was
        /// prefetched, shares the running lookup instead of calling LRCLIB again.
        /// </summary>
        public Task<LyricsResult> GetAsync(LyricsLookup lookup)
        {
            if (Volatile.Read(ref disposed) != 0)
            {
                return Task.FromResult(LyricsResult.Failed);
            }

            Lazy<Task<LyricsResult>> entry = inFlight.GetOrAdd(
                lookup.TrackId,
                _ => new Lazy<Task<LyricsResult>>(() => RunAsync(lookup)));
            return entry.Value;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0)
            {
                return;
            }

            // Outstanding lookups observe the cancellation and finish as Failed; nothing waits on them.
            try
            {
                shutdown.Cancel();
            }
            catch (AggregateException)
            {
                // Cancellation callbacks are ours and don't throw, but shutdown must not fail.
            }

            client.Dispose();
            shutdown.Dispose();
        }

        private async Task<LyricsResult> RunAsync(LyricsLookup lookup)
        {
            try
            {
                return await LoadAsync(lookup).ConfigureAwait(false);
            }
            finally
            {
                inFlight.TryRemove(lookup.TrackId, out _);
            }
        }

        private async Task<LyricsResult> LoadAsync(LyricsLookup lookup)
        {
            try
            {
                CancellationToken token = shutdown.Token;
                LyricsCacheHit? cached = await cache.TryReadAsync(lookup, token).ConfigureAwait(false);
                if (cached is LyricsCacheHit hit)
                {
                    if (hit.EligibleForSyncedUpgrade)
                    {
                        ScheduleSyncedUpgrade(lookup);
                    }

                    return hit.Result;
                }

                if (!CanSearch(lookup))
                {
                    return LyricsResult.NotFound;
                }

                if (recentFailures.TryGetValue(lookup.TrackId, out DateTimeOffset failedAt)
                    && DateTimeOffset.UtcNow - failedAt < FailureCooldown)
                {
                    return LyricsResult.Failed;
                }

                LyricsResult result;
                try
                {
                    result = await FetchAsync(lookup, token).ConfigureAwait(false);
                }
                catch (Exception) when (!token.IsCancellationRequested)
                {
                    result = LyricsResult.Failed;
                }

                if (result.Status == LyricsStatus.Failed)
                {
                    recentFailures[lookup.TrackId] = DateTimeOffset.UtcNow;
                    return result;
                }

                recentFailures.TryRemove(lookup.TrackId, out _);
                // Plain-only means LRCLIB was already searched for this recording; wait the upgrade interval.
                DateTimeOffset? upgradeChecked = result.IsPlainOnly ? DateTimeOffset.UtcNow : null;
                await cache.WriteAsync(lookup, result, token, upgradeChecked).ConfigureAwait(false);
                return result;
            }
            catch (Exception)
            {
                // Shutdown cancellation, a disposed client, or anything unexpected. Never surface it.
                return LyricsResult.Failed;
            }
        }

        private void ScheduleSyncedUpgrade(LyricsLookup lookup)
        {
            if (Volatile.Read(ref disposed) != 0 || !CanSearch(lookup))
            {
                return;
            }

            if (recentFailures.TryGetValue(lookup.TrackId, out DateTimeOffset failedAt)
                && DateTimeOffset.UtcNow - failedAt < FailureCooldown)
            {
                return;
            }

            if (!upgradesInFlight.TryAdd(lookup.TrackId, 0))
            {
                return;
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    await RunSyncedUpgradeAsync(lookup).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // Upgrade work must never fault the process.
                }
                finally
                {
                    upgradesInFlight.TryRemove(lookup.TrackId, out _);
                }
            });
        }

        private async Task RunSyncedUpgradeAsync(LyricsLookup lookup)
        {
            CancellationToken token = shutdown.Token;
            if (token.IsCancellationRequested || Volatile.Read(ref disposed) != 0)
            {
                return;
            }

            if (recentFailures.TryGetValue(lookup.TrackId, out DateTimeOffset failedAt)
                && DateTimeOffset.UtcNow - failedAt < FailureCooldown)
            {
                return;
            }

            LyricsResult? synced;
            try
            {
                synced = await FetchSyncedUpgradeAsync(lookup, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (Exception) when (!token.IsCancellationRequested)
            {
                recentFailures[lookup.TrackId] = DateTimeOffset.UtcNow;
                return;
            }

            if (token.IsCancellationRequested || Volatile.Read(ref disposed) != 0)
            {
                return;
            }

            if (synced is null)
            {
                // Completed recheck with no suitable synchronized match: keep plain lyrics.
                await cache.MarkSyncedUpgradeCheckedAsync(lookup, token).ConfigureAwait(false);
                return;
            }

            recentFailures.TryRemove(lookup.TrackId, out _);
            if (!await cache.TryWriteSyncedUpgradeAsync(lookup, synced, token).ConfigureAwait(false))
            {
                return;
            }

            LyricsCacheHit? upgraded = await cache.TryReadAsync(lookup, token).ConfigureAwait(false);
            LyricsResult notify = upgraded is { Result.HasSyncedLyrics: true }
                ? upgraded.Value.Result
                : synced;

            try
            {
                onSyncedUpgrade?.Invoke(lookup, notify);
            }
            catch (Exception)
            {
                // UI notification is best-effort; the cache already holds the upgrade.
            }
        }

        private async Task<LyricsResult> FetchAsync(LyricsLookup lookup, CancellationToken shutdownToken)
        {
            await requestGate.WaitAsync(shutdownToken).ConfigureAwait(false);
            try
            {
                using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
                timeout.CancelAfter(LookupTimeout);
                CancellationToken cancellationToken = timeout.Token;

                LrclibRecord? exact = null;
                if (LyricsClient.CanUseExactLookup(lookup))
                {
                    exact = await client.GetAsync(lookup, cancellationToken).ConfigureAwait(false);
                    if (exact is not null
                        && LyricsClient.HasParseableSyncedLyrics(exact.SyncedLyrics)
                        && LyricsClient.IsUsable(exact))
                    {
                        return ToResult(exact);
                    }
                }

                IReadOnlyList<LrclibRecord> candidates = await client.SearchAsync(lookup, cancellationToken).ConfigureAwait(false);
                LrclibRecord? match = LyricsClient.SelectBestMatch(lookup, candidates);
                if (match is not null && LyricsClient.HasParseableSyncedLyrics(match.SyncedLyrics))
                {
                    return ToResult(match);
                }

                // Prefer a synchronized search hit, otherwise keep a usable exact plain/instrumental hit.
                if (exact is not null && LyricsClient.IsUsable(exact))
                {
                    return ToResult(exact);
                }

                return match is null ? LyricsResult.NotFound : ToResult(match);
            }
            finally
            {
                requestGate.Release();
            }
        }

        /// <summary>
        /// Looks specifically for parseable synchronized lyrics. Always considers search, even when
        /// an exact lookup previously returned plain-only lyrics.
        /// Returns null when no suitable synchronized match exists (not a transport failure).
        /// </summary>
        private async Task<LyricsResult?> FetchSyncedUpgradeAsync(LyricsLookup lookup, CancellationToken shutdownToken)
        {
            await requestGate.WaitAsync(shutdownToken).ConfigureAwait(false);
            try
            {
                using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
                timeout.CancelAfter(LookupTimeout);
                CancellationToken cancellationToken = timeout.Token;

                if (LyricsClient.CanUseExactLookup(lookup))
                {
                    LrclibRecord? exact = await client.GetAsync(lookup, cancellationToken).ConfigureAwait(false);
                    if (exact is not null && LyricsClient.HasParseableSyncedLyrics(exact.SyncedLyrics))
                    {
                        return ToResult(exact);
                    }
                }

                IReadOnlyList<LrclibRecord> candidates = await client.SearchAsync(lookup, cancellationToken).ConfigureAwait(false);
                LrclibRecord? match = LyricsClient.SelectBestMatch(lookup, candidates, requireSynced: true);
                return match is null ? null : ToResult(match);
            }
            finally
            {
                requestGate.Release();
            }
        }

        private static bool CanSearch(LyricsLookup lookup)
        {
            return !string.IsNullOrWhiteSpace(lookup.Title)
                && !string.IsNullOrWhiteSpace(lookup.Artist)
                && !string.Equals(lookup.Artist.Trim(), "Unknown Artist", StringComparison.OrdinalIgnoreCase);
        }

        private static LyricsResult ToResult(LrclibRecord record)
        {
            string? synced = LyricsClient.HasParseableSyncedLyrics(record.SyncedLyrics) ? record.SyncedLyrics : null;
            string? plain = string.IsNullOrWhiteSpace(record.PlainLyrics) ? null : record.PlainLyrics;
            return new LyricsResult
            {
                Status = LyricsStatus.Found,
                LrclibId = record.Id,
                SyncedLyrics = synced,
                PlainLyrics = plain,
                Instrumental = record.Instrumental && synced is null && plain is null
            };
        }
    }
}
