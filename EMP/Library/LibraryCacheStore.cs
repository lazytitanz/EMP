using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.Library
{
    internal sealed class LibraryCacheEnvelope
    {
        public int SchemaVersion { get; init; }

        public IReadOnlyList<string> FolderPaths { get; init; } = [];

        public string ContentFingerprint { get; init; } = string.Empty;

        public string RootPath { get; init; } = string.Empty;

        public IReadOnlyList<LibraryFolderInfo> Folders { get; init; } = [];

        public IReadOnlyList<AlbumInfo> Albums { get; init; } = [];

        public IReadOnlyList<AlbumInfo> Singles { get; init; } = [];

        public IReadOnlyList<TrackInfo> Tracks { get; init; } = [];

        public IReadOnlyList<LibraryMediaLocation> Locations { get; init; } = [];
    }

    internal sealed class CachedMusicLibrary
    {
        public required string ContentFingerprint { get; init; }

        public required IReadOnlyList<string> FolderPaths { get; init; }

        public required MusicLibrary Library { get; init; }
    }

    internal static class LibraryCacheStore
    {
        public const int SchemaVersion = 3;

        private static string? filePathOverride;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

        public static string FilePath => filePathOverride ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "library-cache.json");

        internal static void SetFilePathForTests(string? path)
        {
            filePathOverride = path;
        }

        public static CachedMusicLibrary? TryLoad(IReadOnlyList<string> configuredFolders)
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    return null;
                }

                LibraryCacheEnvelope? envelope = JsonSerializer.Deserialize<LibraryCacheEnvelope>(
                    File.ReadAllText(FilePath),
                    JsonOptions);

                if (envelope is null
                    || envelope.SchemaVersion != SchemaVersion
                    || string.IsNullOrWhiteSpace(envelope.ContentFingerprint)
                    || !FolderPathsMatch(envelope.FolderPaths, configuredFolders))
                {
                    return null;
                }

                Dictionary<string, LibraryMediaLocation> locations = new(StringComparer.OrdinalIgnoreCase);
                foreach (LibraryMediaLocation location in envelope.Locations ?? [])
                {
                    if (!string.IsNullOrWhiteSpace(location.TrackId))
                    {
                        locations[location.TrackId] = location;
                    }
                }

                MusicLibrary library = new()
                {
                    RootPath = envelope.RootPath ?? string.Empty,
                    Folders = envelope.Folders ?? [],
                    Albums = envelope.Albums ?? [],
                    Singles = envelope.Singles ?? [],
                    Tracks = envelope.Tracks ?? [],
                    Locations = locations
                };

                return new CachedMusicLibrary
                {
                    ContentFingerprint = envelope.ContentFingerprint,
                    FolderPaths = NormalizeFolderList(configuredFolders),
                    Library = library
                };
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static void Save(IReadOnlyList<string> configuredFolders, MusicLibrary library, string contentFingerprint)
        {
            ArgumentNullException.ThrowIfNull(configuredFolders);
            ArgumentNullException.ThrowIfNull(library);
            ArgumentException.ThrowIfNullOrWhiteSpace(contentFingerprint);

            string path = FilePath;
            string temp = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                string? directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                LibraryCacheEnvelope envelope = new()
                {
                    SchemaVersion = SchemaVersion,
                    FolderPaths = NormalizeFolderList(configuredFolders),
                    ContentFingerprint = contentFingerprint,
                    RootPath = library.RootPath,
                    Folders = library.Folders,
                    Albums = library.Albums,
                    Singles = library.Singles,
                    Tracks = library.Tracks,
                    Locations = library.Locations.Values.ToArray()
                };

                File.WriteAllText(temp, JsonSerializer.Serialize(envelope, JsonOptions));
                File.Move(temp, path, overwrite: true);
            }
            catch (Exception)
            {
                try
                {
                    File.Delete(temp);
                }
                catch (Exception)
                {
                    // Best-effort cleanup.
                }
            }
        }

        public static string ComputeFingerprint(MusicLibrary library)
        {
            ArgumentNullException.ThrowIfNull(library);

            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            Append(hash, "v1");

            foreach (LibraryFolderInfo folder in library.Folders
                .OrderBy(item => item.Path, StringComparer.OrdinalIgnoreCase))
            {
                Append(hash, folder.Path);
                Append(hash, folder.Available ? "1" : "0");
            }

            foreach (AlbumInfo album in library.Albums
                .Concat(library.Singles)
                .OrderBy(item => item.Id, StringComparer.OrdinalIgnoreCase))
            {
                Append(hash, album.Id);
                Append(hash, album.Title);
                Append(hash, album.Artist);
                Append(hash, album.CoverUrl ?? "");
                Append(hash, album.Color);
                Append(hash, album.TrackCount.ToString());
                Append(hash, album.Year?.ToString() ?? "");
                Append(hash, album.IsSingle ? "1" : "0");
                Append(hash, string.Join('\u001f', album.TrackIds));
            }

            foreach (TrackInfo track in library.Tracks
                .OrderBy(item => item.Id, StringComparer.OrdinalIgnoreCase))
            {
                Append(hash, track.Id);
                Append(hash, track.Title);
                Append(hash, track.Artist);
                Append(hash, track.Album);
                Append(hash, track.AlbumId);
                Append(hash, track.TrackNumber.ToString());
                Append(hash, track.Duration.ToString("G17"));
                Append(hash, track.Url);
                Append(hash, track.CoverUrl ?? "");
                Append(hash, track.IsSingle ? "1" : "0");
                Append(hash, track.Genre ?? "");
                Append(hash, track.AlbumArtist ?? "");
                Append(hash, track.Format ?? "");
                Append(hash, track.Year?.ToString() ?? "");
                // DateAdded lives in TrackDateStore and is excluded to avoid cache thrash.
                Append(hash, track.ReplayGainTrackGain?.ToString("G17") ?? "");
                Append(hash, track.ReplayGainTrackPeak?.ToString("G17") ?? "");
                Append(hash, track.ReplayGainAlbumGain?.ToString("G17") ?? "");
                Append(hash, track.ReplayGainAlbumPeak?.ToString("G17") ?? "");
            }

            foreach (LibraryMediaLocation location in library.Locations.Values
                .OrderBy(item => item.TrackId, StringComparer.OrdinalIgnoreCase))
            {
                Append(hash, location.TrackId);
                Append(hash, location.FullPath);
                Append(hash, location.RootPath);
                Append(hash, location.Title);
                Append(hash, location.Artist);
                Append(hash, location.Album);
                Append(hash, location.Duration.ToString("G17"));
                Append(hash, location.ArtworkPath ?? "");
            }

            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }

        public static bool IsCompleteScan(MusicLibrary library)
        {
            return library.Folders.All(folder => folder.Available);
        }

        /// <summary>
        /// True when the scan left configured folders unavailable that a prior complete
        /// cache still describes, so the on-disk cache must not be overwritten.
        /// </summary>
        public static bool ShouldPreserveDiskCache(MusicLibrary scanned, CachedMusicLibrary? previousComplete)
        {
            if (IsCompleteScan(scanned))
            {
                return false;
            }

            if (previousComplete is null)
            {
                return false;
            }

            foreach (LibraryFolderInfo folder in scanned.Folders)
            {
                if (folder.Available)
                {
                    continue;
                }

                bool previouslyAvailable = previousComplete.Library.Folders
                    .Any(item => MusicFolderPaths.EqualsPath(item.Path, folder.Path) && item.Available);

                bool hadContent = previousComplete.Library.Locations.Values
                    .Any(location => MusicFolderPaths.EqualsPath(location.RootPath, folder.Path));

                if (previouslyAvailable || hadContent)
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Restore cached metadata for configured folders that are temporarily unavailable.
        /// Folders no longer in settings are not restored.
        /// </summary>
        public static MusicLibrary MergeUnavailableFromCache(
            MusicLibrary scanned,
            IReadOnlyList<string> configuredFolders,
            CachedMusicLibrary? previous)
        {
            if (previous is null)
            {
                return scanned;
            }

            HashSet<string> configured = new(
                NormalizeFolderList(configuredFolders),
                StringComparer.OrdinalIgnoreCase);

            HashSet<string> unavailableRoots = new(
                scanned.Folders
                    .Where(folder => !folder.Available && configured.Contains(folder.Path))
                    .Select(folder => folder.Path),
                StringComparer.OrdinalIgnoreCase);

            if (unavailableRoots.Count == 0)
            {
                return scanned;
            }

            bool IsUnavailableRoot(string rootPath) =>
                unavailableRoots.Any(folder => MusicFolderPaths.EqualsPath(folder, rootPath));

            Dictionary<string, LibraryMediaLocation> locations = new(
                scanned.Locations,
                StringComparer.OrdinalIgnoreCase);

            foreach (LibraryMediaLocation location in previous.Library.Locations.Values)
            {
                if (IsUnavailableRoot(location.RootPath))
                {
                    locations[location.TrackId] = location;
                }
            }

            Dictionary<string, TrackInfo> tracks = new(StringComparer.OrdinalIgnoreCase);
            foreach (TrackInfo track in scanned.Tracks)
            {
                tracks[track.Id] = track;
            }

            foreach (TrackInfo track in previous.Library.Tracks)
            {
                if (previous.Library.Locations.TryGetValue(track.Id, out LibraryMediaLocation? location)
                    && IsUnavailableRoot(location.RootPath))
                {
                    tracks[track.Id] = track;
                }
            }

            Dictionary<string, AlbumInfo> albums = new(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, AlbumInfo> singles = new(StringComparer.OrdinalIgnoreCase);

            void ConsiderAlbum(AlbumInfo album, bool fromCache)
            {
                bool keep = album.TrackIds.Any(tracks.ContainsKey);
                if (!keep)
                {
                    return;
                }

                if (fromCache)
                {
                    bool fromUnavailable = album.TrackIds.Any(id =>
                        previous.Library.Locations.TryGetValue(id, out LibraryMediaLocation? location)
                        && IsUnavailableRoot(location.RootPath));
                    if (!fromUnavailable)
                    {
                        return;
                    }
                }

                if (album.IsSingle)
                {
                    singles[album.Id] = album;
                }
                else
                {
                    albums[album.Id] = album;
                }
            }

            foreach (AlbumInfo album in scanned.Albums)
            {
                ConsiderAlbum(album, fromCache: false);
            }

            foreach (AlbumInfo album in scanned.Singles)
            {
                ConsiderAlbum(album, fromCache: false);
            }

            foreach (AlbumInfo album in previous.Library.Albums.Concat(previous.Library.Singles))
            {
                ConsiderAlbum(album, fromCache: true);
            }

            return new MusicLibrary
            {
                RootPath = scanned.RootPath,
                Folders = scanned.Folders,
                Albums = albums.Values
                    .OrderBy(album => album.Artist, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(album => album.Title, StringComparer.OrdinalIgnoreCase)
                    .ToArray(),
                Singles = singles.Values
                    .OrderBy(album => album.Artist, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(album => album.Title, StringComparer.OrdinalIgnoreCase)
                    .ToArray(),
                Tracks = tracks.Values
                    .OrderBy(track => track.Artist, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(track => track.Album, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(track => track.TrackNumber)
                    .ThenBy(track => track.Title, StringComparer.OrdinalIgnoreCase)
                    .ToArray(),
                Locations = locations
            };
        }

        public static bool FolderPathsMatch(IReadOnlyList<string>? cached, IReadOnlyList<string> configured)
        {
            HashSet<string> left = new(NormalizeFolderList(cached ?? []), StringComparer.OrdinalIgnoreCase);
            HashSet<string> right = new(NormalizeFolderList(configured), StringComparer.OrdinalIgnoreCase);
            return left.SetEquals(right);
        }

        private static List<string> NormalizeFolderList(IReadOnlyList<string> folders)
        {
            return MusicFolderPaths.NormalizeConfigured(folders)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static void Append(IncrementalHash hash, string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            hash.AppendData(bytes);
            hash.AppendData([(byte)0]);
        }
    }
}
