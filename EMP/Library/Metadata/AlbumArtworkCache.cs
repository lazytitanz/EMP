namespace EMP.Library.Metadata
{
    internal static class AlbumArtworkCache
    {
        public static string? WriteAlbumCover(string artworkRoot, string albumId, byte[] data, string mime)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(artworkRoot);
            ArgumentException.ThrowIfNullOrWhiteSpace(albumId);
            ArgumentNullException.ThrowIfNull(data);

            Directory.CreateDirectory(artworkRoot);
            DeleteAlbumCovers(artworkRoot, albumId);

            string extension = mime.Contains("png", StringComparison.OrdinalIgnoreCase) ? ".png" : ".jpg";
            string fileName = albumId + extension;
            string outputPath = Path.Combine(artworkRoot, fileName);
            File.WriteAllBytes(outputPath, data);
            return "artwork/" + fileName + "?v=" + DateTime.UtcNow.Ticks;
        }

        public static void DeleteAlbumCovers(string artworkRoot, string albumId)
        {
            if (string.IsNullOrWhiteSpace(artworkRoot) || string.IsNullOrWhiteSpace(albumId))
            {
                return;
            }

            foreach (string extension in new[] { ".jpg", ".png", ".jpeg" })
            {
                string path = Path.Combine(artworkRoot, albumId + extension);
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
    }
}
