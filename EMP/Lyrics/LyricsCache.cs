using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.Lyrics
{
    internal sealed class LyricsCache
    {
        private const int SchemaVersion = 1;
        private static readonly TimeSpan NotFoundLifetime = TimeSpan.FromHours(24);
        internal static readonly TimeSpan SyncedUpgradeInterval = TimeSpan.FromDays(7);
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = true
        };

        private readonly string root;

        public static string DefaultRoot => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "Lyrics");

        public LyricsCache()
            : this(DefaultRoot)
        {
        }

        public LyricsCache(string root)
        {
            this.root = root;
        }

        /// <summary>
        /// Returns null when there is no usable entry: missing, unreadable, from an older schema,
        /// for different tags than the file now has, or an expired "not found".
        /// </summary>
        public async Task<LyricsCacheHit?> TryReadAsync(LyricsLookup lookup, CancellationToken cancellationToken)
        {
            try
            {
                CachedLyrics? cached = await ReadFileAsync(lookup.TrackId, cancellationToken).ConfigureAwait(false);
                if (cached is null || cached.SchemaVersion != SchemaVersion || !MatchesTags(cached, lookup))
                {
                    return null;
                }

                if (!cached.Found)
                {
                    return DateTimeOffset.UtcNow - cached.RetrievedAt < NotFoundLifetime
                        ? new LyricsCacheHit(LyricsResult.NotFound, EligibleForSyncedUpgrade: false)
                        : null;
                }

                LyricsResult result = new()
                {
                    Status = LyricsStatus.Found,
                    LrclibId = cached.LrclibId,
                    SyncedLyrics = cached.SyncedLyrics,
                    PlainLyrics = cached.PlainLyrics,
                    Instrumental = cached.Instrumental
                };
                return new LyricsCacheHit(result, IsEligibleForSyncedUpgrade(cached, result));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public async Task WriteAsync(
            LyricsLookup lookup,
            LyricsResult result,
            CancellationToken cancellationToken,
            DateTimeOffset? syncedUpgradeCheckedAt = null)
        {
            if (result.Status == LyricsStatus.Failed)
            {
                return;
            }

            CachedLyrics cached = BuildEntry(lookup, result, DateTimeOffset.UtcNow, syncedUpgradeCheckedAt);
            _ = await WriteFileAsync(lookup.TrackId, cached, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// Records a completed synchronized-lyrics recheck without discarding plain lyrics.
        /// No-ops when the cache is missing, tags changed, or synchronized lyrics are already present.
        /// </summary>
        public async Task MarkSyncedUpgradeCheckedAsync(LyricsLookup lookup, CancellationToken cancellationToken)
        {
            try
            {
                CachedLyrics? cached = await ReadFileAsync(lookup.TrackId, cancellationToken).ConfigureAwait(false);
                if (cached is null || cached.SchemaVersion != SchemaVersion || !MatchesTags(cached, lookup) || !cached.Found)
                {
                    return;
                }

                LyricsResult current = new()
                {
                    Status = LyricsStatus.Found,
                    LrclibId = cached.LrclibId,
                    SyncedLyrics = cached.SyncedLyrics,
                    PlainLyrics = cached.PlainLyrics,
                    Instrumental = cached.Instrumental
                };
                if (!current.IsPlainOnly)
                {
                    return;
                }

                CachedLyrics updated = new()
                {
                    SchemaVersion = cached.SchemaVersion,
                    TrackId = cached.TrackId,
                    Title = cached.Title,
                    Artist = cached.Artist,
                    Album = cached.Album,
                    Duration = cached.Duration,
                    Found = cached.Found,
                    LrclibId = cached.LrclibId,
                    SyncedLyrics = cached.SyncedLyrics,
                    PlainLyrics = cached.PlainLyrics,
                    Instrumental = cached.Instrumental,
                    RetrievedAt = cached.RetrievedAt,
                    SyncedUpgradeCheckedAt = DateTimeOffset.UtcNow
                };
                _ = await WriteFileAsync(lookup.TrackId, updated, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                // Cache writes are best-effort.
            }
        }

        /// <summary>
        /// Atomically replaces plain-only lyrics with a synchronized result when the cache still
        /// matches <paramref name="lookup"/> and has not already been upgraded.
        /// </summary>
        public async Task<bool> TryWriteSyncedUpgradeAsync(
            LyricsLookup lookup,
            LyricsResult syncedResult,
            CancellationToken cancellationToken)
        {
            if (syncedResult.Status != LyricsStatus.Found || !syncedResult.HasSyncedLyrics)
            {
                return false;
            }

            try
            {
                CachedLyrics? cached = await ReadFileAsync(lookup.TrackId, cancellationToken).ConfigureAwait(false);
                if (cached is null || cached.SchemaVersion != SchemaVersion || !MatchesTags(cached, lookup) || !cached.Found)
                {
                    return false;
                }

                if (!string.IsNullOrWhiteSpace(cached.SyncedLyrics))
                {
                    // A newer or concurrent write already has synchronized lyrics.
                    return false;
                }

                if (string.IsNullOrWhiteSpace(cached.PlainLyrics) && !syncedResult.HasPlainLyrics)
                {
                    return false;
                }

                string? plain = !string.IsNullOrWhiteSpace(syncedResult.PlainLyrics)
                    ? syncedResult.PlainLyrics
                    : cached.PlainLyrics;

                CachedLyrics updated = new()
                {
                    SchemaVersion = SchemaVersion,
                    TrackId = lookup.TrackId,
                    Title = lookup.Title,
                    Artist = lookup.Artist,
                    Album = lookup.Album,
                    Duration = lookup.Duration,
                    Found = true,
                    LrclibId = syncedResult.LrclibId ?? cached.LrclibId,
                    SyncedLyrics = syncedResult.SyncedLyrics,
                    PlainLyrics = plain,
                    Instrumental = false,
                    RetrievedAt = DateTimeOffset.UtcNow,
                    SyncedUpgradeCheckedAt = DateTimeOffset.UtcNow
                };
                return await WriteFileAsync(lookup.TrackId, updated, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool IsEligibleForSyncedUpgrade(CachedLyrics cached, LyricsResult result)
        {
            if (!result.IsPlainOnly)
            {
                return false;
            }

            if (cached.SyncedUpgradeCheckedAt is not DateTimeOffset checkedAt)
            {
                // Legacy entries and never-checked plain lyrics are eligible immediately.
                return true;
            }

            return DateTimeOffset.UtcNow - checkedAt >= SyncedUpgradeInterval;
        }

        private static CachedLyrics BuildEntry(
            LyricsLookup lookup,
            LyricsResult result,
            DateTimeOffset retrievedAt,
            DateTimeOffset? syncedUpgradeCheckedAt)
        {
            DateTimeOffset? upgradeChecked = syncedUpgradeCheckedAt;
            if (result.Status == LyricsStatus.Found && result.HasSyncedLyrics)
            {
                upgradeChecked = null;
            }

            return new CachedLyrics
            {
                SchemaVersion = SchemaVersion,
                TrackId = lookup.TrackId,
                Title = lookup.Title,
                Artist = lookup.Artist,
                Album = lookup.Album,
                Duration = lookup.Duration,
                Found = result.Status == LyricsStatus.Found,
                LrclibId = result.LrclibId,
                SyncedLyrics = result.SyncedLyrics,
                PlainLyrics = result.PlainLyrics,
                Instrumental = result.Instrumental,
                RetrievedAt = retrievedAt,
                SyncedUpgradeCheckedAt = upgradeChecked
            };
        }

        private async Task<CachedLyrics?> ReadFileAsync(string trackId, CancellationToken cancellationToken)
        {
            await using FileStream stream = new(PathFor(trackId), new FileStreamOptions
            {
                Mode = FileMode.Open,
                Access = FileAccess.Read,
                Share = FileShare.Read,
                Options = FileOptions.Asynchronous | FileOptions.SequentialScan
            });
            return await JsonSerializer
                .DeserializeAsync<CachedLyrics>(stream, JsonOptions, cancellationToken)
                .ConfigureAwait(false);
        }

        private async Task<bool> WriteFileAsync(string trackId, CachedLyrics cached, CancellationToken cancellationToken)
        {
            string path = PathFor(trackId);
            string temp = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                Directory.CreateDirectory(root);
                await using (FileStream stream = new(temp, new FileStreamOptions
                {
                    Mode = FileMode.CreateNew,
                    Access = FileAccess.Write,
                    Share = FileShare.None,
                    Options = FileOptions.Asynchronous
                }))
                {
                    await JsonSerializer.SerializeAsync(stream, cached, JsonOptions, cancellationToken).ConfigureAwait(false);
                }

                File.Move(temp, path, overwrite: true);
                return true;
            }
            catch (Exception)
            {
                // Cache writes are best-effort.
                try
                {
                    File.Delete(temp);
                }
                catch (Exception)
                {
                    // Leave the temp file; it's harmless.
                }

                return false;
            }
        }

        private static bool MatchesTags(CachedLyrics cached, LyricsLookup lookup)
        {
            return string.Equals(cached.TrackId, lookup.TrackId, StringComparison.OrdinalIgnoreCase)
                && string.Equals(cached.Title, lookup.Title, StringComparison.Ordinal)
                && string.Equals(cached.Artist, lookup.Artist, StringComparison.Ordinal)
                && string.Equals(cached.Album, lookup.Album, StringComparison.Ordinal)
                && Math.Abs(cached.Duration - lookup.Duration) < 1;
        }

        private string PathFor(string trackId)
        {
            string hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(trackId)))[..32].ToLowerInvariant();
            return Path.Combine(root, $"{hash}.json");
        }
    }
}
