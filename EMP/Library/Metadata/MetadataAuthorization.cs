namespace EMP.Library.Metadata
{
    internal static class MetadataAuthorization
    {
        public static bool TryResolveAuthorizedPath(
            string? trackId,
            IReadOnlyList<string> musicRoots,
            out LibraryMediaLocation location,
            out MetadataErrorCode errorCode)
        {
            location = null!;
            errorCode = MetadataErrorCode.None;

            if (string.IsNullOrWhiteSpace(trackId))
            {
                errorCode = MetadataErrorCode.InvalidRequest;
                return false;
            }

            if (!LibraryMediaIndex.TryGet(trackId, out location))
            {
                errorCode = MetadataErrorCode.NotFound;
                return false;
            }

            string? normalizedFile = MusicFolderPaths.TryNormalize(location.FullPath);
            if (normalizedFile is null || !File.Exists(normalizedFile))
            {
                errorCode = MetadataErrorCode.NotFound;
                return false;
            }

            if (!IsUnderConfiguredRoot(normalizedFile, musicRoots))
            {
                errorCode = MetadataErrorCode.Unauthorized;
                return false;
            }

            location = new LibraryMediaLocation
            {
                TrackId = location.TrackId,
                FullPath = normalizedFile,
                RootPath = location.RootPath,
                Title = location.Title,
                Artist = location.Artist,
                Album = location.Album,
                Duration = location.Duration,
                ArtworkPath = location.ArtworkPath
            };
            return true;
        }

        public static bool IsUnderConfiguredRoot(string fullPath, IReadOnlyList<string> musicRoots)
        {
            string? normalizedFile = MusicFolderPaths.TryNormalize(fullPath);
            if (normalizedFile is null)
            {
                return false;
            }

            foreach (string root in musicRoots)
            {
                string? normalizedRoot = MusicFolderPaths.TryNormalize(root);
                if (normalizedRoot is null)
                {
                    continue;
                }

                if (MusicFolderPaths.EqualsPath(normalizedFile, normalizedRoot)
                    || MusicFolderPaths.IsStrictParent(normalizedRoot, normalizedFile))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
