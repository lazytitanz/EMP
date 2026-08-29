using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace EMP.Library
{
    internal static class MusicLibraryScanner
    {
        public const string LibraryHostName = "library.emp";
        public const string ArtworkHostName = "art.emp";

        private static readonly HashSet<string> AudioExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus", ".wma", ".aiff", ".alac"
        };

        private static readonly HashSet<string> IgnoredWatchExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tmp", ".temp", ".bak", ".crdownload", ".part"
        };

        private static readonly HashSet<string> IgnoredWatchNames = new(StringComparer.OrdinalIgnoreCase)
        {
            "Thumbs.db", "desktop.ini", ".DS_Store"
        };

        private static readonly Regex TrackNumberPrefix = new(
            @"^\s*(\d+)\s*[\.\-–)]\s*(.+)$",
            RegexOptions.Compiled);

        public static string DefaultMusicPath =>
            Environment.GetFolderPath(Environment.SpecialFolder.MyMusic);

        public static string ArtworkCachePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "Artwork");

        public static bool IsSupportedAudioPath(string? path)
        {
            return !string.IsNullOrWhiteSpace(path) && AudioExtensions.Contains(Path.GetExtension(path));
        }

        public static bool IsIgnoredWatchPath(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return false;
            }

            string name = Path.GetFileName(path);
            if (string.IsNullOrWhiteSpace(name))
            {
                return false;
            }

            if (IgnoredWatchNames.Contains(name)
                || name.StartsWith("~$", StringComparison.Ordinal)
                || name.EndsWith('~'))
            {
                return true;
            }

            return IgnoredWatchExtensions.Contains(Path.GetExtension(name));
        }

        public static string HostNameForRoot(string root)
        {
            string normalized = MusicFolderPaths.TryNormalize(root)
                ?? Path.TrimEndingDirectorySeparator(root.Trim());
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
            // Chromium rejects DNS labels longer than 63 characters. "lib" + 32 hex = 35.
            return "lib" + Convert.ToHexString(hash)[..32].ToLowerInvariant() + ".emp";
        }

        public static MusicLibrary Scan(string musicRoot, string artworkRoot)
        {
            return Scan([musicRoot], artworkRoot);
        }

        public static MusicLibrary Scan(IReadOnlyList<string> musicRoots, string artworkRoot)
        {
            ArgumentNullException.ThrowIfNull(musicRoots);
            ArgumentException.ThrowIfNullOrWhiteSpace(artworkRoot);

            Directory.CreateDirectory(artworkRoot);

            List<LibraryFolderInfo> folders = [];
            HashSet<string> seenFiles = new(StringComparer.OrdinalIgnoreCase);
            List<AudioFileInfo> files = [];

            foreach (string musicRoot in musicRoots)
            {
                string? normalized = MusicFolderPaths.TryNormalize(musicRoot) ?? musicRoot.Trim();
                if (string.IsNullOrWhiteSpace(normalized))
                {
                    continue;
                }

                bool available = Directory.Exists(normalized);
                folders.Add(new LibraryFolderInfo
                {
                    Path = normalized,
                    Available = available
                });

                if (!available)
                {
                    continue;
                }

                foreach (AudioFileInfo file in DiscoverAudioFiles(normalized))
                {
                    if (seenFiles.Add(file.FullPath))
                    {
                        files.Add(file);
                    }
                }
            }

            List<IGrouping<string, AudioFileInfo>> albumGroups = files
                .GroupBy(file => file.DirectoryPath, StringComparer.OrdinalIgnoreCase)
                .OrderBy(group => group.First().AlbumHint, StringComparer.OrdinalIgnoreCase)
                .ToList();

            List<AlbumInfo> albums = [];
            List<AlbumInfo> singles = [];
            List<TrackInfo> tracks = [];

            foreach (IGrouping<string, AudioFileInfo> group in albumGroups)
            {
                List<AudioFileInfo> albumFiles = group
                    .OrderBy(file => file.TrackNumber)
                    .ThenBy(file => file.Title, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                bool isSingle = albumFiles.Count == 1;
                string albumId = CreateId(group.Key);
                string artist = albumFiles
                    .Select(file => file.Artist)
                    .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
                    ?? "Unknown Artist";
                string title = albumFiles
                    .Select(file => file.Album)
                    .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
                    ?? albumFiles[0].AlbumHint;
                int? year = albumFiles.Select(file => file.Year).FirstOrDefault(value => value is > 0);
                string? coverUrl = ExtractArtwork(albumId, albumFiles, artworkRoot);

                AlbumInfo album = new()
                {
                    Id = albumId,
                    Title = title,
                    Artist = artist,
                    CoverUrl = coverUrl,
                    Color = AccentFor($"{artist}:{title}"),
                    TrackCount = albumFiles.Count,
                    Year = year,
                    IsSingle = isSingle,
                    TrackIds = albumFiles.Select(file => CreateId(file.FullPath)).ToArray()
                };

                if (isSingle)
                {
                    singles.Add(album);
                }
                else
                {
                    albums.Add(album);
                }

                foreach (AudioFileInfo file in albumFiles)
                {
                    tracks.Add(new TrackInfo
                    {
                        Id = CreateId(file.FullPath),
                        Title = file.Title,
                        Artist = string.IsNullOrWhiteSpace(file.Artist) ? artist : file.Artist,
                        Album = title,
                        AlbumId = albumId,
                        TrackNumber = file.TrackNumber,
                        Duration = file.DurationSeconds,
                        Url = ToVirtualUrl(HostNameForRoot(file.RootPath), file.RelativePath),
                        CoverUrl = coverUrl,
                        IsSingle = isSingle
                    });
                }
            }

            return new MusicLibrary
            {
                RootPath = folders.FirstOrDefault()?.Path ?? string.Empty,
                Folders = folders,
                Albums = albums
                    .OrderBy(album => album.Artist, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(album => album.Title, StringComparer.OrdinalIgnoreCase)
                    .ToArray(),
                Singles = singles
                    .OrderBy(album => album.Artist, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(album => album.Title, StringComparer.OrdinalIgnoreCase)
                    .ToArray(),
                Tracks = tracks
                    .OrderBy(track => track.Artist, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(track => track.Album, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(track => track.TrackNumber)
                    .ToArray()
            };
        }

        private static List<AudioFileInfo> DiscoverAudioFiles(string musicRoot)
        {
            List<AudioFileInfo> results = [];
            CollectAudioFiles(musicRoot, musicRoot, results);
            return results;
        }

        private static void CollectAudioFiles(string musicRoot, string directory, List<AudioFileInfo> results)
        {
            try
            {
                foreach (string path in Directory.EnumerateFiles(directory))
                {
                    if (IsSupportedAudioPath(path))
                    {
                        results.Add(ReadAudioFile(musicRoot, path));
                    }
                }

                foreach (string child in Directory.EnumerateDirectories(directory))
                {
                    CollectAudioFiles(musicRoot, child, results);
                }
            }
            catch (Exception)
            {
                // Skip folders that cannot be read and keep scanning the rest.
            }
        }

        private static AudioFileInfo ReadAudioFile(string musicRoot, string path)
        {
            string directory = Path.GetDirectoryName(path) ?? musicRoot;
            string albumHint = DirectoryEquals(directory, musicRoot)
                ? "Unknown Album"
                : Path.GetFileName(directory);
            string artistHint = GetArtistHint(musicRoot, directory);
            (int parsedNumber, string parsedTitle) = ParseFileName(Path.GetFileName(path));

            string title = parsedTitle;
            string artist = artistHint;
            string album = albumHint;
            int trackNumber = parsedNumber;
            double duration = 0;
            int year = 0;
            byte[]? pictureData = null;
            string? pictureMime = null;

            try
            {
                using TagLib.File file = TagLib.File.Create(path);
                if (!string.IsNullOrWhiteSpace(file.Tag.Title))
                {
                    title = file.Tag.Title.Trim();
                }

                string? taggedArtist = FirstNonEmpty(file.Tag.FirstPerformer, file.Tag.FirstAlbumArtist);
                if (!string.IsNullOrWhiteSpace(taggedArtist))
                {
                    artist = taggedArtist.Trim();
                }

                if (!string.IsNullOrWhiteSpace(file.Tag.Album))
                {
                    album = file.Tag.Album.Trim();
                }

                if (file.Tag.Track > 0)
                {
                    trackNumber = (int)file.Tag.Track;
                }

                if (file.Tag.Year > 0)
                {
                    year = (int)file.Tag.Year;
                }

                duration = file.Properties.Duration.TotalSeconds;
                TagLib.IPicture? picture = file.Tag.Pictures.FirstOrDefault(item => item.Data.Count > 0);
                if (picture is not null)
                {
                    pictureData = picture.Data.Data;
                    pictureMime = picture.MimeType;
                }
            }
            catch (Exception)
            {
                // Filename hints are enough when a tag cannot be read.
            }

            return new AudioFileInfo
            {
                FullPath = path,
                RootPath = musicRoot,
                DirectoryPath = directory,
                RelativePath = Path.GetRelativePath(musicRoot, path),
                Title = title,
                Artist = artist,
                Album = album,
                AlbumHint = albumHint,
                TrackNumber = trackNumber,
                DurationSeconds = duration,
                Year = year,
                PictureData = pictureData,
                PictureMime = pictureMime
            };
        }

        private static string GetArtistHint(string musicRoot, string albumDirectory)
        {
            if (DirectoryEquals(albumDirectory, musicRoot))
            {
                return "Unknown Artist";
            }

            string? parent = Directory.GetParent(albumDirectory)?.FullName;
            if (parent is null || DirectoryEquals(parent, musicRoot))
            {
                return Path.GetFileName(albumDirectory);
            }

            return Path.GetFileName(parent);
        }

        private static string? ExtractArtwork(string albumId, IReadOnlyList<AudioFileInfo> files, string artworkRoot)
        {
            AudioFileInfo? source = files.FirstOrDefault(file => file.PictureData is { Length: > 0 });
            if (source?.PictureData is null)
            {
                return null;
            }

            string extension = source.PictureMime?.Contains("png", StringComparison.OrdinalIgnoreCase) == true
                ? ".png"
                : ".jpg";
            string fileName = albumId + extension;
            string outputPath = Path.Combine(artworkRoot, fileName);

            try
            {
                File.WriteAllBytes(outputPath, source.PictureData);
                return "artwork/" + fileName;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static string ToVirtualUrl(string hostName, string relativePath)
        {
            string[] segments = relativePath
                .Replace('\\', '/')
                .Split('/', StringSplitOptions.RemoveEmptyEntries);

            return $"https://{hostName}/{string.Join('/', segments.Select(Uri.EscapeDataString))}";
        }

        private static (int Number, string Title) ParseFileName(string fileName)
        {
            string stem = Path.GetFileNameWithoutExtension(fileName);
            Match match = TrackNumberPrefix.Match(stem);
            if (match.Success && int.TryParse(match.Groups[1].Value, out int number))
            {
                return (number, match.Groups[2].Value.Trim());
            }

            return (0, stem);
        }

        private static string CreateId(string value)
        {
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
            return Convert.ToHexString(hash)[..12].ToLowerInvariant();
        }

        private static string AccentFor(string key)
        {
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(key));
            return $"#{hash[0]:x2}{hash[1]:x2}{hash[2]:x2}";
        }

        private static string? FirstNonEmpty(params string?[] values)
        {
            return values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
        }

        private static bool DirectoryEquals(string left, string right)
        {
            return string.Equals(
                Path.TrimEndingDirectorySeparator(left),
                Path.TrimEndingDirectorySeparator(right),
                StringComparison.OrdinalIgnoreCase);
        }

        private sealed class AudioFileInfo
        {
            public required string FullPath { get; init; }

            public required string RootPath { get; init; }

            public required string DirectoryPath { get; init; }

            public required string RelativePath { get; init; }

            public required string Title { get; init; }

            public required string Artist { get; init; }

            public required string Album { get; init; }

            public required string AlbumHint { get; init; }

            public required int TrackNumber { get; init; }

            public required double DurationSeconds { get; init; }

            public required int Year { get; init; }

            public byte[]? PictureData { get; init; }

            public string? PictureMime { get; init; }
        }
    }
}
