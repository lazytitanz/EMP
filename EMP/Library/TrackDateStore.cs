using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.Library
{
    /// <summary>
    /// Durable first-seen timestamps keyed by stable track id.
    /// Survives disposable library-cache invalidation, schema upgrades, and full rescans.
    /// Tracks already present when tracking starts share an upgrade-day baseline.
    /// </summary>
    internal static class TrackDateStore
    {
        public const int SchemaVersion = 1;

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
            "track-dates.json");

        internal static void SetFilePathForTests(string? path)
        {
            filePathOverride = path;
        }

        public static MusicLibrary ApplyAndPersist(MusicLibrary library, long? nowUnixMs = null)
        {
            ArgumentNullException.ThrowIfNull(library);

            long now = nowUnixMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Dictionary<string, long> store = Load();
            bool dirty = false;

            List<TrackInfo> tracks = new(library.Tracks.Count);
            foreach (TrackInfo track in library.Tracks)
            {
                if (string.IsNullOrWhiteSpace(track.Id))
                {
                    tracks.Add(track);
                    continue;
                }

                long dateAdded;
                if (store.TryGetValue(track.Id, out long existing) && existing > 0)
                {
                    dateAdded = existing;
                }
                else
                {
                    dateAdded = track.DateAdded > 0 ? track.DateAdded : now;
                    store[track.Id] = dateAdded;
                    dirty = true;
                }

                if (track.DateAdded == dateAdded)
                {
                    tracks.Add(track);
                    continue;
                }

                tracks.Add(CloneWithDateAdded(track, dateAdded));
            }

            if (dirty)
            {
                Save(store);
            }

            return new MusicLibrary
            {
                RootPath = library.RootPath,
                Folders = library.Folders,
                Albums = library.Albums,
                Singles = library.Singles,
                Tracks = tracks,
                Locations = library.Locations
            };
        }

        public static Dictionary<string, long> Load()
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    return new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
                }

                TrackDatesEnvelope? envelope = JsonSerializer.Deserialize<TrackDatesEnvelope>(
                    File.ReadAllText(FilePath),
                    JsonOptions);

                Dictionary<string, long> result = new(StringComparer.OrdinalIgnoreCase);
                if (envelope?.Tracks is null)
                {
                    return result;
                }

                foreach ((string trackId, TrackDateEntry? entry) in envelope.Tracks)
                {
                    if (string.IsNullOrWhiteSpace(trackId) || entry is null || entry.DateAdded <= 0)
                    {
                        continue;
                    }

                    result[trackId] = entry.DateAdded;
                }

                return result;
            }
            catch (Exception)
            {
                return new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            }
        }

        public static void Save(IReadOnlyDictionary<string, long> dates)
        {
            ArgumentNullException.ThrowIfNull(dates);

            string path = FilePath;
            string temp = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                string? directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                Dictionary<string, TrackDateEntry> tracks = new(StringComparer.OrdinalIgnoreCase);
                foreach ((string id, long dateAdded) in dates)
                {
                    if (string.IsNullOrWhiteSpace(id) || dateAdded <= 0)
                    {
                        continue;
                    }

                    tracks[id] = new TrackDateEntry { DateAdded = dateAdded };
                }

                TrackDatesEnvelope envelope = new()
                {
                    SchemaVersion = SchemaVersion,
                    Tracks = tracks
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

        private static TrackInfo CloneWithDateAdded(TrackInfo track, long dateAdded)
        {
            return new TrackInfo
            {
                Id = track.Id,
                Title = track.Title,
                Artist = track.Artist,
                Album = track.Album,
                AlbumId = track.AlbumId,
                TrackNumber = track.TrackNumber,
                Duration = track.Duration,
                Url = track.Url,
                CoverUrl = track.CoverUrl,
                IsSingle = track.IsSingle,
                Genre = track.Genre,
                AlbumArtist = track.AlbumArtist,
                Format = track.Format,
                Year = track.Year,
                DateAdded = dateAdded,
                ReplayGainTrackGain = track.ReplayGainTrackGain,
                ReplayGainTrackPeak = track.ReplayGainTrackPeak,
                ReplayGainAlbumGain = track.ReplayGainAlbumGain,
                ReplayGainAlbumPeak = track.ReplayGainAlbumPeak
            };
        }

        private sealed class TrackDatesEnvelope
        {
            public int SchemaVersion { get; init; }

            public Dictionary<string, TrackDateEntry>? Tracks { get; init; }
        }

        private sealed class TrackDateEntry
        {
            public long DateAdded { get; init; }
        }
    }
}
