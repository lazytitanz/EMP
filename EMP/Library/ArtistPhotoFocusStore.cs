using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.Library
{
    /// <summary>
    /// Manual hero framing for artist photos: a normalized focal point (0–1 on each axis) per artist,
    /// bound to the exact photo it was set on. Stored in ArtistMetadata/photo-focus.json beside
    /// custom-images.json. Never writes image files; originals are untouched.
    /// <para>
    /// Image identity is the artist-art cache file name, which is derived from a SHA-256 of the
    /// image bytes (<see cref="ArtistImageCache.StoreValidated"/>), so a different photograph always
    /// has a different key and a stale focus point is ignored and pruned.
    /// </para>
    /// </summary>
    internal static class ArtistPhotoFocusStore
    {
        private const int SchemaVersion = 1;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = true
        };

        private static readonly ConcurrentDictionary<string, PhotoFocus> Memory = new(StringComparer.OrdinalIgnoreCase);
        private static string? pathOverride;
        private static bool loaded;

        public static string IndexPath
        {
            get => pathOverride ?? Path.Combine(ArtistCustomImageStore.Root, "photo-focus.json");
            internal set
            {
                pathOverride = value;
                loaded = false;
                Memory.Clear();
            }
        }

        internal static void ResetTestState()
        {
            pathOverride = null;
            loaded = false;
            Memory.Clear();
        }

        /// <summary>Accepts only finite values within [0, 1].</summary>
        public static bool IsValidCoordinate(double value) => double.IsFinite(value) && value >= 0 && value <= 1;

        /// <summary>
        /// The manual focal point for this artist's current photo, or null (automatic framing).
        /// A focus saved for a different photo is treated as obsolete and removed.
        /// </summary>
        public static (double X, double Y)? TryGet(string artistName, string? imageKey)
        {
            if (string.IsNullOrWhiteSpace(artistName) || string.IsNullOrWhiteSpace(imageKey))
            {
                return null;
            }

            EnsureLoaded();
            string key = NormalizeKey(artistName);
            if (!Memory.TryGetValue(key, out PhotoFocus? focus) || focus is null)
            {
                return null;
            }

            if (!string.Equals(focus.ImageKey, imageKey, StringComparison.OrdinalIgnoreCase))
            {
                // The photograph changed; the old crop no longer describes anything.
                if (Memory.TryRemove(key, out _))
                {
                    Persist();
                }

                return null;
            }

            return (focus.X, focus.Y);
        }

        public static bool Set(string artistName, string? imageKey, double x, double y)
        {
            if (string.IsNullOrWhiteSpace(artistName)
                || !ArtistImageCache.IsSafeFileName(imageKey)
                || !IsValidCoordinate(x)
                || !IsValidCoordinate(y))
            {
                return false;
            }

            EnsureLoaded();
            Memory[NormalizeKey(artistName)] = new PhotoFocus
            {
                ImageKey = imageKey!,
                X = Math.Round(x, 4),
                Y = Math.Round(y, 4),
                UpdatedAt = DateTimeOffset.UtcNow
            };
            Persist();
            return true;
        }

        /// <summary>"Reset to default": forget the manual focus so automatic framing applies again.</summary>
        public static bool Clear(string artistName)
        {
            if (string.IsNullOrWhiteSpace(artistName))
            {
                return false;
            }

            EnsureLoaded();
            if (!Memory.TryRemove(NormalizeKey(artistName), out _))
            {
                return false;
            }

            Persist();
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
                        FocusIndex? index = JsonSerializer.Deserialize<FocusIndex>(File.ReadAllText(IndexPath), JsonOptions);
                        if (index?.SchemaVersion == SchemaVersion && index.Artists is not null)
                        {
                            foreach ((string key, PhotoFocus value) in index.Artists)
                            {
                                if (!string.IsNullOrWhiteSpace(key)
                                    && value is not null
                                    && ArtistImageCache.IsSafeFileName(value.ImageKey)
                                    && IsValidCoordinate(value.X)
                                    && IsValidCoordinate(value.Y))
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
                string? directory = Path.GetDirectoryName(IndexPath);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                FocusIndex index = new()
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
                // Persistence is best-effort, like the custom image index.
            }
        }

        private static string NormalizeKey(string name) => name.Trim().ToLowerInvariant();

        private sealed class FocusIndex
        {
            public int SchemaVersion { get; init; }

            public Dictionary<string, PhotoFocus> Artists { get; init; } = new(StringComparer.OrdinalIgnoreCase);
        }

        private sealed class PhotoFocus
        {
            public required string ImageKey { get; init; }

            public double X { get; init; }

            public double Y { get; init; }

            public DateTimeOffset UpdatedAt { get; init; }
        }
    }
}
