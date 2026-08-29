using Microsoft.Web.WebView2.WinForms;
using Windows.Media;
using Windows.Media.Playback;
using Windows.Storage;
using Windows.Storage.Streams;

namespace EMP.Hosting
{
    internal sealed class SystemMediaControls : IDisposable
    {
        private readonly WebView2 webView;
        private readonly MediaPlayer mediaPlayer;
        private readonly SystemMediaTransportControls transport;
        private bool disposed;

        public SystemMediaControls(WebView2 webView)
        {
            ArgumentNullException.ThrowIfNull(webView);

            this.webView = webView;
            mediaPlayer = new MediaPlayer();
            mediaPlayer.CommandManager.IsEnabled = false;

            transport = mediaPlayer.SystemMediaTransportControls;
            transport.IsEnabled = true;
            transport.IsPlayEnabled = true;
            transport.IsPauseEnabled = true;
            transport.IsNextEnabled = true;
            transport.IsPreviousEnabled = true;
            transport.ButtonPressed += OnButtonPressed;
        }

        public async Task UpdateAsync(string? title, string? artist, string? album, bool playing, string? coverUrl)
        {
            if (disposed)
            {
                return;
            }

            try
            {
                bool hasTrack = !string.IsNullOrWhiteSpace(title);
                transport.PlaybackStatus = !hasTrack
                    ? MediaPlaybackStatus.Closed
                    : playing ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;

                SystemMediaTransportControlsDisplayUpdater updater = transport.DisplayUpdater;
                updater.Type = MediaPlaybackType.Music;
                updater.MusicProperties.Title = string.IsNullOrWhiteSpace(title) ? "EMP" : title;
                updater.MusicProperties.Artist = artist ?? string.Empty;
                updater.MusicProperties.AlbumTitle = album ?? string.Empty;
                updater.Thumbnail = null;

                string? coverPath = ResolveCoverPath(coverUrl);
                if (coverPath is not null)
                {
                    StorageFile file = await StorageFile.GetFileFromPathAsync(coverPath);
                    updater.Thumbnail = RandomAccessStreamReference.CreateFromFile(file);
                }

                updater.Update();
            }
            catch (Exception)
            {
                try
                {
                    transport.DisplayUpdater.Update();
                }
                catch (Exception)
                {
                    // SMTC is best-effort; playback continues without the overlay.
                }
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            transport.ButtonPressed -= OnButtonPressed;
            mediaPlayer.Dispose();
        }

        private void OnButtonPressed(
            SystemMediaTransportControls sender,
            SystemMediaTransportControlsButtonPressedEventArgs args)
        {
            string command = args.Button switch
            {
                SystemMediaTransportControlsButton.Play => "play",
                SystemMediaTransportControlsButton.Pause => "pause",
                SystemMediaTransportControlsButton.Next => "next",
                SystemMediaTransportControlsButton.Previous => "previous",
                _ => string.Empty
            };

            if (command.Length == 0)
            {
                return;
            }

            void Dispatch() => _ = SendCommandAsync(command);

            if (webView.IsHandleCreated && webView.InvokeRequired)
            {
                webView.BeginInvoke(Dispatch);
            }
            else
            {
                Dispatch();
            }
        }

        private async Task SendCommandAsync(string command)
        {
            if (webView.CoreWebView2 is null || disposed)
            {
                return;
            }

            try
            {
                await webView.ExecuteScriptAsync(
                    $"window.empMediaCommand && window.empMediaCommand('{command}');");
            }
            catch (Exception)
            {
                // The WebView may already be tearing down.
            }
        }

        private static string? ResolveCoverPath(string? coverUrl)
        {
            if (string.IsNullOrWhiteSpace(coverUrl))
            {
                return null;
            }

            string relative = coverUrl
                .Replace('/', Path.DirectorySeparatorChar)
                .TrimStart(Path.DirectorySeparatorChar);

            if (relative.Contains("..", StringComparison.Ordinal))
            {
                return null;
            }

            string root = Path.GetFullPath(WebUiHost.WwwRootPath);
            string fullPath = Path.GetFullPath(Path.Combine(root, relative));
            if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
            {
                return null;
            }

            return fullPath;
        }
    }
}
