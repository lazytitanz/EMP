using System.Text.Json;
using System.Text.Json.Serialization;
using EMP.Library;
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
        private static WebView2? hostView;
        private static string artworkRoot = string.Empty;
        private static bool pageLoaded;

        public static event Action<bool>? PlayingChanged;

        public static async Task InitializeAsync(WebView2 webView)
        {
            ArgumentNullException.ThrowIfNull(webView);

            if (!Directory.Exists(WwwRootPath))
            {
                throw new DirectoryNotFoundException(
                    $"The UI folder was not found at '{WwwRootPath}'.");
            }

            Directory.CreateDirectory(UserDataFolder);

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
            SyncVirtualHosts(AppSettingsStore.ResolvedMusicFolders());

            CoreWebView2Settings settings = webView.CoreWebView2.Settings;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsWebMessageEnabled = true;

            try
            {
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

            await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                """
                window.__emp = window.__emp || { library: null };
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
                  if (message.type === 'appSettings') {
                    window.dispatchEvent(new CustomEvent('emp-app-settings', { detail: message }));
                  }
                });
                """);

            webView.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                if (args.IsSuccess)
                {
                    pageLoaded = true;
                    RefreshLibrary();
                    PostAppSettings();
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
                    else if (kind == "appSettings")
                    {
                        HandleAppSettings(document.RootElement);
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
            folderWatchers?.Dispose();
            folderWatchers = null;
            systemMedia?.Dispose();
            systemMedia = null;
            hostView = null;
            pageLoaded = false;
            MappedHosts.Clear();
            RetainedHosts.Clear();
            ActiveMediaHosts.Clear();
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

            PostLibrary(folders, requestId);
        }

        private static void PostLibrary(IReadOnlyList<string> folders, string? requestId = null)
        {
            if (hostView?.CoreWebView2 is null)
            {
                return;
            }

            LibraryMessage message;
            try
            {
                MusicLibrary library = MusicLibraryScanner.Scan(folders, artworkRoot);
                message = new LibraryMessage
                {
                    Type = "library",
                    RequestId = requestId,
                    RootPath = library.RootPath,
                    Folders = library.Folders,
                    Albums = library.Albums,
                    Singles = library.Singles,
                    Tracks = library.Tracks
                };
            }
            catch (Exception)
            {
                if (requestId is null)
                {
                    return;
                }

                // Let a user-initiated rescan settle instead of spinning forever.
                message = new LibraryMessage
                {
                    Type = "library",
                    RequestId = requestId,
                    Failed = true,
                    RootPath = string.Empty,
                    Folders = [],
                    Albums = [],
                    Singles = [],
                    Tracks = []
                };
            }

            hostView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
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
                CloseMinimizes = settings.CloseMinimizes
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
                profile = new MusicBrainzClient.ArtistProfile { Name = name };
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

        private static void HandleAppSettings(JsonElement message)
        {
            string startupOnLogin = ReadString(message, "startupOnLogin") ?? AppSettingsStore.Current.StartupOnLogin;
            bool closeMinimizes = AppSettingsStore.Current.CloseMinimizes;
            if (message.TryGetProperty("closeMinimizes", out JsonElement closeElement))
            {
                closeMinimizes = closeElement.ValueKind == JsonValueKind.True;
            }

            AppSettingsStore.Save(new AppSettings
            {
                StartupOnLogin = startupOnLogin,
                CloseMinimizes = closeMinimizes,
                MusicFolders = AppSettingsStore.Current.MusicFolders is null
                    ? null
                    : [.. AppSettingsStore.Current.MusicFolders]
            });
        }

        private static void HandleNowPlaying(JsonElement message)
        {
            string? title = ReadString(message, "title");
            string? artist = ReadString(message, "artist");
            string? album = ReadString(message, "album");
            string? coverUrl = ReadString(message, "coverUrl");
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

        private sealed class LibraryMessage
        {
            public required string Type { get; init; }

            public string? RequestId { get; init; }

            public bool Failed { get; init; }

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
    }
}
