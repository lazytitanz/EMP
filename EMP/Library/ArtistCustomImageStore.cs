using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using EMP.Library.Metadata;

namespace EMP.Library
{
    /// <summary>
    /// User-selected artist photographs, stored separately from album artwork and
    /// from online Commons downloads. Keys are normalized artist names (EMP identity).
    /// </summary>
    internal static class ArtistCustomImageStore
    {
        private const int SchemaVersion = 1;
        public const int MaxBytes = 8 * 1024 * 1024;
        public const int MaxLongestEdge = 3000;
        public const int MinShortestEdge = 200;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = true
        };

        private static readonly ConcurrentDictionary<string, CustomArtistImage> Memory = new(StringComparer.OrdinalIgnoreCase);
        private static string? indexPathOverride;
        private static string? rootOverride;
        private static bool loaded;

        public static string DefaultRoot => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "ArtistMetadata");

        public static string Root
        {
            get => rootOverride ?? DefaultRoot;
            internal set
            {
                rootOverride = value;
                loaded = false;
                Memory.Clear();
            }
        }

        public static string IndexPath
        {
            get => indexPathOverride ?? Path.Combine(Root, "custom-images.json");
            internal set
            {
                indexPathOverride = value;
                loaded = false;
                Memory.Clear();
            }
        }

        public static string ImagesRoot => Path.Combine(Root, "images");

        internal static void ConfigureForTests(string root)
        {
            Root = root;
            IndexPath = Path.Combine(root, "custom-images.json");
            ArtistImageCache.Root = Path.Combine(root, "images");
            loaded = false;
            Memory.Clear();
        }

        internal static void ResetTestState()
        {
            rootOverride = null;
            indexPathOverride = null;
            loaded = false;
            Memory.Clear();
        }

        public static bool TryGet(string artistName, out MusicBrainzClient.ArtistImageInfo image)
        {
            image = null!;
            EnsureLoaded();
            string key = NormalizeKey(artistName);
            if (!Memory.TryGetValue(key, out CustomArtistImage? entry) || entry is null)
            {
                return false;
            }

            if (!ArtistImageCache.TryResolveExistingFile(entry.FileName, out _))
            {
                Memory.TryRemove(key, out _);
                Persist();
                return false;
            }

            string version = Path.GetFileNameWithoutExtension(entry.FileName);
            if (version.Length > 16)
            {
                version = version[..16];
            }

            image = new MusicBrainzClient.ArtistImageInfo
            {
                Url = ArtistImageCache.BuildUrl(entry.FileName, version),
                FileName = entry.FileName,
                Attribution = "Custom photo",
                Author = null,
                Credit = "Added in EMP",
                License = "Custom",
                LicenseUrl = null,
                SourceUrl = null,
                Presentation = entry.Presentation,
                Width = entry.Width,
                Height = entry.Height,
                IsCustom = true
            };
            return true;
        }

        public static MusicBrainzClient.ArtistImageInfo? SetFromFile(string artistName, string sourcePath)
        {
            if (string.IsNullOrWhiteSpace(artistName) || string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath))
            {
                return null;
            }

            byte[] bytes;
            try
            {
                FileInfo info = new(sourcePath);
                if (info.Length <= 0 || info.Length > MaxBytes)
                {
                    return null;
                }

                bytes = File.ReadAllBytes(sourcePath);
            }
            catch (Exception)
            {
                return null;
            }

            if (!TryValidateCustomImage(bytes, Path.GetExtension(sourcePath), out string mime, out int width, out int height, out _))
            {
                return null;
            }

            // Store a copy under the artist-art cache; never modify the original file.
            ArtistCachedImage? stored = ArtistImageCache.StoreValidated(
                bytes,
                mime,
                width,
                height,
                enforceOnlineHeroMinimums: false);
            if (stored is null)
            {
                return null;
            }

            EnsureLoaded();
            string key = NormalizeKey(artistName);
            Memory[key] = new CustomArtistImage
            {
                FileName = stored.FileName,
                Presentation = stored.Presentation,
                Width = stored.Width,
                Height = stored.Height,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            Persist();

            return new MusicBrainzClient.ArtistImageInfo
            {
                Url = stored.Url,
                FileName = stored.FileName,
                Attribution = "Custom photo",
                Credit = "Added in EMP",
                License = "Custom",
                Presentation = stored.Presentation,
                Width = stored.Width,
                Height = stored.Height,
                IsCustom = true
            };
        }

        public static bool Clear(string artistName)
        {
            EnsureLoaded();
            string key = NormalizeKey(artistName);
            if (!Memory.TryRemove(key, out _))
            {
                return false;
            }

            Persist();
            return true;
        }

        public static bool TryValidateCustomImage(
            byte[] data,
            string? mimeHint,
            out string mime,
            out int width,
            out int height,
            out string? error)
        {
            mime = string.Empty;
            width = 0;
            height = 0;
            error = null;

            if (data.Length == 0 || data.Length > MaxBytes)
            {
                error = "Image missing or too large.";
                return false;
            }

            if (!ArtworkImageValidator.TryValidate(data, mimeHint, out mime, out error))
            {
                return false;
            }

            if (!ArtistImageCache.TryGetDimensions(data, mime, out width, out height))
            {
                error = "Unable to read image dimensions.";
                return false;
            }

            if (Math.Max(width, height) > MaxLongestEdge || Math.Min(width, height) < MinShortestEdge)
            {
                error = "Image dimensions are not suitable.";
                return false;
            }

            return true;
        }

        private static void EnsureLoaded()
        {
            if (loaded)
            {
                return;
            }

            lock (Memory)
            {
                if (loaded)
                {
                    return;
                }

                Memory.Clear();
                try
                {
                    if (File.Exists(IndexPath))
                    {
                        CustomIndex? index = JsonSerializer.Deserialize<CustomIndex>(File.ReadAllText(IndexPath), JsonOptions);
                        if (index?.SchemaVersion == SchemaVersion && index.Artists is not null)
                        {
                            foreach ((string key, CustomArtistImage value) in index.Artists)
                            {
                                if (!string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(value.FileName))
                                {
                                    Memory[key] = value;
                                }
                            }
                        }
                    }
                }
                catch (Exception)
                {
                    Memory.Clear();
                }

                loaded = true;
            }
        }

        private static void Persist()
        {
            try
            {
                Directory.CreateDirectory(Root);
                CustomIndex index = new()
                {
                    SchemaVersion = SchemaVersion,
                    Artists = Memory.ToDictionary(
                        static pair => pair.Key,
                        static pair => pair.Value,
                        StringComparer.OrdinalIgnoreCase)
                };
                string temp = IndexPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllText(temp, JsonSerializer.Serialize(index, JsonOptions));
                File.Move(temp, IndexPath, overwrite: true);
            }
            catch (Exception)
            {
                // Persistence is best-effort.
            }
        }

        private static string NormalizeKey(string name) => name.Trim().ToLowerInvariant();

        private sealed class CustomIndex
        {
            public int SchemaVersion { get; init; }

            public Dictionary<string, CustomArtistImage> Artists { get; init; } = new(StringComparer.OrdinalIgnoreCase);
        }

        private sealed class CustomArtistImage
        {
            public required string FileName { get; init; }

            public string Presentation { get; init; } = "portrait";

            public int Width { get; init; }

            public int Height { get; init; }

            public DateTimeOffset UpdatedAt { get; init; }
        }
    }
}
