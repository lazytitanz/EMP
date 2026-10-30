using System.Text.Json;
using System.Text.Json.Serialization;
using EMP.Library;

namespace EMP.Hosting
{
    internal sealed class DayTrackListenStats
    {
        public long PlayCount { get; set; }

        public long ListenMs { get; set; }
    }

    internal sealed class TrackListenIdentity
    {
        public string Title { get; set; } = string.Empty;

        public string Artist { get; set; } = string.Empty;

        public string Album { get; set; } = string.Empty;

        public double DurationSec { get; set; }
    }

    internal sealed class ListenHistoryEnvelope
    {
        public int SchemaVersion { get; set; }

        public long LastJournalSeq { get; set; }

        public string? TrackingStartedOn { get; set; }

        public Dictionary<string, TrackListenIdentity> Identities { get; set; } =
            new(StringComparer.OrdinalIgnoreCase);

        public Dictionary<string, Dictionary<string, DayTrackListenStats>> Days { get; set; } =
            new(StringComparer.Ordinal);
    }

    /// <summary>
    /// Durable daily listening aggregates under %LocalAppData%\EMP\listen-history.json.
    /// </summary>
    internal static class ListenHistoryStore
    {
        public const int SchemaVersion = 1;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

        private static readonly object Gate = new();
        private static readonly Dictionary<string, Dictionary<string, DayTrackListenStats>> Days =
            new(StringComparer.Ordinal);
        private static readonly Dictionary<string, TrackListenIdentity> Identities =
            new(StringComparer.OrdinalIgnoreCase);

        private static long lastJournalSeq;
        private static string? trackingStartedOn;
        private static bool loaded;

        public static string FilePath => ListenStatsPaths.ListenHistoryFile;

        public static long LastJournalSeq
        {
            get
            {
                lock (Gate)
                {
                    return lastJournalSeq;
                }
            }
        }

        public static string? TrackingStartedOn
        {
            get
            {
                lock (Gate)
                {
                    return trackingStartedOn;
                }
            }
        }

        public static void ResetForTests()
        {
            lock (Gate)
            {
                Days.Clear();
                Identities.Clear();
                lastJournalSeq = 0;
                trackingStartedOn = null;
                loaded = false;
            }
        }

        public static void Load()
        {
            lock (Gate)
            {
                Load_NoLock();
            }
        }

        public static void ApplyEntry(
            string trackId,
            long playCountDelta,
            long lastPlayedAt,
            IReadOnlyDictionary<string, long>? dayListenMsDelta)
        {
            if (string.IsNullOrWhiteSpace(trackId))
            {
                return;
            }

            lock (Gate)
            {
                EnsureLoaded_NoLock();

                if (dayListenMsDelta is not null)
                {
                    foreach (KeyValuePair<string, long> pair in dayListenMsDelta)
                    {
                        if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value <= 0)
                        {
                            continue;
                        }

                        DayTrackListenStats dayStats = GetOrCreateDayTrack_NoLock(pair.Key, trackId);
                        dayStats.ListenMs += pair.Value;
                    }
                }

                if (playCountDelta > 0)
                {
                    string playDate = lastPlayedAt > 0
                        ? ListenLocalDates.FromUnixMilliseconds(lastPlayedAt)
                        : ListenLocalDates.FromDateTime(DateTime.Now);
                    DayTrackListenStats dayStats = GetOrCreateDayTrack_NoLock(playDate, trackId);
                    dayStats.PlayCount += playCountDelta;
                }

                TryCaptureIdentity_NoLock(trackId);
            }
        }

