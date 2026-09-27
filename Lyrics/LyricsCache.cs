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
        public async Task<LyricsResult?> TryReadAsync(LyricsLookup lookup, CancellationToken cancellationToken)
        {
            try
            {
                await using FileStream stream = new(PathFor(lookup.TrackId), new FileStreamOptions
                {
                    Mode = FileMode.Open,
                    Access = FileAccess.Read,
                    Share = FileShare.Read,
                    Options = FileOptions.Asynchronous | FileOptions.SequentialScan
                });
                CachedLyrics? cached = await JsonSerializer
                    .DeserializeAsync<CachedLyrics>(stream, JsonOptions, cancellationToken)
                    .ConfigureAwait(false);

                if (cached is null || cached.SchemaVersion != SchemaVersion || !MatchesTags(cached, lookup))
                {
                    return null;
                }

                if (!cached.Found)
                {
                    return DateTimeOffset.UtcNow - cached.RetrievedAt < NotFoundLifetime
                        ? LyricsResult.NotFound
                        : null;
                }

                return new LyricsResult
                {
                    Status = LyricsStatus.Found,
                    LrclibId = cached.LrclibId,
                    SyncedLyrics = cached.SyncedLyrics,
                    PlainLyrics = cached.PlainLyrics,
                    Instrumental = cached.Instrumental
                };
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

        public async Task WriteAsync(LyricsLookup lookup, LyricsResult result, CancellationToken cancellationToken)
        {
            if (result.Status == LyricsStatus.Failed)
            {
                return;
            }

            string path = PathFor(lookup.TrackId);
            string temp = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                Directory.CreateDirectory(root);
                CachedLyrics cached = new()
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
                    RetrievedAt = DateTimeOffset.UtcNow
                };

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
