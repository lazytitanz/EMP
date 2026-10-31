using System.Security.Cryptography;

namespace EMP.Library.Metadata
{
    internal static class AlbumArtworkCache
    {
        private static readonly object ArtworkWriteGate = new();

        private static readonly string[] CoverExtensions = [".jpg", ".png", ".jpeg"];

        /// <summary>
        /// Ensures album cover bytes are on disk under a content-addressed URL.
        /// Warm path: when <paramref name="previousCoverUrl"/> already carries this content
        /// hash and the file exists with a matching length, skips byte-compare and rewrite.
        /// </summary>
        public static string? EnsureAlbumCover(
            string artworkRoot,
            string albumId,
            byte[] data,
            string? mime,
            string? previousCoverUrl = null)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(artworkRoot);
            ArgumentException.ThrowIfNullOrWhiteSpace(albumId);
            ArgumentNullException.ThrowIfNull(data);
            if (data.Length == 0)
            {
                return null;
            }

            string extension = ExtensionForMime(mime);
            string fileName = albumId + extension;
            string outputPath = Path.Combine(artworkRoot, fileName);
            string version = ContentVersion(data);
            string coverUrl = "artwork/" + fileName + "?v=" + version;

            lock (ArtworkWriteGate)
            {
                Directory.CreateDirectory(artworkRoot);

                if (TryReuseExistingCover(outputPath, data, previousCoverUrl, version))
                {
                    DeleteOtherExtensions(artworkRoot, albumId, extension);
                    return coverUrl;
                }

                AtomicWrite(outputPath, data);
                DeleteOtherExtensions(artworkRoot, albumId, extension);
                return coverUrl;
            }
        }

        public static string? WriteAlbumCover(string artworkRoot, string albumId, byte[] data, string mime)
        {
            return EnsureAlbumCover(artworkRoot, albumId, data, mime, previousCoverUrl: null);
        }

        public static void DeleteAlbumCovers(string artworkRoot, string albumId)
        {
            if (string.IsNullOrWhiteSpace(artworkRoot) || string.IsNullOrWhiteSpace(albumId))
            {
                return;
            }

            lock (ArtworkWriteGate)
            {
                foreach (string extension in CoverExtensions)
                {
                    TryDelete(Path.Combine(artworkRoot, albumId + extension));
                }
            }
        }

        /// <summary>
        /// Regenerates album cache only when every track in the album was part of a successful
        /// artwork set/clear. Single-track artwork edits must not call this with a partial set.
        /// </summary>
        public static bool ShouldRegenerateAlbumCover(
            IReadOnlyCollection<string> albumTrackIds,
            IReadOnlyCollection<string> successfulArtworkTrackIds)
        {
            if (albumTrackIds.Count == 0 || successfulArtworkTrackIds.Count == 0)
            {
                return false;
            }

            foreach (string trackId in albumTrackIds)
            {
                if (!successfulArtworkTrackIds.Contains(trackId, StringComparer.OrdinalIgnoreCase))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>Strip <c>?v=</c> (or any query) for filesystem resolution. Browser URLs keep the query.</summary>
        public static string? StripCoverUrlQuery(string? coverUrl)
        {
            if (string.IsNullOrWhiteSpace(coverUrl))
            {
                return null;
            }

            int query = coverUrl.IndexOf('?', StringComparison.Ordinal);
            string path = query < 0 ? coverUrl.Trim() : coverUrl[..query].Trim();
            return string.IsNullOrWhiteSpace(path) ? null : path;
        }

        public static string ContentVersion(byte[] data)
        {
            ArgumentNullException.ThrowIfNull(data);
            return Convert.ToHexString(SHA256.HashData(data))[..12].ToLowerInvariant();
        }

        internal static string ExtensionForMime(string? mime)
        {
            return mime?.Contains("png", StringComparison.OrdinalIgnoreCase) == true
                ? ".png"
                : ".jpg";
        }

        private static bool TryReuseExistingCover(
            string outputPath,
            byte[] data,
            string? previousCoverUrl,
            string version)
        {
            if (!File.Exists(outputPath))
            {
                return false;
            }

            long length;
            try
            {
                length = new FileInfo(outputPath).Length;
            }
            catch (Exception)
            {
                return false;
            }

            if (length != data.Length)
            {
                return false;
            }

            // Warm path: prior library CoverUrl already names this content hash.
            if (CoverUrlHasVersion(previousCoverUrl, version))
            {
                return true;
            }

            // Fallback when regenerating/validating without a matching prior URL.
            return FilesEqual(outputPath, data);
        }

        private static bool CoverUrlHasVersion(string? coverUrl, string version)
        {
            if (string.IsNullOrWhiteSpace(coverUrl) || string.IsNullOrWhiteSpace(version))
            {
                return false;
            }

            int query = coverUrl.IndexOf('?', StringComparison.Ordinal);
            if (query < 0 || query + 1 >= coverUrl.Length)
            {
                return false;
            }

            string queryText = coverUrl[(query + 1)..];
            foreach (string part in queryText.Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                int eq = part.IndexOf('=', StringComparison.Ordinal);
                if (eq <= 0)
                {
                    continue;
                }

                string key = part[..eq];
                string value = part[(eq + 1)..];
                if (key.Equals("v", StringComparison.OrdinalIgnoreCase)
                    && value.Equals(version, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool FilesEqual(string path, byte[] data)
        {
            try
            {
                byte[] existing = File.ReadAllBytes(path);
                return existing.AsSpan().SequenceEqual(data);
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void AtomicWrite(string outputPath, byte[] data)
        {
            string? directory = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            string temp = outputPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllBytes(temp, data);
                File.Move(temp, outputPath, overwrite: true);
            }
            catch
            {
                TryDelete(temp);
                throw;
            }
        }

        private static void DeleteOtherExtensions(string artworkRoot, string albumId, string keepExtension)
        {
            foreach (string extension in CoverExtensions)
            {
                if (extension.Equals(keepExtension, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                TryDelete(Path.Combine(artworkRoot, albumId + extension));
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception)
            {
                // Best-effort deletion.
            }
        }
    }
}
