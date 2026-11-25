using System.Text;
using System.Text.Json;

namespace EMP.Hosting
{
    /// <summary>
    /// Durable Home preferences (pins, section layout, playback-context history) in
    /// %LocalAppData%\EMP\home.json. Independent of playlists and the playback session.
    /// </summary>
    /// <remarks>
    /// The page owns the document's shape (normalized by home-model.js); the host only checks that
    /// it is a bounded JSON object, keeps the latest copy in memory, and debounces disk writes.
    /// <see cref="FlushSync"/> runs on shutdown so a pending write is never lost.
    /// </remarks>
    internal static class HomeStore
    {
        public const int SchemaVersion = 1;
        public const int MaxDocumentBytes = 1024 * 1024;
        public static readonly TimeSpan DefaultDebounce = TimeSpan.FromSeconds(2);

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false
        };

        private static readonly object Gate = new();

        private static string? filePathOverride;
        private static string? currentJson;
        private static string? pendingJson;
        private static bool loaded;
        private static System.Threading.Timer? debounceTimer;
        private static TimeSpan debounce = DefaultDebounce;

        public static string FilePath => filePathOverride ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "home.json");

        private static string BackupPath => FilePath + ".bak";

        internal static void SetFilePathForTests(string? path, TimeSpan? debounceOverride = null)
        {
            lock (Gate)
            {
                debounceTimer?.Dispose();
                debounceTimer = null;
                filePathOverride = path;
                currentJson = null;
                pendingJson = null;
                loaded = false;
                debounce = debounceOverride ?? DefaultDebounce;
            }
        }

        /// <summary>The stored Home document as raw JSON, or null when none exists yet.</summary>
        public static string? CurrentJson
        {
            get
            {
                lock (Gate)
                {
                    EnsureLoaded_NoLock();
                    return currentJson;
                }
            }
        }

        public static bool HasPendingWrite
        {
            get
            {
                lock (Gate)
                {
                    return pendingJson is not null;
                }
            }
        }

        public static string DocumentCreatedAssignment()
        {
            string? json = CurrentJson;
            return "window.__emp = window.__emp || {}; window.__emp.home = " + (json ?? "null") + ";";
        }

        /// <summary>
        /// Accepts a new Home document from the page. Returns false (and keeps the previous
        /// document) when the payload is not a JSON object or exceeds <see cref="MaxDocumentBytes"/>.
        /// </summary>
        public static bool Update(JsonElement home)
        {
            if (home.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            string normalized = home.GetRawText();
            if (Encoding.UTF8.GetByteCount(normalized) > MaxDocumentBytes)
            {
                return false;
            }

            lock (Gate)
            {
                EnsureLoaded_NoLock();
                if (string.Equals(normalized, currentJson, StringComparison.Ordinal))
                {
                    return true;
                }

                currentJson = normalized;
                pendingJson = normalized;
                debounceTimer ??= new System.Threading.Timer(static _ => FlushSync(), null, Timeout.Infinite, Timeout.Infinite);
                debounceTimer.Change(debounce, Timeout.InfiniteTimeSpan);
                return true;
            }
        }

        public static void FlushSync()
        {
            lock (Gate)
            {
                string? payload = pendingJson;
                if (payload is null)
                {
                    return;
                }

                if (TryWrite_NoLock(payload))
                {
                    pendingJson = null;
                }
            }
        }

        private static bool TryWrite_NoLock(string homeJson)
        {
            try
            {
                string? directory = Path.GetDirectoryName(FilePath);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                using JsonDocument home = JsonDocument.Parse(homeJson);
                string payload = JsonSerializer.Serialize(
                    new HomeFile
                    {
                        SchemaVersion = SchemaVersion,
                        SavedUtc = DateTimeOffset.UtcNow,
                        Home = home.RootElement.Clone()
                    },
                    JsonOptions);

                string temp = FilePath + ".tmp";
                File.WriteAllText(temp, payload);
                if (File.Exists(FilePath))
                {
                    File.Replace(temp, FilePath, BackupPath, ignoreMetadataErrors: true);
                }
                else
                {
                    File.Move(temp, FilePath, overwrite: true);
                }

                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void EnsureLoaded_NoLock()
        {
            if (loaded)
            {
                return;
            }

            loaded = true;
            currentJson = TryRead(FilePath) ?? TryRead(BackupPath);
        }

        private static string? TryRead(string path)
        {
            try
            {
                if (!File.Exists(path))
                {
                    return null;
                }

                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
                if (document.RootElement.ValueKind != JsonValueKind.Object
                    || !document.RootElement.TryGetProperty("home", out JsonElement home)
                    || home.ValueKind != JsonValueKind.Object)
                {
                    return null;
                }

                return home.GetRawText();
            }
            catch (Exception)
            {
                return null;
            }
        }

        private sealed class HomeFile
        {
            public int SchemaVersion { get; init; }

            public DateTimeOffset SavedUtc { get; init; }

            public JsonElement Home { get; init; }
        }
    }
}
