using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.Library
{
    /// <summary>
    /// Durable first-seen timestamps keyed by stable track id.
    /// Survives disposable library-cache invalidation, schema upgrades, and full rescans.
    /// Tracks already present when tracking starts share a baseline timestamp; schema v2 records
    /// that baseline explicitly (<c>baselineAt</c>) so the UI never presents it as a real import date.
    /// </summary>
    /// <remarks>
    /// Compatibility: v1 readers deserialize with default System.Text.Json options (unknown
    /// properties ignored, no schema check), so a v2 file stays readable by older builds. If an
    /// older build rewrites the file, <c>baselineAt</c> is dropped and re-derived here from the
    /// earliest stored timestamp, which is stable because entries are never removed.
    /// </remarks>
    internal static class TrackDateStore
    {
        public const int SchemaVersion = 2;

        private static readonly object Gate = new();

        private static string? filePathOverride;
        private static long currentBaselineAt;

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

        /// <summary>One-time copy of a pre-v2 file, written before the first v2 save.</summary>
        public static string LegacyBackupPath => FilePath + ".v1.bak";

        /// <summary>
        /// Unix ms of the initial library baseline, or 0 when unknown (no tracks tracked yet).
        /// Tracks whose DateAdded is at or before this value were already present when tracking began.
        /// </summary>
        public static long CurrentBaselineAt
        {
            get
            {
                lock (Gate)
                {
                    return currentBaselineAt;
                }
            }
        }

        internal static void SetFilePathForTests(string? path)
        {
            lock (Gate)
            {
                filePathOverride = path;
                currentBaselineAt = 0;
            }
        }

        public static MusicLibrary ApplyAndPersist(MusicLibrary library, long? nowUnixMs = null)
        {
            ArgumentNullException.ThrowIfNull(library);

            lock (Gate)
            {
                long now = nowUnixMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                StoreState state = LoadState();
                Dictionary<string, long> store = state.Dates;
                bool hadEntries = store.Count > 0;
                bool dirty = state.SchemaVersion < SchemaVersion && hadEntries;

                long baselineAt = state.BaselineAt;
                if (baselineAt <= 0 && hadEntries)
                {
                    // Upgrade from v1 (or a file rewritten by an older build): every track present
                    // when tracking began received the same first-run timestamp, the earliest value.
                    baselineAt = store.Values.Where(static value => value > 0).DefaultIfEmpty(0).Min();
                    dirty = baselineAt > 0;
                }

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

                if (baselineAt <= 0 && store.Count > 0)
                {
                    // First library ever tracked (fresh install): the initial scan is the baseline.
                    baselineAt = store.Values.Where(static value => value > 0).DefaultIfEmpty(0).Min();
                    dirty = true;
                }

                if (dirty)
                {
                    if (state.SchemaVersion < SchemaVersion && hadEntries)
                    {
                        TryWriteLegacyBackup();
                    }

                    Save(store, baselineAt);
                }

                currentBaselineAt = Math.Max(0, baselineAt);

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
        }

        public static Dictionary<string, long> Load()
        {
            return LoadState().Dates;
        }

        /// <summary>Stored baseline, or 0 when the file predates v2 / is missing.</summary>
        public static long LoadBaselineAt()
        {
            return LoadState().BaselineAt;
        }

        internal static int LoadSchemaVersion()
        {
            return LoadState().SchemaVersion;
        }

        /// <summary>Writes the dates without a recorded baseline (it is re-derived on next apply).</summary>
        public static void Save(IReadOnlyDictionary<string, long> dates)
        {
            Save(dates, baselineAt: 0);
        }

        public static void Save(IReadOnlyDictionary<string, long> dates, long baselineAt)
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
                    BaselineAt = baselineAt > 0 ? baselineAt : null,
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

        private static StoreState LoadState()
        {
            Dictionary<string, long> result = new(StringComparer.OrdinalIgnoreCase);
            try
            {
                if (!File.Exists(FilePath))
                {
                    return new StoreState(result, 0, SchemaVersion);
                }

                TrackDatesEnvelope? envelope = JsonSerializer.Deserialize<TrackDatesEnvelope>(
                    File.ReadAllText(FilePath),
                    JsonOptions);
                if (envelope?.Tracks is null)
                {
                    return new StoreState(result, 0, envelope?.SchemaVersion ?? 1);
                }

                foreach ((string trackId, TrackDateEntry? entry) in envelope.Tracks)
                {
                    if (string.IsNullOrWhiteSpace(trackId) || entry is null || entry.DateAdded <= 0)
                    {
                        continue;
                    }

                    result[trackId] = entry.DateAdded;
                }

                long baseline = envelope.BaselineAt is > 0 ? envelope.BaselineAt.Value : 0;
                return new StoreState(result, baseline, envelope.SchemaVersion);
            }
            catch (Exception)
            {
                return new StoreState(new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase), 0, SchemaVersion);
            }
        }

        private static void TryWriteLegacyBackup()
        {
            try
            {
                if (File.Exists(FilePath) && !File.Exists(LegacyBackupPath))
                {
                    File.Copy(FilePath, LegacyBackupPath, overwrite: false);
                }
            }
            catch (Exception)
            {
                // Backup is best-effort; the migration itself never removes entries.
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

        private sealed record StoreState(Dictionary<string, long> Dates, long BaselineAt, int SchemaVersion);

        private sealed class TrackDatesEnvelope
        {
            public int SchemaVersion { get; init; }

            public long? BaselineAt { get; init; }

            public Dictionary<string, TrackDateEntry>? Tracks { get; init; }
        }

        private sealed class TrackDateEntry
        {
            public long DateAdded { get; init; }
        }
    }
}
