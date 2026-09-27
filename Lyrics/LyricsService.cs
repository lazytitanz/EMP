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
        private readonly ConcurrentDictionary<string, DateTimeOffset> recentFailures = new(StringComparer.OrdinalIgnoreCase);
        private int disposed;

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
                LyricsResult? cached = await cache.TryReadAsync(lookup, token).ConfigureAwait(false);
                if (cached is not null)
                {
                    return cached;
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
                await cache.WriteAsync(lookup, result, token).ConfigureAwait(false);
                return result;
            }
            catch (Exception)
            {
                // Shutdown cancellation, a disposed client, or anything unexpected. Never surface it.
                return LyricsResult.Failed;
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

                if (LyricsClient.CanUseExactLookup(lookup))
                {
                    LrclibRecord? exact = await client.GetAsync(lookup, cancellationToken).ConfigureAwait(false);
                    if (exact is not null && LyricsClient.IsUsable(exact))
                    {
                        return ToResult(exact);
                    }
                }

                IReadOnlyList<LrclibRecord> candidates = await client.SearchAsync(lookup, cancellationToken).ConfigureAwait(false);
                LrclibRecord? match = LyricsClient.SelectBestMatch(lookup, candidates);
                return match is null ? LyricsResult.NotFound : ToResult(match);
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
            string? synced = string.IsNullOrWhiteSpace(record.SyncedLyrics) ? null : record.SyncedLyrics;
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
