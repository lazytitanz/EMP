using System.Text.Json;
using System.Text.Json.Serialization;
using EMP.Cast;
using EMP.Library;
using EMP.Library.Metadata;
using EMP.Lyrics;
using EMP.UpdateCore;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace EMP.Hosting
{
    internal static class WebUiHost
    {
        public const string HostName = "app.emp";
        public const string StartUrl = "https://app.emp/index.html";

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        private static readonly HashSet<string> MappedHosts = new(StringComparer.OrdinalIgnoreCase);
        private static readonly HashSet<string> RetainedHosts = new(StringComparer.OrdinalIgnoreCase);
        private static readonly HashSet<string> ActiveMediaHosts = new(StringComparer.OrdinalIgnoreCase);

        public static string WwwRootPath => Path.Combine(AppContext.BaseDirectory, "www");

        public static string UserDataFolder => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "WebView2");

        private static SystemMediaControls? systemMedia;
        private static MusicFolderWatchers? folderWatchers;
        private static CastCoordinator? cast;
        private static LyricsService? lyrics;
        private static WebView2? hostView;
        private static string artworkRoot = string.Empty;
        private static bool pageLoaded;
        private static int storageRequested;
        private static int storageMeasuring;
        private static readonly LibraryScanCoordinator ScanCoordinator = new();
        private static readonly MetadataEditorService MetadataEditor = new();
        private static CachedMusicLibrary? lastCompleteCache;
        private static MusicLibrary? currentLibrary;
        private static string? lastDeliveredFingerprint;
        private static string? nowPlayingTrackId;
        private static string? nowPlayingNextTrackId;

        public static event Action<bool>? PlayingChanged;

        public static event Action<string>? WindowActionRequested;

        public static Func<bool>? IsWindowMaximized { get; set; }

        public static async Task InitializeAsync(WebView2 webView)
        {
            ArgumentNullException.ThrowIfNull(webView);

            if (!Directory.Exists(WwwRootPath))
            {
                throw new DirectoryNotFoundException(
                    $"The UI folder was not found at '{WwwRootPath}'.");
            }

            Directory.CreateDirectory(UserDataFolder);

            IReadOnlyList<string> startupFolders = AppSettingsStore.ResolvedMusicFolders();
            Task<CachedMusicLibrary?> cacheLoadTask = Task.Run(() => LibraryCacheStore.TryLoad(startupFolders));
            Task listenStatsLoadTask = Task.Run(ListenStatsCoordinator.Load);

            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
                userDataFolder: UserDataFolder);

            await webView.EnsureCoreWebView2Async(environment);

            webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                HostName,
                WwwRootPath,
                CoreWebView2HostResourceAccessKind.Allow);

            artworkRoot = Path.Combine(WwwRootPath, "artwork");
            Directory.CreateDirectory(artworkRoot);
            hostView = webView;
            // WebView2 ignores hosts registered after the current page's resource
            // loader exists. Map known library roots before the first navigation.
            SyncVirtualHosts(startupFolders);

            CoreWebView2Settings settings = webView.CoreWebView2.Settings;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsWebMessageEnabled = true;
            settings.IsNonClientRegionSupportEnabled = true;

            // Unlock media device labels for Audio Output selection (enumerateDevices).
            webView.CoreWebView2.PermissionRequested += (_, args) =>
            {
                if (args.PermissionKind == CoreWebView2PermissionKind.Microphone)
                {
                    args.State = CoreWebView2PermissionState.Allow;
                    args.Handled = true;
                }
            };

            try
            {
                // Keep HTTP cache disabled: media virtual URLs are path-stable without
                // version busting, so in-place file replace/retag would serve stale audio.
                // Artwork uses content-hash ?v= for fingerprint/UI; that alone cannot
                // selectively re-enable cache (CDP toggle is process-global).
                await webView.CoreWebView2.CallDevToolsProtocolMethodAsync(
                    "Network.setCacheDisabled",
                    "{\"cacheDisabled\":true}");
            }
            catch (Exception)
            {
                // Playback still works if the cache cannot be disabled.
            }

            systemMedia?.Dispose();
            systemMedia = new SystemMediaControls(webView);

            folderWatchers?.Dispose();
            folderWatchers = new MusicFolderWatchers(() => PostToUi(() => RefreshLibrary()));

            cast?.Dispose();
            cast = new CastCoordinator(PostCastMessage);

            lyrics?.Dispose();
            lyrics = new LyricsService(OnSyncedLyricsUpgrade);

            CachedMusicLibrary? startupCache = await cacheLoadTask.ConfigureAwait(true);
            await listenStatsLoadTask.ConfigureAwait(true);
            if (startupCache is not null)
            {
                MusicLibrary hydrated = TrackDateStore.ApplyAndPersist(startupCache.Library);
                startupCache = new CachedMusicLibrary
                {
                    ContentFingerprint = startupCache.ContentFingerprint,
                    FolderPaths = startupCache.FolderPaths,
                    Library = hydrated
                };
                lastCompleteCache = startupCache;
                currentLibrary = hydrated;
                lastDeliveredFingerprint = startupCache.ContentFingerprint;
                LibraryMediaIndex.Replace(hydrated.Locations);
            }

            // Single document-created registration: message bridge + optional cached library.
            // Must complete before Navigate so warm starts hydrate before first paint.
            await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                BuildDocumentCreatedScript(startupCache));

            webView.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                if (args.IsSuccess)
                {
                    pageLoaded = true;
                    RefreshLibrary();
                    PostAppSettings();
                    UpdateCoordinator.PostStatus();
                    PostWindowState(IsWindowMaximized?.Invoke() ?? false);
                }
            };

            webView.CoreWebView2.WebMessageReceived += (_, args) =>
            {
                try
                {
                    using JsonDocument document = JsonDocument.Parse(args.WebMessageAsJson);
                    if (!document.RootElement.TryGetProperty("type", out JsonElement type))
                    {
                        return;
                    }

                    string? kind = type.GetString();
                    if (kind == "refresh")
                    {
                        RefreshLibrary(ReadString(document.RootElement, "requestId"));
                    }
                    else if (kind == "addMusicFolder")
                    {
                        HandleAddMusicFolder();
                    }
                    else if (kind == "removeMusicFolder")
                    {
                        HandleRemoveMusicFolder(ReadString(document.RootElement, "path"));
                    }
                    else if (kind == "nowPlaying")
                    {
                        HandleNowPlaying(document.RootElement);
                    }
                    else if (kind == "artistInfo")
                    {
                        string? name = ReadString(document.RootElement, "name");
                        if (!string.IsNullOrWhiteSpace(name))
                        {
                            _ = SendArtistInfoAsync(webView, name);
                        }
                    }
                    else if (kind == "lyrics")
                    {
                        string? trackId = ReadString(document.RootElement, "trackId");
                        if (!string.IsNullOrWhiteSpace(trackId))
                        {
                            _ = SendLyricsAsync(trackId);
                        }
                    }
                    else if (kind == "storage")
                    {
                        RequestStorageUsage();
                    }
                    else if (kind == "appSettings")
                    {
                        HandleAppSettings(document.RootElement);
                    }
                    else if (kind == "castDiscovery")
                    {
                        bool enabled = document.RootElement.TryGetProperty("enabled", out JsonElement enabledElement)
                            && enabledElement.ValueKind == JsonValueKind.True;
                        cast?.SetDiscoveryEnabled(enabled);
                    }
                    else if (kind == "castSelect")
                    {
                        HandleCastSelect(document.RootElement);
                    }
                    else if (kind == "castCommand")
                    {
                        HandleCastCommand(document.RootElement);
                    }
                    else if (kind == "window")
                    {
                        HandleWindowAction(document.RootElement);
                    }
                    else if (kind == "listenStatsUpdate")
                    {
                        HandleListenStatsUpdate(document.RootElement);
                    }
                    else if (kind == "listenStatsRequest")
                    {
                        PostListenStatsSnapshot();
                    }
                    else if (kind == "updates")
                    {
                        UpdateCoordinator.HandleMessage(document.RootElement);
                    }
                    else if (kind == "metadataGet")
                    {
                        HandleMetadataGet(document.RootElement);
                    }
                    else if (kind == "metadataApply")
                    {
                        HandleMetadataApply(document.RootElement);
                    }
                    else if (kind == "metadataCancel")
                    {
                        MetadataEditor.CancelApply();
                    }
                }
                catch (JsonException)
                {
                    // Ignore malformed UI messages.
                }
            };

            webView.CoreWebView2.Navigate(StartUrl);
        }

        public static void Shutdown()
        {
            ScanCoordinator.Shutdown();
            folderWatchers?.Dispose();
            folderWatchers = null;
            systemMedia?.Dispose();
            systemMedia = null;
            cast?.Dispose();
            cast = null;
            lyrics?.Dispose();
            lyrics = null;
            ListenStatsCoordinator.FlushSync();
            LibraryMediaIndex.Clear();
            hostView = null;
            pageLoaded = false;
            lastCompleteCache = null;
            currentLibrary = null;
            lastDeliveredFingerprint = null;
            nowPlayingTrackId = null;
            nowPlayingNextTrackId = null;
            IsWindowMaximized = null;
            MappedHosts.Clear();
            RetainedHosts.Clear();
            ActiveMediaHosts.Clear();
        }

        public static void ApplyListenStatsUpdatesFromJson(string? json)
        {
            if (string.IsNullOrWhiteSpace(json) || json == "null")
            {
                return;
            }

            try
            {
                using JsonDocument document = JsonDocument.Parse(json);
                if (document.RootElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (JsonElement item in document.RootElement.EnumerateArray())
                    {
                        HandleListenStatsUpdate(item);
                    }
                }
                else if (document.RootElement.ValueKind == JsonValueKind.String)
                {
                    // ExecuteScriptAsync may wrap a returned string again.
                    ApplyListenStatsUpdatesFromJson(document.RootElement.GetString());
                }
            }
            catch (JsonException)
            {
                // Ignore malformed flush payloads during shutdown.
            }
        }

        private static void HandleListenStatsUpdate(JsonElement message)
        {
            string? token = ReadString(message, "sessionToken");
            string? trackId = ReadString(message, "trackId");
            long updateId = ReadInt64(message, "updateId");
            long playCountDelta = ReadInt64(message, "playCountDelta");
            long listenMsDelta = ReadInt64(message, "listenMsDelta");
            long lastPlayedAt = ReadInt64(message, "lastPlayedAt");
            Dictionary<string, long>? dayListenMsDelta = ReadDayListenMsDelta(message);
            ListenStatsCoordinator.ApplyUpdate(
                token,
                updateId,
                trackId,
                playCountDelta,
                listenMsDelta,
                lastPlayedAt,
                dayListenMsDelta);
        }

        private static Dictionary<string, long>? ReadDayListenMsDelta(JsonElement message)
        {
            if (!message.TryGetProperty("dayListenMsDelta", out JsonElement dayElement)
                || dayElement.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            Dictionary<string, long> days = new(StringComparer.Ordinal);
            foreach (JsonProperty property in dayElement.EnumerateObject())
            {
                if (string.IsNullOrWhiteSpace(property.Name))
                {
                    continue;
                }

                long value = 0;
                if (property.Value.ValueKind == JsonValueKind.Number
                    && property.Value.TryGetInt64(out long parsed))
                {
                    value = parsed;
                }
                else if (property.Value.ValueKind == JsonValueKind.String
                    && long.TryParse(property.Value.GetString(), out parsed))
                {
                    value = parsed;
                }

                if (value > 0)
                {
                    days[property.Name] = value;
                }
            }

            return days.Count > 0 ? days : null;
        }

        private static void PostListenStatsSnapshot()
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            Dictionary<string, object> tracks = new(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, TrackListenStats> pair in ListenStatsStore.Snapshot())
            {
                tracks[pair.Key] = new
                {
                    playCount = pair.Value.PlayCount,
                    lastPlayedAt = pair.Value.LastPlayedAt,
                    listenMs = pair.Value.ListenMs
                };
            }

            var message = new
            {
                type = "listenStats",
                tracks
            };

            hostView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
        }

        public static void PostWindowState(bool maximized)
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            WindowStateMessage message = new()
            {
                Type = "windowState",
                Maximized = maximized
            };

            hostView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
        }

        private static void HandleWindowAction(JsonElement message)
        {
            string? action = ReadString(message, "action");
            if (string.IsNullOrWhiteSpace(action))
            {
                return;
            }

            if (action is not ("minimize" or "maximizeToggle" or "close" or "drag"))
            {
                return;
            }

            WindowActionRequested?.Invoke(action);
        }

        private static void RefreshLibrary(string? requestId = null)
        {
            IReadOnlyList<string> folders = AppSettingsStore.ResolvedMusicFolders();
            bool addedHost = SyncVirtualHosts(folders);
            SyncWatchers(folders);
            if (addedHost && pageLoaded && hostView?.CoreWebView2 is not null)
            {
                hostView.CoreWebView2.Reload();
                return;
            }

            if (string.IsNullOrWhiteSpace(requestId)
                && ScanCoordinator.TryDeferWatcherRefresh(requiresFullScan: false))
            {
                return;
            }

            RequestLibraryScan(requestId);
        }

        private static void RequestLibraryScan(string? requestId = null)
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            string root = artworkRoot;
            ScanCoordinator.Request(requestId, scanGeneration =>
            {
                _ = Task.Run(() => RunLibraryScan(scanGeneration, root));
            });
        }

        private static void RunLibraryScan(int scanGeneration, string scanArtworkRoot)
        {
            IReadOnlyList<string> folders = AppSettingsStore.ResolvedMusicFolders();
            LibraryScanResult result;
            try
            {
                MusicLibrary scanned = MusicLibraryScanner.Scan(
                    folders,
                    scanArtworkRoot,
                    BuildPreviousCoverUrlsByAlbumId(lastCompleteCache));
                MusicLibrary merged = LibraryCacheStore.MergeUnavailableFromCache(
                    scanned,
                    folders,
                    lastCompleteCache);
                // Durable first-seen timestamps — independent of disposable library-cache.json.
                merged = TrackDateStore.ApplyAndPersist(merged);
                string fingerprint = LibraryCacheStore.ComputeFingerprint(merged);
                result = new LibraryScanResult
                {
                    Failed = false,
                    Folders = folders,
                    Library = merged,
                    Fingerprint = fingerprint,
                    PreserveDiskCache = LibraryCacheStore.ShouldPreserveDiskCache(scanned, lastCompleteCache)
                };
            }
            catch (Exception)
            {
                result = new LibraryScanResult
                {
                    Failed = true,
                    Folders = folders,
                    Library = new MusicLibrary(),
                    Fingerprint = string.Empty,
                    PreserveDiskCache = true
                };
            }

            PostToUi(() => DeliverLibraryScan(scanGeneration, result));
        }

        private static void DeliverLibraryScan(int scanGeneration, LibraryScanResult result)
        {
            if (!ScanCoordinator.IsCurrent(scanGeneration) || hostView?.CoreWebView2 is null)
            {
                return;
            }

            IReadOnlyList<string> requestIds = ScanCoordinator.TakeCompletionRequestIds();
            bool hasManualRefresh = requestIds.Count > 0;

            if (result.Failed)
            {
                if (hasManualRefresh)
                {
                    foreach (string requestId in requestIds)
                    {
                        PostLibraryMessage(new LibraryMessage
                        {
                            Type = "library",
                            RequestId = requestId,
                            Failed = true,
                            ContentFingerprint = lastDeliveredFingerprint,
                            RootPath = lastCompleteCache?.Library.RootPath ?? string.Empty,
                            Folders = lastCompleteCache?.Library.Folders ?? [],
                            Albums = lastCompleteCache?.Library.Albums ?? [],
                            Singles = lastCompleteCache?.Library.Singles ?? [],
                            Tracks = lastCompleteCache?.Library.Tracks ?? []
                        });
                    }
                }

                _ = ScanCoordinator.TryStartFollowUp(scanGeneration, next =>
                {
                    string root = artworkRoot;
                    _ = Task.Run(() => RunLibraryScan(next, root));
                });
                return;
            }

            LibraryMediaIndex.Replace(result.Library.Locations);
            currentLibrary = result.Library;

            bool unchanged = string.Equals(
                result.Fingerprint,
                lastDeliveredFingerprint,
                StringComparison.Ordinal);

            if (!unchanged || hasManualRefresh)
            {
                lastDeliveredFingerprint = result.Fingerprint;

                if (requestIds.Count == 0)
                {
                    PostLibraryMessage(ToLibraryMessage(result.Library, result.Fingerprint, requestId: null));
                }
                else
                {
                    foreach (string requestId in requestIds)
                    {
                        PostLibraryMessage(ToLibraryMessage(result.Library, result.Fingerprint, requestId));
                    }
                }
            }

            if (!result.PreserveDiskCache && LibraryCacheStore.IsCompleteScan(result.Library))
            {
                lastCompleteCache = new CachedMusicLibrary
                {
                    ContentFingerprint = result.Fingerprint,
                    FolderPaths = result.Folders,
                    Library = result.Library
                };
                LibraryCacheStore.Save(result.Folders, result.Library, result.Fingerprint);
            }

            _ = ScanCoordinator.TryStartFollowUp(scanGeneration, next =>
            {
                string root = artworkRoot;
                _ = Task.Run(() => RunLibraryScan(next, root));
            });
        }

        private static LibraryMessage ToLibraryMessage(MusicLibrary library, string fingerprint, string? requestId)
        {
            return new LibraryMessage
            {
                Type = "library",
                RequestId = requestId,
                ContentFingerprint = fingerprint,
                RootPath = library.RootPath,
                Folders = library.Folders,
                Albums = library.Albums,
                Singles = library.Singles,
                Tracks = library.Tracks
            };
        }

        private static IReadOnlyDictionary<string, string?>? BuildPreviousCoverUrlsByAlbumId(
            CachedMusicLibrary? cache)
        {
            if (cache?.Library is null)
            {
                return null;
            }

            Dictionary<string, string?> map = new(StringComparer.OrdinalIgnoreCase);
            foreach (AlbumInfo album in cache.Library.Albums.Concat(cache.Library.Singles))
            {
                if (!string.IsNullOrWhiteSpace(album.Id))
                {
                    map[album.Id] = album.CoverUrl;
                }
            }

            return map.Count == 0 ? null : map;
        }

        private static void PostLibraryMessage(LibraryMessage message)
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            hostView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
        }

        private static string BuildDocumentCreatedScript(CachedMusicLibrary? startupCache)
        {
            const string bridge = """
                window.__emp = window.__emp || {};
                if (typeof window.__emp.library === 'undefined') {
                  window.__emp.library = null;
                }
                if (!window.__emp.__bridgeBound) {
                  window.__emp.__bridgeBound = true;
                  window.chrome.webview.addEventListener('message', (event) => {
                    const message = event.data;
                    if (!message || !message.type) {
                      return;
                    }
                    if (message.type === 'library') {
                      window.__emp.library = message;
                      window.dispatchEvent(new CustomEvent('emp-library', { detail: message }));
                      return;
                    }
                    if (message.type === 'artistInfo') {
                      window.dispatchEvent(new CustomEvent('emp-artist-info', { detail: message }));
                      return;
                    }
                    if (message.type === 'lyrics') {
                      window.dispatchEvent(new CustomEvent('emp-lyrics', { detail: message }));
                      return;
                    }
                    if (message.type === 'storage') {
                      window.dispatchEvent(new CustomEvent('emp-storage', { detail: message }));
                      return;
                    }
                    if (message.type === 'appSettings') {
                      window.dispatchEvent(new CustomEvent('emp-app-settings', { detail: message }));
                      return;
                    }
                    if (message.type === 'castDevices' || message.type === 'castStatus' || message.type === 'castError') {
                      window.dispatchEvent(new CustomEvent('emp-cast', { detail: message }));
                      return;
                    }
                    if (message.type === 'windowState') {
                      window.dispatchEvent(new CustomEvent('emp-window-state', { detail: message }));
                      return;
                    }
                    if (message.type === 'listenStats') {
                      window.dispatchEvent(new CustomEvent('emp-listen-stats', { detail: message }));
                      return;
                    }
                    if (message.type === 'updateStatus') {
                      window.dispatchEvent(new CustomEvent('emp-update-status', { detail: message }));
                      return;
                    }
                    if (message.type === 'metadataResult' || message.type === 'metadataProgress' || message.type === 'metadataApplied') {
                      window.dispatchEvent(new CustomEvent('emp-metadata', { detail: message }));
                    }
                  });
                }
                """;

            if (startupCache is null)
            {
                return bridge;
            }

            LibraryMessage hydrate = ToLibraryMessage(
                startupCache.Library,
                startupCache.ContentFingerprint,
                requestId: null);
            string json = JsonSerializer.Serialize(hydrate, JsonOptions);
            return bridge + "window.__emp.library = " + json + ";";
        }

        private sealed class LibraryScanResult
        {
            public required bool Failed { get; init; }

            public required IReadOnlyList<string> Folders { get; init; }

            public required MusicLibrary Library { get; init; }

            public required string Fingerprint { get; init; }

            public required bool PreserveDiskCache { get; init; }
        }

        private static void PostAppSettings()
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            AppSettings settings = AppSettingsStore.Current;
            AppSettingsMessage message = new()
            {
                Type = "appSettings",
                StartupOnLogin = settings.StartupOnLogin,
                CloseMinimizes = settings.CloseMinimizes,
                AutomaticUpdateChecks = settings.AutomaticUpdateChecks,
                CurrentVersion = AppVersion.Current
            };

            hostView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
        }

        private static void HandleAddMusicFolder()
        {
            if (hostView is null)
            {
                return;
            }

            using FolderBrowserDialog dialog = new()
            {
                Description = "Choose a music folder",
                UseDescriptionForTitle = true,
                ShowNewFolderButton = true
            };

            string? initial = AppSettingsStore.ResolvedMusicFolders().FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(initial) && Directory.Exists(initial))
            {
                dialog.SelectedPath = initial;
            }

            Form? owner = hostView.FindForm();
            if (dialog.ShowDialog(owner) != DialogResult.OK)
            {
                return;
            }

            string? added = MusicFolderPaths.TryNormalize(dialog.SelectedPath);
            if (added is null)
            {
                return;
            }

            List<string> folders = AppSettingsStore.ResolvedMusicFolders().ToList();
            if (folders.Any(existing => MusicFolderPaths.EqualsPath(existing, added)))
            {
                return;
            }

            if (folders.Any(existing => MusicFolderPaths.IsStrictParent(existing, added)))
            {
                return;
            }

            folders.RemoveAll(existing => MusicFolderPaths.IsStrictParent(added, existing));
            folders.Add(added);
            AppSettingsStore.SaveMusicFolders(folders);
            RefreshLibrary();
        }

        private static void HandleRemoveMusicFolder(string? path)
        {
            string? removed = MusicFolderPaths.TryNormalize(path);
            if (removed is null)
            {
                return;
            }

            List<string> folders = AppSettingsStore.ResolvedMusicFolders()
                .Where(existing => !MusicFolderPaths.EqualsPath(existing, removed))
                .ToList();

            AppSettingsStore.SaveMusicFolders(folders);
            RefreshLibrary();
        }

        private static bool SyncVirtualHosts(IReadOnlyList<string> folders)
        {
            if (hostView?.CoreWebView2 is null)
            {
                return false;
            }

            HashSet<string> needed = new(StringComparer.OrdinalIgnoreCase);
            bool addedHost = false;
            foreach (string folder in folders)
            {
                if (!Directory.Exists(folder))
                {
                    continue;
                }

                string host = MusicLibraryScanner.HostNameForRoot(folder);
                needed.Add(host);
                bool isNew = MappedHosts.Add(host);
                try
                {
                    hostView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                        host,
                        folder,
                        CoreWebView2HostResourceAccessKind.Allow);
                    if (isNew)
                    {
                        addedHost = true;
                    }

                    RetainedHosts.Remove(host);
                }
                catch (Exception)
                {
                    if (isNew)
                    {
                        MappedHosts.Remove(host);
                    }
                }
            }

            foreach (string host in MappedHosts.ToArray())
            {
                if (needed.Contains(host))
                {
                    continue;
                }

                if (ActiveMediaHosts.Contains(host))
                {
                    RetainedHosts.Add(host);
                    continue;
                }

                ClearMappedHost(host);
            }

            return addedHost;
        }

        private static void ReleaseUnusedMappings()
        {
            foreach (string host in RetainedHosts.ToArray())
            {
                if (!ActiveMediaHosts.Contains(host))
                {
                    ClearMappedHost(host);
                }
            }
        }

        private static void ClearMappedHost(string host)
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            try
            {
                hostView.CoreWebView2.ClearVirtualHostNameToFolderMapping(host);
            }
            catch (Exception)
            {
                // The mapping may already be gone.
            }

            MappedHosts.Remove(host);
            RetainedHosts.Remove(host);
        }

        private static void SyncWatchers(IReadOnlyList<string> folders)
        {
            folderWatchers?.Sync(folders.Where(Directory.Exists));
        }

        private static async Task SendArtistInfoAsync(WebView2 webView, string name)
        {
            MusicBrainzClient.ArtistProfile profile;
            try
            {
                profile = await MusicBrainzClient.GetArtistProfileAsync(name);
            }
            catch (Exception)
            {
                // Leave the UI retryable: JS timeout clears the skeleton without
                // session-caching an empty result. Message shape unchanged.
                return;
            }

            PostArtistInfo(webView, profile);
        }

        private static void PostArtistInfo(WebView2 webView, MusicBrainzClient.ArtistProfile profile)
        {
            try
            {
                string json = JsonSerializer.Serialize(new ArtistInfoMessage
                {
                    Type = "artistInfo",
                    Name = profile.Name,
                    Genres = profile.Genres,
                    OriginLabel = profile.OriginLabel,
                    BeginYear = profile.BeginYear,
                    Area = profile.Area
                }, JsonOptions);

                void Post()
                {
                    webView.CoreWebView2?.PostWebMessageAsJson(json);
                }

                if (webView.IsDisposed)
                {
                    return;
                }

                if (webView.InvokeRequired)
                {
                    webView.BeginInvoke(Post);
                }
                else
                {
                    Post();
                }
            }
            catch (Exception)
            {
                // Artist metadata is optional; the page still renders without it.
            }
        }

        private static async Task SendLyricsAsync(string trackId)
        {
            LyricsMessage message;
            try
            {
                LyricsService? service = lyrics;
                if (service is null)
                {
                    message = LyricsMessage.Unavailable(trackId, retryable: true);
                }
                else if (!LibraryMediaIndex.TryGet(trackId, out LibraryMediaLocation location))
                {
                    message = LyricsMessage.Unavailable(trackId, retryable: false);
                }
                else
                {
                    LyricsResult result = await service.GetAsync(new LyricsLookup
                    {
                        TrackId = location.TrackId,
                        Title = location.Title,
                        Artist = location.Artist,
                        Album = location.Album,
                        Duration = location.Duration
                    });
                    message = LyricsMessage.From(trackId, result);
                }
            }
            catch (Exception)
            {
                message = LyricsMessage.Unavailable(trackId, retryable: true);
            }

            PostLyrics(message);
        }

        private static void OnSyncedLyricsUpgrade(LyricsLookup lookup, LyricsResult result)
        {
            PostLyrics(LyricsMessage.From(lookup.TrackId, result));
        }

        private static void PostLyrics(LyricsMessage message)
        {
            string json;
            try
            {
                json = JsonSerializer.Serialize(message, JsonOptions);
            }
            catch (Exception)
            {
                return;
            }

            PostToUi(() =>
            {
                try
                {
                    hostView?.CoreWebView2?.PostWebMessageAsJson(json);
                }
                catch (Exception)
                {
                    // The WebView may already be tearing down.
                }
            });
        }

        private static void RequestStorageUsage()
        {
            Interlocked.Exchange(ref storageRequested, 1);
            if (Interlocked.CompareExchange(ref storageMeasuring, 1, 0) == 0)
            {
                _ = Task.Run(MeasureStorageUsage);
            }
        }

        private static void MeasureStorageUsage()
        {
            do
            {
                try
                {
                    // Requests that arrive mid-measurement are folded into one more pass.
                    while (Interlocked.Exchange(ref storageRequested, 0) == 1)
                    {
                        string json = JsonSerializer.Serialize(new StorageMessage
                        {
                            Type = "storage",
                            LibraryBytes = StorageUsage.LibraryBytes(LibraryMediaIndex.CurrentPaths()),
                            CacheBytes = StorageUsage.CacheBytes()
                        }, JsonOptions);

                        PostToUi(() =>
                        {
                            try
                            {
                                hostView?.CoreWebView2?.PostWebMessageAsJson(json);
                            }
                            catch (Exception)
                            {
                                // The WebView may already be tearing down.
                            }
                        });
                    }
                }
                catch (Exception)
                {
                    // Storage figures are informational; the settings page keeps its last values.
                }
                finally
                {
                    Volatile.Write(ref storageMeasuring, 0);
                }
            }
            while (Volatile.Read(ref storageRequested) == 1
                && Interlocked.CompareExchange(ref storageMeasuring, 1, 0) == 0);
        }

        private static void HandleAppSettings(JsonElement message)
        {
            string startupOnLogin = ReadString(message, "startupOnLogin") ?? AppSettingsStore.Current.StartupOnLogin;
            bool closeMinimizes = AppSettingsStore.Current.CloseMinimizes;
            if (message.TryGetProperty("closeMinimizes", out JsonElement closeElement))
            {
                closeMinimizes = closeElement.ValueKind == JsonValueKind.True;
            }

            bool automaticUpdateChecks = AppSettingsStore.Current.AutomaticUpdateChecks;
            if (message.TryGetProperty("automaticUpdateChecks", out JsonElement autoElement))
            {
                automaticUpdateChecks = autoElement.ValueKind == JsonValueKind.True;
            }

            AppSettingsStore.Save(AppSettingsStore.CopyCurrent(
                startupOnLogin: startupOnLogin,
                closeMinimizes: closeMinimizes,
                automaticUpdateChecks: automaticUpdateChecks));
        }

        private static void HandleNowPlaying(JsonElement message)
        {
            string? title = ReadString(message, "title");
            string? artist = ReadString(message, "artist");
            string? album = ReadString(message, "album");
            string? coverUrl = ReadString(message, "coverUrl");
            nowPlayingTrackId = ReadString(message, "trackId");
            nowPlayingNextTrackId = ReadString(message, "nextTrackId");
            bool playing = message.TryGetProperty("playing", out JsonElement playingElement)
                && playingElement.ValueKind == JsonValueKind.True;

            ActiveMediaHosts.Clear();
            if (message.TryGetProperty("mediaHosts", out JsonElement hosts) && hosts.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement host in hosts.EnumerateArray())
                {
                    if (host.ValueKind == JsonValueKind.String)
                    {
                        string? value = host.GetString();
                        if (!string.IsNullOrWhiteSpace(value))
                        {
                            ActiveMediaHosts.Add(value);
                        }
                    }
                }
            }

            ReleaseUnusedMappings();
            PlayingChanged?.Invoke(playing);

            if (systemMedia is null)
            {
                return;
            }

            _ = systemMedia.UpdateAsync(title, artist, album, playing, coverUrl);
        }

        private static void HandleCastSelect(JsonElement message)
        {
            cast?.Select(
                ReadString(message, "deviceId"),
                ReadString(message, "trackId"),
                ReadString(message, "nextTrackId"),
                ReadDouble(message, "position"),
                ReadBool(message, "playing"),
                ReadDouble(message, "volume", 80),
                ReadBool(message, "muted"));
        }

        private static void HandleCastCommand(JsonElement message)
        {
            cast?.Command(
                ReadString(message, "action"),
                ReadString(message, "trackId"),
                ReadString(message, "nextTrackId"),
                ReadDouble(message, "position"),
                ReadBool(message, "playing"),
                ReadDouble(message, "volume", 80),
                ReadBool(message, "muted"));
        }

        private static void PostCastMessage(string type, object payload)
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            string json = JsonSerializer.Serialize(payload, JsonOptions);
            PostToUi(() =>
            {
                try
                {
                    hostView?.CoreWebView2?.PostWebMessageAsJson(json);
                }
                catch (Exception)
                {
                    // The WebView may already be tearing down.
                }
            });
        }

        private static void HandleMetadataGet(JsonElement message)
        {
            string requestId = ReadString(message, "requestId") ?? Guid.NewGuid().ToString("N");
            List<string> trackIds = ReadStringArray(message, "trackIds");
            IReadOnlyList<string> roots = AppSettingsStore.ResolvedMusicFolders();
            IReadOnlyList<EditableTrackMetadata> tracks = MetadataEditor.Get(
                trackIds,
                roots,
                LookupBusy,
                LookupDisplay);

            PostMetadataMessage(new
            {
                type = "metadataResult",
                requestId,
                action = "get",
                tracks
            });
        }

        private static void HandleMetadataApply(JsonElement message)
        {
            string requestId = ReadString(message, "requestId") ?? Guid.NewGuid().ToString("N");
            if (!MetadataEditor.TryBeginApply(out string? beginError))
            {
                PostMetadataMessage(new
                {
                    type = "metadataApplied",
                    requestId,
                    failed = true,
                    errorCode = nameof(MetadataErrorCode.EditInProgress),
                    errorMessage = beginError,
                    total = 0,
                    succeeded = 0,
                    files = Array.Empty<object>()
                });
                return;
            }

            List<MetadataTrackEdit> edits = ParseTrackEdits(message);
            if (edits.Count == 0)
            {
                MetadataEditor.EndApply();
                PostMetadataMessage(new
                {
                    type = "metadataApplied",
                    requestId,
                    failed = true,
                    errorCode = nameof(MetadataErrorCode.NoChanges),
                    errorMessage = MetadataErrorMessages.For(MetadataErrorCode.NoChanges),
                    total = 0,
                    succeeded = 0,
                    files = Array.Empty<object>()
                });
                return;
            }

            IReadOnlyList<string> roots = AppSettingsStore.ResolvedMusicFolders();
            string root = artworkRoot;
            CancellationToken token = MetadataEditor.ApplyToken;
            _ = Task.Run(() =>
            {
                ScanCoordinator.BeginMetadataEditSession();
                bool editedPathsFullyPatched = false;
                try
                {
                    MetadataApplySummary summary = MetadataEditor.ApplySequential(
                        requestId,
                        edits,
                        roots,
                        trackId =>
                        {
                            (bool busy, _, MetadataErrorCode code) = LookupBusy(trackId);
                            return (busy, code);
                        },
                        (completed, total, currentTitle, succeeded, failed) =>
                        {
                            PostMetadataMessage(new
                            {
                                type = "metadataProgress",
                                requestId,
                                completed,
                                total,
                                currentTitle,
                                succeeded,
                                failed
                            });
                        },
                        token);

                    List<string> successfulIds = summary.Files
                        .Where(file => file.Succeeded && file.ErrorCode != MetadataErrorCode.NoChanges)
                        .Select(file => file.TrackId)
                        .ToList();

                    HashSet<string> artworkSuccess = new(
                        summary.Files
                            .Where(file => file.Succeeded && file.ArtworkChanged)
                            .Select(file => file.TrackId),
                        StringComparer.OrdinalIgnoreCase);

                    bool regenerateAlbumCover = false;
                    string? albumIdForCover = null;
                    MetadataArtworkOp albumCoverOp = MetadataArtworkOp.Keep;
                    byte[]? albumCoverBytes = null;
                    string? albumCoverMime = null;

                    if (successfulIds.Count > 0 && currentLibrary is not null)
                    {
                        Dictionary<string, string> trackAlbum = currentLibrary.Tracks
                            .ToDictionary(track => track.Id, track => track.AlbumId, StringComparer.OrdinalIgnoreCase);

                        HashSet<string> affectedAlbums = new(StringComparer.OrdinalIgnoreCase);
                        foreach (string id in artworkSuccess)
                        {
                            if (trackAlbum.TryGetValue(id, out string? albumId) && !string.IsNullOrWhiteSpace(albumId))
                            {
                                affectedAlbums.Add(albumId);
                            }
                        }

                        foreach (string albumId in affectedAlbums)
                        {
                            AlbumInfo? album = currentLibrary.Albums.FirstOrDefault(item =>
                                    string.Equals(item.Id, albumId, StringComparison.OrdinalIgnoreCase))
                                ?? currentLibrary.Singles.FirstOrDefault(item =>
                                    string.Equals(item.Id, albumId, StringComparison.OrdinalIgnoreCase));
                            if (album is null)
                            {
                                continue;
                            }

                            if (!AlbumArtworkCache.ShouldRegenerateAlbumCover(album.TrackIds, artworkSuccess))
                            {
                                continue;
                            }

                            MetadataTrackEdit? artEdit = edits.FirstOrDefault(edit =>
                                artworkSuccess.Contains(edit.TrackId) && edit.Artwork is not null);
                            if (artEdit?.Artwork is null)
                            {
                                continue;
                            }

                            regenerateAlbumCover = true;
                            albumIdForCover = albumId;
                            albumCoverOp = artEdit.Artwork.Op;
                            if (albumCoverOp == MetadataArtworkOp.Set
                                && !string.IsNullOrWhiteSpace(artEdit.Artwork.DataBase64))
                            {
                                try
                                {
                                    albumCoverBytes = Convert.FromBase64String(artEdit.Artwork.DataBase64);
                                    if (ArtworkImageValidator.TryValidate(
                                            albumCoverBytes,
                                            artEdit.Artwork.Mime,
                                            out albumCoverMime,
                                            out _))
                                    {
                                        break;
                                    }

                                    regenerateAlbumCover = false;
                                    albumCoverBytes = null;
                                }
                                catch (FormatException)
                                {
                                    regenerateAlbumCover = false;
                                }
                            }

                            break;
                        }

                        MusicLibrary patched = LibraryMetadataPatcher.PatchTracks(
                            currentLibrary,
                            successfulIds,
                            root,
                            regenerateAlbumCover,
                            albumIdForCover,
                            albumCoverOp,
                            albumCoverBytes,
                            albumCoverMime);

                        string fingerprint = LibraryCacheStore.ComputeFingerprint(patched);
                        PostToUi(() =>
                        {
                            currentLibrary = patched;
                            LibraryMediaIndex.Replace(patched.Locations);
                            lastDeliveredFingerprint = fingerprint;
                            lastCompleteCache = new CachedMusicLibrary
                            {
                                ContentFingerprint = fingerprint,
                                FolderPaths = roots,
                                Library = patched
                            };
                            if (LibraryCacheStore.IsCompleteScan(patched))
                            {
                                LibraryCacheStore.Save(roots, patched, fingerprint);
                            }

                            PostLibraryMessage(ToLibraryMessage(patched, fingerprint, requestId: null));
                        });

                        editedPathsFullyPatched = true;
                        summary = new MetadataApplySummary
                        {
                            RequestId = summary.RequestId,
                            Total = summary.Total,
                            Succeeded = summary.Succeeded,
                            Failed = summary.Failed,
                            Cancelled = summary.Cancelled,
                            AlbumCoverRegenerated = regenerateAlbumCover,
                            Files = summary.Files
                        };
                    }

                    PostMetadataMessage(new
                    {
                        type = "metadataApplied",
                        requestId = summary.RequestId,
                        total = summary.Total,
                        succeeded = summary.Succeeded,
                        failed = summary.Failed,
                        cancelled = summary.Cancelled,
                        albumCoverRegenerated = summary.AlbumCoverRegenerated,
                        files = summary.Files.Select(file => new
                        {
                            trackId = file.TrackId,
                            succeeded = file.Succeeded,
                            errorCode = file.ErrorCode == MetadataErrorCode.None
                                ? null
                                : file.ErrorCode.ToString(),
                            errorMessage = file.ErrorMessage,
                            artworkChanged = file.ArtworkChanged
                        })
                    });
                }
                finally
                {
                    bool needsFullScan = ScanCoordinator.EndMetadataEditSession(editedPathsFullyPatched);
                    MetadataEditor.EndApply();
                    if (needsFullScan)
                    {
                        PostToUi(() => RefreshLibrary());
                    }
                }
            });
        }

        private static (bool Busy, string? Reason, MetadataErrorCode Code) LookupBusy(string trackId)
        {
            if (!string.IsNullOrWhiteSpace(nowPlayingTrackId)
                && string.Equals(nowPlayingTrackId, trackId, StringComparison.OrdinalIgnoreCase))
            {
                return (true, "playing", MetadataErrorCode.BusyPlaying);
            }

            if (!string.IsNullOrWhiteSpace(nowPlayingNextTrackId)
                && string.Equals(nowPlayingNextTrackId, trackId, StringComparison.OrdinalIgnoreCase))
            {
                return (true, "playing", MetadataErrorCode.BusyPlaying);
            }

            IReadOnlyList<string>? castBusy = cast?.GetBusyTrackIds();
            if (castBusy is not null
                && castBusy.Any(id => string.Equals(id, trackId, StringComparison.OrdinalIgnoreCase)))
            {
                return (true, "casting", MetadataErrorCode.BusyCasting);
            }

            return (false, null, MetadataErrorCode.None);
        }

        private static TrackDisplayContext? LookupDisplay(string trackId)
        {
            MusicLibrary? library = currentLibrary ?? lastCompleteCache?.Library;
            TrackInfo? track = library?.Tracks.FirstOrDefault(item =>
                string.Equals(item.Id, trackId, StringComparison.OrdinalIgnoreCase));
            if (track is null)
            {
                return null;
            }

            AlbumInfo? album = library?.Albums.FirstOrDefault(item =>
                    string.Equals(item.Id, track.AlbumId, StringComparison.OrdinalIgnoreCase))
                ?? library?.Singles.FirstOrDefault(item =>
                    string.Equals(item.Id, track.AlbumId, StringComparison.OrdinalIgnoreCase));

            return new TrackDisplayContext
            {
                AlbumId = track.AlbumId,
                Title = track.Title,
                Artist = track.Artist,
                Album = track.Album,
                CoverUrl = track.CoverUrl,
                AlbumTrackIds = album?.TrackIds ?? []
            };
        }

        private static List<MetadataTrackEdit> ParseTrackEdits(JsonElement message)
        {
            List<MetadataTrackEdit> edits = [];
            if (!message.TryGetProperty("edits", out JsonElement editsElement)
                || editsElement.ValueKind != JsonValueKind.Array)
            {
                return edits;
            }

            foreach (JsonElement item in editsElement.EnumerateArray())
            {
                string? trackId = ReadString(item, "trackId");
                if (string.IsNullOrWhiteSpace(trackId))
                {
                    continue;
                }

                edits.Add(new MetadataTrackEdit
                {
                    TrackId = trackId,
                    ExpectedLastWriteUtcTicks = ReadOptionalInt64(item, "expectedLastWriteUtcTicks"),
                    ExpectedLength = ReadOptionalInt64(item, "expectedLength"),
                    Title = ReadFieldEdit(item, "title"),
                    Artist = ReadFieldEdit(item, "artist"),
                    AlbumArtist = ReadFieldEdit(item, "albumArtist"),
                    Album = ReadFieldEdit(item, "album"),
                    TrackNumber = ReadFieldEdit(item, "trackNumber"),
                    DiscNumber = ReadFieldEdit(item, "discNumber"),
                    Genre = ReadFieldEdit(item, "genre"),
                    Year = ReadFieldEdit(item, "year"),
                    Comment = ReadFieldEdit(item, "comment"),
                    Artwork = ReadArtworkEdit(item)
                });
            }

            return edits;
        }

        private static MetadataFieldEdit? ReadFieldEdit(JsonElement parent, string name)
        {
            if (!parent.TryGetProperty(name, out JsonElement field) || field.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            string? opText = ReadString(field, "op")?.ToLowerInvariant();
            MetadataFieldOp op = opText switch
            {
                "set" => MetadataFieldOp.Set,
                "clear" => MetadataFieldOp.Clear,
                _ => MetadataFieldOp.Keep
            };

            return new MetadataFieldEdit
            {
                Op = op,
                Value = ReadString(field, "value")
            };
        }

        private static MetadataArtworkEdit? ReadArtworkEdit(JsonElement parent)
        {
            if (!parent.TryGetProperty("artwork", out JsonElement field) || field.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            string? opText = ReadString(field, "op")?.ToLowerInvariant();
            MetadataArtworkOp op = opText switch
            {
                "set" => MetadataArtworkOp.Set,
                "clear" => MetadataArtworkOp.Clear,
                _ => MetadataArtworkOp.Keep
            };

            return new MetadataArtworkEdit
            {
                Op = op,
                Mime = ReadString(field, "mime"),
                DataBase64 = ReadString(field, "dataBase64")
            };
        }

        private static List<string> ReadStringArray(JsonElement message, string name)
        {
            List<string> values = [];
            if (!message.TryGetProperty(name, out JsonElement element) || element.ValueKind != JsonValueKind.Array)
            {
                return values;
            }

            foreach (JsonElement item in element.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                {
                    string? value = item.GetString();
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        values.Add(value);
                    }
                }
            }

            return values;
        }

        private static long? ReadOptionalInt64(JsonElement message, string name)
        {
            if (!message.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            if (value.TryGetInt64(out long number))
            {
                return number;
            }

            return null;
        }

        private static void PostMetadataMessage(object message)
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            string json = JsonSerializer.Serialize(message, JsonOptions);
            PostToUi(() =>
            {
                try
                {
                    hostView?.CoreWebView2?.PostWebMessageAsJson(json);
                }
                catch (Exception)
                {
                    // The WebView may already be tearing down.
                }
            });
        }

        private static void PostToUi(Action action)
        {
            if (hostView is null || hostView.IsDisposed)
            {
                return;
            }

            if (hostView.InvokeRequired)
            {
                hostView.BeginInvoke(action);
                return;
            }

            action();
        }

        private static string? ReadString(JsonElement message, string name)
        {
            return message.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }

        private static bool ReadBool(JsonElement message, string name)
        {
            return message.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;
        }

        private static double ReadDouble(JsonElement message, string name, double fallback = 0)
        {
            if (!message.TryGetProperty(name, out JsonElement value))
            {
                return fallback;
            }

            return value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out double number)
                ? number
                : fallback;
        }

        private static long ReadInt64(JsonElement message, string name)
        {
            if (!message.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.Number)
            {
                return 0;
            }

            if (value.TryGetInt64(out long number))
            {
                return number;
            }

            if (value.TryGetDouble(out double asDouble))
            {
                return (long)asDouble;
            }

            return 0;
        }

        private sealed class LibraryMessage
        {
            public required string Type { get; init; }

            public string? RequestId { get; init; }

            public bool Failed { get; init; }

            public string? ContentFingerprint { get; init; }

            public required string RootPath { get; init; }

            public required IReadOnlyList<LibraryFolderInfo> Folders { get; init; }

            public required IReadOnlyList<AlbumInfo> Albums { get; init; }

            public required IReadOnlyList<AlbumInfo> Singles { get; init; }

            public required IReadOnlyList<TrackInfo> Tracks { get; init; }
        }

        private sealed class AppSettingsMessage
        {
            public required string Type { get; init; }

            public required string StartupOnLogin { get; init; }

            public required bool CloseMinimizes { get; init; }

            public required bool AutomaticUpdateChecks { get; init; }

            public required string CurrentVersion { get; init; }
        }

        private sealed class WindowStateMessage
        {
            public required string Type { get; init; }

            public required bool Maximized { get; init; }
        }

        private sealed class ArtistInfoMessage
        {
            public required string Type { get; init; }

            public required string Name { get; init; }

            public IReadOnlyList<string> Genres { get; init; } = [];

            public string? OriginLabel { get; init; }

            public string? BeginYear { get; init; }

            public string? Area { get; init; }
        }

        private sealed class StorageMessage
        {
            public required string Type { get; init; }

            public required long LibraryBytes { get; init; }

            public required long CacheBytes { get; init; }
        }

        private sealed class LyricsMessage
        {
            public string Type { get; init; } = "lyrics";

            public required string TrackId { get; init; }

            public bool Available { get; init; }

            public bool Synced { get; init; }

            public string? SyncedLyrics { get; init; }

            public string? PlainLyrics { get; init; }

            public bool Instrumental { get; init; }

            public bool Retryable { get; init; }

            public static LyricsMessage Unavailable(string trackId, bool retryable) => new()
            {
                TrackId = trackId,
                Retryable = retryable
            };

            public static LyricsMessage From(string trackId, LyricsResult result)
            {
                if (result.Status != LyricsStatus.Found)
                {
                    return Unavailable(trackId, retryable: result.Status == LyricsStatus.Failed);
                }

                return new LyricsMessage
                {
                    TrackId = trackId,
                    Available = true,
                    Synced = result.SyncedLyrics is not null,
                    SyncedLyrics = result.SyncedLyrics,
                    PlainLyrics = result.PlainLyrics,
                    Instrumental = result.Instrumental
                };
            }
        }
    }
}
