using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.Hosting
{
    internal sealed class TrackListenStats
    {
        public long PlayCount { get; set; }

        public long LastPlayedAt { get; set; }

        public long ListenMs { get; set; }
    }

    internal sealed class ListenStatsEnvelope
    {
        public int SchemaVersion { get; set; }

        public long LastJournalSeq { get; set; }

        public Dictionary<string, TrackListenStats> Tracks { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Lifetime per-track listening statistics under %LocalAppData%\EMP\listen-stats.json.
    /// Deduplication, journaling, and disk debounce are owned by <see cref="ListenStatsCoordinator"/>.
    /// </summary>
    internal static class ListenStatsStore
    {
        public const int SchemaVersion = 1;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

        private static readonly object Gate = new();
        private static readonly Dictionary<string, TrackListenStats> Tracks = new(StringComparer.OrdinalIgnoreCase);

        private static long lastJournalSeq;
        private static bool loaded;

        public static string FilePath => ListenStatsPaths.ListenStatsFile;

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

        public static void ResetForTests()
        {
            lock (Gate)
            {
                Tracks.Clear();
                lastJournalSeq = 0;
                loaded = false;
            }
        }

        public static void Load()
        {
            // Coordinator owns ordered multi-store load; keep for startup compatibility.
            ListenStatsCoordinator.Load();
        }

        public static void LoadDiskOnly()
        {
            lock (Gate)
            {
                LoadDiskOnly_NoLock();
            }
        }

        /// <summary>
        /// Atomically validates session/update id and merges deltas via the coordinator.
        /// </summary>
        public static bool ApplyUpdate(
            string? sessionTokenValue,
            long updateId,
            string? trackId,
            long playCountDelta,
            long listenMsDelta,
            long lastPlayedAt)
        {
            return ListenStatsCoordinator.ApplyUpdate(
                sessionTokenValue,
                updateId,
                trackId,
                playCountDelta,
                listenMsDelta,
                lastPlayedAt,
                dayListenMsDelta: null);
        }

        public static void ApplyDelta(string trackId, long playCountDelta, long listenMsDelta, long lastPlayedAt)
        {
            if (string.IsNullOrWhiteSpace(trackId))
            {
                return;
            }

            lock (Gate)
            {
                EnsureLoaded_NoLock();

                if (!Tracks.TryGetValue(trackId, out TrackListenStats? stats))
                {
                    stats = new TrackListenStats();
                    Tracks[trackId] = stats;
                }

                if (playCountDelta > 0)
                {
                    stats.PlayCount += playCountDelta;
                }

                if (listenMsDelta > 0)
                {
                    stats.ListenMs += listenMsDelta;
                }

                if (lastPlayedAt > stats.LastPlayedAt)
                {
                    stats.LastPlayedAt = lastPlayedAt;
                }
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

        public static Dictionary<string, TrackListenStats> Snapshot()
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                return Tracks.ToDictionary(
                    pair => pair.Key,
                    pair => new TrackListenStats
                    {
                        PlayCount = pair.Value.PlayCount,
                        LastPlayedAt = pair.Value.LastPlayedAt,
                        ListenMs = pair.Value.ListenMs
                    },
                    StringComparer.OrdinalIgnoreCase);
            }
        }

        public static ListenStatsEnvelope CaptureEnvelope()
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                return new ListenStatsEnvelope
                {
                    SchemaVersion = SchemaVersion,
                    LastJournalSeq = lastJournalSeq,
                    Tracks = Tracks.ToDictionary(
                        pair => pair.Key,
                        pair => new TrackListenStats
                        {
                            PlayCount = pair.Value.PlayCount,
                            LastPlayedAt = pair.Value.LastPlayedAt,
                            ListenMs = pair.Value.ListenMs
                        },
                        StringComparer.OrdinalIgnoreCase)
                };
            }
        }

        public static bool TryWriteEnvelope(ListenStatsEnvelope envelope)
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

        public static void ReplaceFromEnvelope(ListenStatsEnvelope envelope)
        {
            lock (Gate)
            {
                Tracks.Clear();
                lastJournalSeq = Math.Max(0, envelope.LastJournalSeq);
                loaded = true;
                foreach (KeyValuePair<string, TrackListenStats> pair in envelope.Tracks ?? [])
                {
                    if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value is null)
                    {
                        continue;
                    }

                    Tracks[pair.Key] = new TrackListenStats
                    {
                        PlayCount = Math.Max(0, pair.Value.PlayCount),
                        LastPlayedAt = Math.Max(0, pair.Value.LastPlayedAt),
                        ListenMs = Math.Max(0, pair.Value.ListenMs)
                    };
                }
            }
        }

        public static void FlushSync()
        {
            ListenStatsCoordinator.FlushSync();
        }

        public static void QuarantineCorruptFile()
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    return;
                }

                string stamp = DateTime.Now.ToString("yyyyMMddHHmmss");
                string dest = $"{FilePath}.corrupt-{stamp}";
                File.Move(FilePath, dest, overwrite: false);
            }
            catch (Exception)
            {
                // Keep original if rename fails.
            }
        }

        private static void LoadDiskOnly_NoLock()
        {
            Tracks.Clear();
            lastJournalSeq = 0;
            loaded = true;

            try
            {
                if (!File.Exists(FilePath))
                {
                    return;
                }

                ListenStatsEnvelope? envelope = JsonSerializer.Deserialize<ListenStatsEnvelope>(
                    File.ReadAllText(FilePath),
                    JsonOptions);

                if (envelope is null || envelope.SchemaVersion != SchemaVersion)
                {
                    QuarantineCorruptFile();
                    return;
                }

                lastJournalSeq = Math.Max(0, envelope.LastJournalSeq);
                foreach (KeyValuePair<string, TrackListenStats> pair in envelope.Tracks ?? [])
                {
                    if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value is null)
                    {
                        continue;
                    }

                    Tracks[pair.Key] = new TrackListenStats
                    {
                        PlayCount = Math.Max(0, pair.Value.PlayCount),
                        LastPlayedAt = Math.Max(0, pair.Value.LastPlayedAt),
                        ListenMs = Math.Max(0, pair.Value.ListenMs)
                    };
                }
            }
            catch (Exception)
            {
                Tracks.Clear();
                lastJournalSeq = 0;
                QuarantineCorruptFile();
            }
        }

        private static void EnsureLoaded_NoLock()
        {
            if (!loaded)
            {
                LoadDiskOnly_NoLock();
            }
        }
    }
}
