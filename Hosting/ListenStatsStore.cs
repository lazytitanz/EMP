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

        public Dictionary<string, TrackListenStats> Tracks { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Durable per-track listening statistics under %LocalAppData%\EMP\listen-stats.json.
    /// Session-token / update-id validation and delta merge are atomic. Disk writes are
    /// serialized and generation-gated so an older async snapshot cannot overwrite newer data.
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
        private static readonly object WriterGate = new();

        private static string? sessionToken;
        private static long lastUpdateId;
        private static long dirtyGeneration;
        private static long persistedGeneration;
        private static System.Threading.Timer? debounceTimer;
        private static int writeQueued;
        private static bool loaded;

        public static string FilePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "listen-stats.json");

        public static void Load()
        {
            lock (Gate)
            {
                Tracks.Clear();
                sessionToken = null;
                lastUpdateId = 0;
                dirtyGeneration = 0;
                persistedGeneration = 0;
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
                        return;
                    }

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
                }
            }
        }

        /// <summary>
        /// Atomically validates session/update id and merges deltas. Returns true when accepted.
        /// </summary>
        public static bool ApplyUpdate(
            string? sessionTokenValue,
            long updateId,
            string? trackId,
            long playCountDelta,
            long listenMsDelta,
            long lastPlayedAt)
        {
            if (string.IsNullOrWhiteSpace(sessionTokenValue)
                || string.IsNullOrWhiteSpace(trackId)
                || updateId <= 0)
            {
                return false;
            }

            if (playCountDelta == 0 && listenMsDelta == 0 && lastPlayedAt <= 0)
            {
                // Still consume the update id so duplicates cannot re-enter with payload later.
            }

            bool scheduleSave = false;
            lock (Gate)
            {
                EnsureLoaded_NoLock();

                if (!string.Equals(sessionToken, sessionTokenValue, StringComparison.Ordinal))
                {
                    sessionToken = sessionTokenValue;
                    lastUpdateId = 0;
                }

                if (updateId <= lastUpdateId)
                {
                    return false;
                }

                lastUpdateId = updateId;

                if (playCountDelta == 0 && listenMsDelta == 0 && lastPlayedAt <= 0)
                {
                    return true;
                }

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

                dirtyGeneration++;
                scheduleSave = true;
            }

            if (scheduleSave)
            {
                ScheduleDebouncedSave();
            }

            return true;
        }

        /// <summary>
        /// Read-only copy of listening statistics for UI browsing and local mix generation.
        /// Does not mutate store state. Includes listenMs from the in-memory store.
        /// </summary>
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

        public static void FlushSync()
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                debounceTimer?.Change(Timeout.Infinite, Timeout.Infinite);
            }

            // Join any in-flight writer, then write until the latest accepted generation is on disk.
            lock (WriterGate)
            {
                while (true)
                {
                    bool dirty;
                    lock (Gate)
                    {
                        dirty = dirtyGeneration > persistedGeneration;
                    }

                    if (!dirty)
                    {
                        return;
                    }

                    WriteSnapshot_NoWriterLock();
                }
            }
        }

        private static void EnsureLoaded_NoLock()
        {
            if (!loaded)
            {
                // Lazy load if Apply/Flush raced ahead of explicit Load.
                loaded = true;
                try
                {
                    if (File.Exists(FilePath))
                    {
                        ListenStatsEnvelope? envelope = JsonSerializer.Deserialize<ListenStatsEnvelope>(
                            File.ReadAllText(FilePath),
                            JsonOptions);
                        if (envelope is not null && envelope.SchemaVersion == SchemaVersion)
                        {
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
                }
                catch (Exception)
                {
                    Tracks.Clear();
                }
            }
        }

        private static void ScheduleDebouncedSave()
        {
            lock (Gate)
            {
                debounceTimer ??= new System.Threading.Timer(_ => OnDebounceElapsed(), null, Timeout.Infinite, Timeout.Infinite);
                debounceTimer.Change(3000, Timeout.Infinite);
            }
        }

        private static void OnDebounceElapsed()
        {
            if (Interlocked.CompareExchange(ref writeQueued, 1, 0) != 0)
            {
                return;
            }

            try
            {
                Task.Run(() =>
                {
                    try
                    {
                        lock (WriterGate)
                        {
                            WriteSnapshot_NoWriterLock();
                        }
                    }
                    finally
                    {
                        Interlocked.Exchange(ref writeQueued, 0);

                        bool stillDirty;
                        lock (Gate)
                        {
                            stillDirty = dirtyGeneration > persistedGeneration;
                        }

                        if (stillDirty)
                        {
                            ScheduleDebouncedSave();
                        }
                    }
                });
            }
            catch (Exception)
            {
                Interlocked.Exchange(ref writeQueued, 0);
            }
        }

        private static void WriteSnapshot_NoWriterLock()
        {
            long generation;
            ListenStatsEnvelope envelope;
            lock (Gate)
            {
                if (dirtyGeneration <= persistedGeneration)
                {
                    return;
                }

                generation = dirtyGeneration;
                envelope = new ListenStatsEnvelope
                {
                    SchemaVersion = SchemaVersion,
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

            string path = FilePath;
            string temp = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                string? directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.WriteAllText(temp, JsonSerializer.Serialize(envelope, JsonOptions));
                File.Move(temp, path, overwrite: true);

                lock (Gate)
                {
                    // Only clear dirty through this generation; newer applies keep dirty set.
                    if (generation > persistedGeneration)
                    {
                        persistedGeneration = generation;
                    }
                }
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
    }
}
