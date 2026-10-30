using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using EMP.UpdateCore;
using Microsoft.Web.WebView2.WinForms;

namespace EMP.Hosting
{
    internal static class UpdateCoordinator
    {
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        private static readonly object Gate = new();
        private static CancellationTokenSource? checkCts;
        private static WebView2? hostView;
        private static IReleaseProvider? providerOverride;
        private static UpdatePaths? pathsOverride;
        private static AvailableUpdate? available;
        private static string? pendingPackagePath;
        private static string state = "idle";
        private static string? error;
        private static double? progress;
        private static Action? requestRestartAndExit;

        public static void Initialize(WebView2 webView, Action requestRestartAndExitCallback)
        {
            hostView = webView;
            requestRestartAndExit = requestRestartAndExitCallback;
            PostStatus();
        }

        public static void ConfigureForTests(IReleaseProvider provider, UpdatePaths paths)
        {
            providerOverride = provider;
            pathsOverride = paths;
        }

        public static void PostStatus()
        {
            WebView2? view = hostView;
            if (view is null)
            {
                return;
            }

            if (view.InvokeRequired)
            {
                try
                {
                    view.BeginInvoke(PostStatus);
                }
                catch (ObjectDisposedException)
                {
                    // WebView is shutting down.
                }

                return;
            }

            if (view.CoreWebView2 is null)
            {
                return;
            }

            UpdateStatusMessage message;
            lock (Gate)
            {
                message = new UpdateStatusMessage
                {
                    Type = "updateStatus",
                    State = state,
                    CurrentVersion = AppVersion.Current,
                    AvailableVersion = available?.AvailableVersion,
                    Progress = progress,
                    Error = error,
                    AutomaticUpdateChecks = AppSettingsStore.Current.AutomaticUpdateChecks
                };
            }

            view.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
        }

        public static void HandleMessage(JsonElement message)
        {
            string? action = message.TryGetProperty("action", out JsonElement actionElement)
                ? actionElement.GetString()
                : null;

            switch (action)
            {
                case "status":
                    PostStatus();
                    break;
                case "check":
                    _ = CheckAsync(silent: false);
                    break;
                case "download":
                    _ = DownloadAsync();
                    break;
                case "restartAndUpdate":
                    RestartAndUpdate();
                    break;
                case "dismiss":
                    lock (Gate)
                    {
                        if (state is "updateAvailable" or "ready" or "failed")
                        {
                            state = available is null ? "idle" : "updateAvailable";
                            error = null;
                        }
                    }

                    PostStatus();
                    break;
                case "setAutomatic":
                    bool enabled = message.TryGetProperty("enabled", out JsonElement enabledElement)
                        && enabledElement.ValueKind == JsonValueKind.True;
                    AppSettings settings = AppSettingsStore.Current;
                    AppSettingsStore.Save(new AppSettings
                    {
                        StartupOnLogin = settings.StartupOnLogin,
                        CloseMinimizes = settings.CloseMinimizes,
                        MusicFolders = settings.MusicFolders is null ? null : [.. settings.MusicFolders],
                        AutomaticUpdateChecks = enabled,
                        LastUpdateCheckUtc = settings.LastUpdateCheckUtc
                    });
                    PostStatus();
                    break;
            }
        }

        public static async Task MaybeBackgroundCheckAsync()
        {
            if (!AppSettingsStore.Current.AutomaticUpdateChecks)
            {
                return;
            }

            DateTimeOffset? last = AppSettingsStore.Current.LastUpdateCheckUtc;
            if (last is not null && DateTimeOffset.UtcNow - last < TimeSpan.FromHours(24))
            {
                return;
            }

            await CheckAsync(silent: true).ConfigureAwait(false);
        }

        public static async Task CheckAsync(bool silent)
        {
            CancellationTokenSource cts = new();
            lock (Gate)
            {
                checkCts?.Cancel();
                checkCts = cts;
                if (!silent)
                {
                    state = "checking";
                    error = null;
                }
            }

            if (!silent)
            {
                PostStatus();
            }

            try
            {
                IReleaseProvider provider = CreateProvider();
                try
                {
                UpdatePaths paths = pathsOverride ?? UpdatePaths.DefaultLocalAppData();
                UpdateDownloader downloader = new(provider, paths);
                AvailableUpdate? update = await downloader.CheckForUpdateAsync(AppVersion.Current, cts.Token)
                    .ConfigureAwait(false);

                AppSettings settings = AppSettingsStore.Current;
                AppSettingsStore.Save(new AppSettings
                {
                    StartupOnLogin = settings.StartupOnLogin,
                    CloseMinimizes = settings.CloseMinimizes,
                    MusicFolders = settings.MusicFolders is null ? null : [.. settings.MusicFolders],
                    AutomaticUpdateChecks = settings.AutomaticUpdateChecks,
                    LastUpdateCheckUtc = DateTimeOffset.UtcNow
                });

                lock (Gate)
                {
                    available = update;
                    if (update is null)
                    {
                        state = "upToDate";
                        pendingPackagePath = null;
                    }
                    else if (pendingPackagePath is not null
                        && File.Exists(pendingPackagePath)
                        && pendingPackagePath.Contains(update.AvailableVersion, StringComparison.OrdinalIgnoreCase))
                    {
                        state = "ready";
                    }
                    else
                    {
                        state = "updateAvailable";
                    }

                    error = null;
                }

                PostStatus();
                }
                finally
                {
                    (provider as IDisposable)?.Dispose();
                }
            }
            catch (Exception ex) when (silent)
            {
                Debug.WriteLine("EMP background update check failed: " + ex.Message);
            }
            catch (Exception ex)
            {
                lock (Gate)
                {
                    state = "failed";
                    error = FriendlyError(ex);
                }

                PostStatus();
            }
        }

