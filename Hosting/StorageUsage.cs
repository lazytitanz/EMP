using EMP.Library;
using EMP.Lyrics;

namespace EMP.Hosting
{
    internal static class StorageUsage
    {
        private static readonly EnumerationOptions RecursiveFiles = new()
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint
        };

        public static long LibraryBytes(IEnumerable<string> trackPaths)
        {
            long total = 0;
            foreach (string path in trackPaths.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    FileInfo file = new(path);
                    if (file.Exists)
                    {
                        total += file.Length;
                    }
                }
                catch (Exception)
                {
                    // Files can disappear or become unreadable between scans.
                }
            }

            return total;
        }

        public static long CacheBytes()
        {
            string[] folders =
            [
                Path.Combine(WebUiHost.WwwRootPath, "artwork"),
                MusicLibraryScanner.ArtworkCachePath,
                LyricsCache.DefaultRoot,
                MusicBrainzClient.CacheRoot
            ];

            return folders
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Sum(FolderBytes);
        }

        private static long FolderBytes(string folder)
        {
            long total = 0;
            try
            {
                DirectoryInfo directory = new(folder);
                if (!directory.Exists)
                {
                    return 0;
                }

                foreach (FileInfo file in directory.EnumerateFiles("*", RecursiveFiles))
                {
                    try
                    {
                        total += file.Length;
                    }
                    catch (Exception)
                    {
                        // Cache files can be replaced while they are being counted.
                    }
                }
            }
            catch (Exception)
            {
                // Report whatever could be counted.
            }

            return total;
        }
    }
}