        public static void SetLastJournalSeq(long seq)
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                if (seq > lastJournalSeq)
                {
                    lastJournalSeq = seq;
                }
            }
        }

        public static void EnsureTrackingStartedOn()
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                trackingStartedOn ??= ListenLocalDates.FromDateTime(DateTime.Now);
            }
        }

        public static ListenHistoryEnvelope CaptureEnvelope()
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                return CloneEnvelope_NoLock();
            }
        }

        public static bool TryWriteEnvelope(ListenHistoryEnvelope envelope)
        {
            string path = FilePath;
            string temp = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                string? directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                envelope.SchemaVersion = SchemaVersion;
                File.WriteAllText(temp, JsonSerializer.Serialize(envelope, JsonOptions));
                File.Move(temp, path, overwrite: true);
                return true;
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

                return false;
            }
        }

        public static void ReplaceFromEnvelope(ListenHistoryEnvelope envelope)
        {
            lock (Gate)
            {
                Days.Clear();
                Identities.Clear();
                lastJournalSeq = Math.Max(0, envelope.LastJournalSeq);
                trackingStartedOn = string.IsNullOrWhiteSpace(envelope.TrackingStartedOn)
                    ? null
                    : envelope.TrackingStartedOn;
                loaded = true;

                foreach (KeyValuePair<string, Dictionary<string, DayTrackListenStats>> day in envelope.Days ?? [])
                {
                    if (string.IsNullOrWhiteSpace(day.Key) || day.Value is null)
                    {
                        continue;
                    }

                    Dictionary<string, DayTrackListenStats> tracks = new(StringComparer.OrdinalIgnoreCase);
                    foreach (KeyValuePair<string, DayTrackListenStats> track in day.Value)
                    {
                        if (string.IsNullOrWhiteSpace(track.Key) || track.Value is null)
                        {
                            continue;
                        }

                        tracks[track.Key] = new DayTrackListenStats
                        {
                            PlayCount = Math.Max(0, track.Value.PlayCount),
                            ListenMs = Math.Max(0, track.Value.ListenMs)
                        };
                    }

                    if (tracks.Count > 0)
                    {
                        Days[day.Key] = tracks;
                    }
                }

                foreach (KeyValuePair<string, TrackListenIdentity> identity in envelope.Identities ?? [])
                {
                    if (string.IsNullOrWhiteSpace(identity.Key) || identity.Value is null)
                    {
                        continue;
                    }

                    Identities[identity.Key] = CloneIdentity(identity.Value);
                }
            }
        }

        public static IReadOnlyDictionary<string, DayTrackListenStats> GetDay(string yyyyMmDd)
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                if (!Days.TryGetValue(yyyyMmDd, out Dictionary<string, DayTrackListenStats>? tracks))
                {
                    return new Dictionary<string, DayTrackListenStats>(StringComparer.OrdinalIgnoreCase);
                }

                return tracks.ToDictionary(
                    pair => pair.Key,
                    pair => new DayTrackListenStats
                    {
                        PlayCount = pair.Value.PlayCount,
                        ListenMs = pair.Value.ListenMs
                    },
                    StringComparer.OrdinalIgnoreCase);
            }
        }

        public static Dictionary<string, DayTrackListenStats> GetRange(string startDate, string endDate)
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                Dictionary<string, DayTrackListenStats> merged = new(StringComparer.OrdinalIgnoreCase);
                foreach (KeyValuePair<string, Dictionary<string, DayTrackListenStats>> day in Days)
                {
                    if (string.CompareOrdinal(day.Key, startDate) < 0
                        || string.CompareOrdinal(day.Key, endDate) > 0)
                    {
                        continue;
                    }

                    foreach (KeyValuePair<string, DayTrackListenStats> track in day.Value)
                    {
                        if (!merged.TryGetValue(track.Key, out DayTrackListenStats? stats))
                        {
                            stats = new DayTrackListenStats();
                            merged[track.Key] = stats;
                        }

                        stats.PlayCount += track.Value.PlayCount;
                        stats.ListenMs += track.Value.ListenMs;
                    }
                }

                return merged;
            }
        }

        public static Dictionary<string, DayTrackListenStats> GetMonth(int year, int month)
        {
            string start = $"{year:D4}-{month:D2}-01";
            int lastDay = DateTime.DaysInMonth(year, month);
            string end = $"{year:D4}-{month:D2}-{lastDay:D2}";
            return GetRange(start, end);
        }

        public static Dictionary<string, DayTrackListenStats> GetYear(int year)
        {
            return GetRange($"{year:D4}-01-01", $"{year:D4}-12-31");
        }

        public static long TotalListenMs(IReadOnlyDictionary<string, DayTrackListenStats> stats)
        {
            long total = 0;
            foreach (DayTrackListenStats value in stats.Values)
            {
                total += Math.Max(0, value.ListenMs);
            }

            return total;
        }

        public static int DistinctTrackCount(IReadOnlyDictionary<string, DayTrackListenStats> stats)
        {
            int count = 0;
            foreach (DayTrackListenStats value in stats.Values)
            {
                if (value.PlayCount > 0 || value.ListenMs > 0)
                {
                    count++;
                }
            }

            return count;
        }

        public static IReadOnlyDictionary<string, TrackListenIdentity> SnapshotIdentities()
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                return Identities.ToDictionary(
                    pair => pair.Key,
                    pair => CloneIdentity(pair.Value),
                    StringComparer.OrdinalIgnoreCase);
            }
        }

        private static void Load_NoLock()
        {
            Days.Clear();
            Identities.Clear();
            lastJournalSeq = 0;
            trackingStartedOn = null;
            loaded = true;

            try
            {
                if (!File.Exists(FilePath))
                {
                    return;
                }

                ListenHistoryEnvelope? envelope = JsonSerializer.Deserialize<ListenHistoryEnvelope>(
                    File.ReadAllText(FilePath),
                    JsonOptions);

                if (envelope is null || envelope.SchemaVersion != SchemaVersion)
                {
                    QuarantineExisting_NoLock(envelope is null ? "null" : "schema");
                    return;
                }

                ReplaceFromEnvelope_NoLock(envelope);
            }
            catch (Exception)
            {
                Days.Clear();
                Identities.Clear();
                lastJournalSeq = 0;
                trackingStartedOn = null;
                QuarantineExisting_NoLock("invalid");
            }
        }

        private static void EnsureLoaded_NoLock()
        {
            if (!loaded)
            {
                Load_NoLock();
            }
        }

        private static void ReplaceFromEnvelope_NoLock(ListenHistoryEnvelope envelope)
        {
            Days.Clear();
            Identities.Clear();
            lastJournalSeq = Math.Max(0, envelope.LastJournalSeq);
            trackingStartedOn = string.IsNullOrWhiteSpace(envelope.TrackingStartedOn)
                ? null
                : envelope.TrackingStartedOn;

            foreach (KeyValuePair<string, Dictionary<string, DayTrackListenStats>> day in envelope.Days ?? [])
            {
                if (string.IsNullOrWhiteSpace(day.Key) || day.Value is null)
                {
                    continue;
                }

                Dictionary<string, DayTrackListenStats> tracks = new(StringComparer.OrdinalIgnoreCase);
                foreach (KeyValuePair<string, DayTrackListenStats> track in day.Value)
                {
                    if (string.IsNullOrWhiteSpace(track.Key) || track.Value is null)
                    {
                        continue;
                    }

                    tracks[track.Key] = new DayTrackListenStats
                    {
                        PlayCount = Math.Max(0, track.Value.PlayCount),
                        ListenMs = Math.Max(0, track.Value.ListenMs)
                    };
                }

                if (tracks.Count > 0)
                {
                    Days[day.Key] = tracks;
                }
            }

            foreach (KeyValuePair<string, TrackListenIdentity> identity in envelope.Identities ?? [])
            {
                if (string.IsNullOrWhiteSpace(identity.Key) || identity.Value is null)
                {
                    continue;
                }

                Identities[identity.Key] = CloneIdentity(identity.Value);
            }
        }

        private static DayTrackListenStats GetOrCreateDayTrack_NoLock(string dayKey, string trackId)
        {
            if (!Days.TryGetValue(dayKey, out Dictionary<string, DayTrackListenStats>? tracks))
            {
                tracks = new Dictionary<string, DayTrackListenStats>(StringComparer.OrdinalIgnoreCase);
                Days[dayKey] = tracks;
            }

            if (!tracks.TryGetValue(trackId, out DayTrackListenStats? stats))
            {
                stats = new DayTrackListenStats();
                tracks[trackId] = stats;
            }

            return stats;
        }

        private static void TryCaptureIdentity_NoLock(string trackId)
        {
            if (!LibraryMediaIndex.TryGet(trackId, out LibraryMediaLocation location))
            {
                return;
            }

            Identities[trackId] = new TrackListenIdentity
            {
                Title = location.Title ?? string.Empty,
                Artist = location.Artist ?? string.Empty,
                Album = location.Album ?? string.Empty,
                DurationSec = location.Duration > 0 ? location.Duration : 0
            };
        }

        private static ListenHistoryEnvelope CloneEnvelope_NoLock()
        {
            return new ListenHistoryEnvelope
            {
                SchemaVersion = SchemaVersion,
                LastJournalSeq = lastJournalSeq,
                TrackingStartedOn = trackingStartedOn,
                Identities = Identities.ToDictionary(
                    pair => pair.Key,
                    pair => CloneIdentity(pair.Value),
                    StringComparer.OrdinalIgnoreCase),
                Days = Days.ToDictionary(
                    day => day.Key,
                    day => day.Value.ToDictionary(
                        track => track.Key,
                        track => new DayTrackListenStats
                        {
                            PlayCount = track.Value.PlayCount,
                            ListenMs = track.Value.ListenMs
                        },
                        StringComparer.OrdinalIgnoreCase),
                    StringComparer.Ordinal)
            };
        }

        private static TrackListenIdentity CloneIdentity(TrackListenIdentity value)
        {
            return new TrackListenIdentity
            {
                Title = value.Title,
                Artist = value.Artist,
                Album = value.Album,
                DurationSec = value.DurationSec
            };
        }

        private static void QuarantineExisting_NoLock(string reason)
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    return;
                }

                string stamp = DateTime.Now.ToString("yyyyMMddHHmmss");
                string dest = $"{FilePath}.corrupt-{stamp}-{reason}";
                File.Move(FilePath, dest, overwrite: false);
            }
            catch (Exception)
            {
                // Keep original file if rename fails.
            }
        }
    }
}