        private static async Task DownloadAsync()
        {
            AvailableUpdate? update;
            lock (Gate)
            {
                update = available;
                if (update is null)
                {
                    state = "failed";
                    error = "No update is available to download.";
                }
                else
                {
                    state = "downloading";
                    progress = 0;
                    error = null;
                }
            }

            PostStatus();
            if (update is null)
            {
                return;
            }

            try
            {
                IReleaseProvider provider = CreateProvider();
                try
                {
                    UpdatePaths paths = pathsOverride ?? UpdatePaths.DefaultLocalAppData();
                    UpdateDownloader downloader = new(provider, paths);
                    Progress<UpdateDownloadProgress> progressReporter = new(p =>
                    {
                        lock (Gate)
                        {
                            progress = p.Fraction;
                        }

                        PostStatus();
                    });

                    string package = await downloader.DownloadAndVerifyAsync(update.Release, progressReporter)
                        .ConfigureAwait(false);
                    lock (Gate)
                    {
                        pendingPackagePath = package;
                        state = "ready";
                        progress = 1;
                        error = null;
                    }

                    PostStatus();
                }
                finally
                {
                    (provider as IDisposable)?.Dispose();
                }
            }
            catch (Exception ex)
            {
                lock (Gate)
                {
                    state = "failed";
                    error = FriendlyError(ex);
                    progress = null;
                }

                PostStatus();
            }
        }

        private static void RestartAndUpdate()
        {
            string? package;
            AvailableUpdate? update;
            lock (Gate)
            {
                package = pendingPackagePath;
                update = available;
                if (package is null || update is null || !File.Exists(package))
                {
                    state = "failed";
                    error = "Verified update package was not found. Download the update again.";
                    PostStatus();
                    return;
                }

                state = "installing";
            }

            PostStatus();

            try
            {
                string installDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string updaterSource = Path.Combine(installDir, "EMP.Updater.exe");
                if (!File.Exists(updaterSource))
                {
                    throw new FileNotFoundException("EMP.Updater.exe was not found beside EMP.exe.", updaterSource);
                }

                string workRoot = UpdatePaths.PreferSameVolumeWorkRoot(installDir);
                string tempDir = Path.Combine(workRoot, "updater-run-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(tempDir);
                string updaterTemp = Path.Combine(tempDir, "EMP.Updater.exe");
                File.Copy(updaterSource, updaterTemp, overwrite: true);

                UpdatePaths paths = pathsOverride ?? UpdatePaths.DefaultLocalAppData();
                paths.EnsureCreated();

                string args =
                    $"--install-dir \"{installDir}\" " +
                    $"--package \"{package}\" " +
                    $"--expected-version \"{update.AvailableVersion}\" " +
                    $"--pid {Environment.ProcessId} " +
                    $"--updates-root \"{paths.UpdatesRoot}\" " +
                    "--relaunch";

                Process.Start(new ProcessStartInfo
                {
                    FileName = updaterTemp,
                    Arguments = args,
                    WorkingDirectory = tempDir,
                    UseShellExecute = false
                });

                requestRestartAndExit?.Invoke();
            }
            catch (Exception ex)
            {
                lock (Gate)
                {
                    state = "failed";
                    error = FriendlyError(ex);
                }

                PostStatus();
            }
        }

        private static IReleaseProvider CreateProvider()
        {
            if (providerOverride is not null)
            {
                return providerOverride;
            }

            return new GitHubReleaseProvider(AppVersion.Current);
        }

        private static string FriendlyError(Exception ex) => ex switch
        {
            UpdateRateLimitException => "Couldn't check for updates right now. Try again later.",
            UpdateNotFoundException => "No update is available right now.",
            UpdateVerificationException => "The download couldn't be verified. Try again later.",
            UpdatePackageException => "The update package looks incomplete. Try again later.",
            HttpRequestException => "Couldn't reach the update server. Check your connection and try again.",
            TaskCanceledException => "The update check timed out. Try again later.",
            UnauthorizedAccessException => "EMP couldn't update this folder. Try moving EMP to a folder you can write to.",
            _ => "Couldn't check for updates. Try again later."
        };

        private sealed class UpdateStatusMessage
        {
            public required string Type { get; init; }

            public required string State { get; init; }

            public required string CurrentVersion { get; init; }

            public string? AvailableVersion { get; init; }

            public double? Progress { get; init; }

            public string? Error { get; init; }

            public bool AutomaticUpdateChecks { get; init; }
        }
    }
}
