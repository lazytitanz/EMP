using System.Text.Json;

namespace EMP.Hosting
{
    /// <summary>
    /// Authoritative durable store for user playlists / Liked Songs outside WebView2 localStorage.
    /// Uses monotonic revisions so intentional shrinks/deletes win over stale mirrors.
    /// </summary>
    internal static class PlaylistStore
    {
        public const int SchemaVersion = 2;
        public const int BackupGenerations = 3;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true
        };

        private static readonly object Gate = new();

        private static string? filePathOverride;

        private static string FilePath => filePathOverride ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "playlists.json");

        /// <summary>Raw JSON array of playlist objects, or "[]" when empty/unavailable.</summary>
        public static string CurrentJson { get; private set; } = "[]";

        public static long CurrentRevision { get; private set; }

        internal static void SetFilePathForTests(string? path)
        {
            lock (Gate)
            {
                filePathOverride = path;
                CurrentJson = "[]";
                CurrentRevision = 0;
            }
        }

        public static void Load()
        {
            lock (Gate)
            {
                if (TryLoadFile(FilePath, out string playlistsJson, out long revision))
                {
                    CurrentJson = playlistsJson;
                    CurrentRevision = revision;
                    return;
                }

                for (int generation = 1; generation <= BackupGenerations; generation += 1)
                {
                    string backupPath = BackupPath(generation);
                    if (TryLoadFile(backupPath, out playlistsJson, out revision))
                    {
                        CurrentJson = playlistsJson;
                        CurrentRevision = revision;
                        TryRestoreFromBackup(playlistsJson, revision);
                        return;
                    }
                }

                CurrentJson = "[]";
                CurrentRevision = 0;
            }
        }

        /// <summary>
        /// Persist playlists when <paramref name="revision"/> is greater than or equal to the
        /// on-disk revision. Empty arrays are allowed only when the revision advances (intentional clear).
        /// </summary>
        public static bool SavePlaylistsJson(string? playlistsJson, long revision, bool force = false)
        {
            if (string.IsNullOrWhiteSpace(playlistsJson))
            {
                return false;
            }

            lock (Gate)
            {
                try
                {
                    using JsonDocument document = JsonDocument.Parse(playlistsJson);
                    if (document.RootElement.ValueKind != JsonValueKind.Array)
                    {
                        return false;
                    }

                    string normalized = document.RootElement.GetRawText();
                    bool incomingEmpty = IsEmptyArray(normalized);
                    bool currentEmpty = IsEmptyArray(CurrentJson);

                    if (!force && revision < CurrentRevision)
                    {
                        return false;
                    }

                    // Refuse empty overwrite of nonempty data at the same or lower revision.
                    if (incomingEmpty && !currentEmpty && revision <= CurrentRevision && !force)
                    {
                        return false;
                    }

                    // Same revision may refresh payload only when nonempty and not regressing to empty.
                    if (!force && revision == CurrentRevision && incomingEmpty && !currentEmpty)
                    {
                        return false;
                    }

                    string? directory = Path.GetDirectoryName(FilePath);
                    if (!string.IsNullOrWhiteSpace(directory))
                    {
                        Directory.CreateDirectory(directory);
                    }

                    RotateBackups();

                    string payload = JsonSerializer.Serialize(
                        new PlaylistBackupFile
                        {
                            SchemaVersion = SchemaVersion,
                            Revision = revision,
                            SavedUtc = DateTimeOffset.UtcNow,
                            Playlists = document.RootElement.Clone()
                        },
                        JsonOptions);

                    AtomicWrite(FilePath, payload);
                    CurrentJson = normalized;
                    CurrentRevision = revision;
                    return true;
                }
                catch (Exception)
                {
                    // Keep previous CurrentJson/revision if the write fails.
                    return false;
                }
            }
        }

        /// <summary>Legacy overload used by older callers — treats revision as CurrentRevision + 1 when nonempty.</summary>
        public static void SavePlaylistsJson(string? playlistsJson)
        {
            if (string.IsNullOrWhiteSpace(playlistsJson))
            {
                return;
            }

            try
            {
                using JsonDocument document = JsonDocument.Parse(playlistsJson);
                if (document.RootElement.ValueKind != JsonValueKind.Array)
                {
                    return;
                }

                long nextRevision = CurrentRevision + 1;
                if (IsEmptyArray(document.RootElement.GetRawText()) && !IsEmptyArray(CurrentJson))
                {
                    return;
                }

                SavePlaylistsJson(playlistsJson, nextRevision);
            }
            catch (Exception)
            {
                // Ignore malformed payloads.
            }
        }

        public static string DocumentCreatedAssignment()
        {
            Load();
            return "window.__emp = window.__emp || {}; window.__emp.playlistsBackup = "
                + BuildBootstrapJson()
                + ";";
        }

        public static string BuildPostMessageJson()
        {
            return "{\"type\":\"playlistsBackup\",\"revision\":"
                + CurrentRevision.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + ",\"playlists\":"
                + CurrentJson
                + "}";
        }

        private static string BuildBootstrapJson()
        {
            return "{\"revision\":"
                + CurrentRevision.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + ",\"playlists\":"
                + CurrentJson
                + "}";
        }

        private static string BackupPath(int generation) => FilePath + ".bak." + generation;

        private static void RotateBackups()
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    return;
                }

                string oldest = BackupPath(BackupGenerations);
                if (File.Exists(oldest))
                {
                    File.Delete(oldest);
                }

                for (int generation = BackupGenerations - 1; generation >= 1; generation -= 1)
                {
                    string source = BackupPath(generation);
                    string destination = BackupPath(generation + 1);
                    if (File.Exists(source))
                    {
                        File.Move(source, destination, overwrite: true);
                    }
                }

                File.Copy(FilePath, BackupPath(1), overwrite: true);
            }
            catch (Exception)
            {
                // Rotation is best-effort; primary write may still succeed.
            }
        }

        private static void TryRestoreFromBackup(string playlistsJson, long revision)
        {
            try
            {
                string? directory = Path.GetDirectoryName(FilePath);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                string payload = JsonSerializer.Serialize(
                    new PlaylistBackupFile
                    {
                        SchemaVersion = SchemaVersion,
                        Revision = revision,
                        SavedUtc = DateTimeOffset.UtcNow,
                        Playlists = JsonDocument.Parse(playlistsJson).RootElement.Clone()
                    },
                    JsonOptions);
                AtomicWrite(FilePath, payload);
            }
            catch (Exception)
            {
                // In-memory CurrentJson already holds the recovered payload.
            }
        }

        private static void AtomicWrite(string path, string payload)
        {
            string temp = path + ".tmp";
            File.WriteAllText(temp, payload);
            if (File.Exists(path))
            {
                File.Replace(temp, path, destinationBackupFileName: null, ignoreMetadataErrors: true);
            }
            else
            {
                File.Move(temp, path, overwrite: true);
            }
        }

        private static bool TryLoadFile(string path, out string playlistsJson, out long revision)
        {
            playlistsJson = "[]";
            revision = 0;
            try
            {
                if (!File.Exists(path))
                {
                    return false;
                }

                string raw = File.ReadAllText(path);
                using JsonDocument document = JsonDocument.Parse(raw);
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("playlists", out JsonElement playlists)
                    && playlists.ValueKind == JsonValueKind.Array)
                {
                    playlistsJson = playlists.GetRawText();
                    if (document.RootElement.TryGetProperty("revision", out JsonElement revisionElement)
                        && revisionElement.TryGetInt64(out long parsedRevision))
                    {
                        revision = Math.Max(0, parsedRevision);
                    }

                    return true;
                }

                if (document.RootElement.ValueKind == JsonValueKind.Array)
                {
                    // Legacy v1 bare array — treat as revision 1 when nonempty, else 0.
                    playlistsJson = document.RootElement.GetRawText();
                    revision = IsEmptyArray(playlistsJson) ? 0 : 1;
                    return true;
                }

                return false;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool IsEmptyArray(string json)
        {
            string trimmed = json.Trim();
            return trimmed is "" or "[]";
        }

        private sealed class PlaylistBackupFile
        {
            public int SchemaVersion { get; set; }

            public long Revision { get; set; }

            public DateTimeOffset SavedUtc { get; set; }

            public JsonElement Playlists { get; set; }
        }
    }
}
