using System.Diagnostics;
using System.Net;
using Sharpcaster;
using Sharpcaster.Models;
using Sharpcaster.Models.Media;

namespace EMP.Cast.Google
{
    internal sealed class GoogleCastSession : IRemotePlaybackSession
    {
        private readonly ChromecastReceiver receiver;
        private readonly ChromecastClient client = new();
        private bool connected;
        private bool loadFailed;
        private bool disposed;

        public GoogleCastSession(PlaybackDevice device, ChromecastReceiver receiver)
        {
            Device = device;
            this.receiver = receiver;
            client.Disconnected += (_, _) =>
            {
                connected = false;
                Disconnected?.Invoke();
            };
            client.MediaChannel.StatusChanged += (_, _) =>
            {
                RemotePlaybackStatus status = ReadStatus();
                if (status.Error)
                {
                    loadFailed = true;
                }

                StatusChanged?.Invoke(status);
            };
            client.MediaChannel.LoadFailed += (_, _) =>
            {
                loadFailed = true;
                StatusChanged?.Invoke(new RemotePlaybackStatus { Error = true, FormatError = true });
            };
        }

        public PlaybackDevice Device { get; }

        public bool SupportsSeek => true;

        public bool SupportsVolume => true;

        public event Action<RemotePlaybackStatus>? StatusChanged;

        public event Action? Disconnected;

        public bool CanPlay(string mime, string extension)
        {
            return MediaTypes.IsCastAudio(extension);
        }

        public async Task ConnectAsync(CancellationToken cancellationToken)
        {
            await client.ConnectChromecast(receiver).WaitAsync(cancellationToken);
            await client.LaunchApplicationAsync("CC1AD845").WaitAsync(cancellationToken);
            connected = true;
        }

        public async Task LoadAsync(RemoteMedia media, double position, bool play, CancellationToken cancellationToken)
        {
            loadFailed = false;
            if (!CanPlay(media.Mime, media.Extension))
            {
                throw new FormatNotSupportedException();
            }

            MusicTrackMetadata metadata = new()
            {
                Title = media.Title,
                Artist = media.Artist,
                AlbumName = media.Album
            };
            if (!string.IsNullOrWhiteSpace(media.ArtworkUrl))
            {
                metadata.Images = [new Sharpcaster.Models.Media.Image { Url = media.ArtworkUrl }];
            }

            Media payload = new()
            {
                ContentId = media.Url,
                ContentUrl = media.Url,
                ContentType = media.Mime,
                StreamType = StreamType.Buffered,
                Duration = media.Duration > 0 ? media.Duration : null,
                Metadata = metadata
            };

            MediaStatus? status = await client.MediaChannel.LoadAsync(payload, play).WaitAsync(cancellationToken);
            if (loadFailed)
            {
                throw new FormatNotSupportedException();
            }

            if (position > 0.5)
            {
                try
                {
                    await client.MediaChannel.SeekAsync(position).WaitAsync(cancellationToken);
                    if (!play)
                    {
                        await client.MediaChannel.PauseAsync().WaitAsync(cancellationToken);
                    }
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"EMP Cast seek on load: {ex.Message}");
                }
            }

            if (status is not null)
            {
                StatusChanged?.Invoke(FromMedia(status));
            }
        }

        public Task SetNextMediaAsync(RemoteMedia? media, CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }

        public Task PlayAsync(CancellationToken cancellationToken)
        {
            return client.MediaChannel.PlayAsync().WaitAsync(cancellationToken);
        }

        public Task PauseAsync(CancellationToken cancellationToken)
        {
            return client.MediaChannel.PauseAsync().WaitAsync(cancellationToken);
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            return client.MediaChannel.StopAsync().WaitAsync(cancellationToken);
        }

        public Task SeekAsync(double position, CancellationToken cancellationToken)
        {
            return client.MediaChannel.SeekAsync(position).WaitAsync(cancellationToken);
        }

        public async Task SetVolumeAsync(double level, bool muted, CancellationToken cancellationToken)
        {
            await client.ReceiverChannel.SetVolume(Math.Clamp(level, 0, 1)).WaitAsync(cancellationToken);
            await client.ReceiverChannel.SetMute(muted).WaitAsync(cancellationToken);
        }

        public Task<RemotePlaybackStatus> GetStatusAsync(CancellationToken cancellationToken)
        {
            return Task.FromResult(ReadStatus());
        }

        public async ValueTask DisposeAsync()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            try
            {
                if (connected)
                {
                    await client.MediaChannel.StopAsync();
                }
            }
            catch (Exception)
            {
                // Best-effort stop.
            }

            try
            {
                if (client is IDisposable disposable)
                {
                    disposable.Dispose();
                }
            }
            catch (Exception)
            {
                // Ignore dispose races.
            }
        }

        private RemotePlaybackStatus ReadStatus()
        {
            MediaStatus? media = client.MediaChannel.MediaStatus;
            Volume? volume = client.ReceiverChannel.ReceiverStatus?.Volume;
            return FromMedia(media, volume);
        }

        private static RemotePlaybackStatus FromMedia(MediaStatus? media, Volume? volume = null)
        {
            PlayerStateType state = media?.PlayerState ?? PlayerStateType.Idle;
            bool playing = state is PlayerStateType.Playing or PlayerStateType.Buffering;
            bool ended = state == PlayerStateType.Idle
                && string.Equals(media?.IdleReason?.ToString(), "FINISHED", StringComparison.OrdinalIgnoreCase)
                && (media?.CurrentTime ?? 0) > 1;
            bool error = state == PlayerStateType.Idle
                && string.Equals(media?.IdleReason?.ToString(), "ERROR", StringComparison.OrdinalIgnoreCase);
            return new RemotePlaybackStatus
            {
                Playing = playing,
                Ended = ended,
                Error = error,
                FormatError = error,
                Position = media?.CurrentTime ?? 0,
                Duration = media?.Media?.Duration ?? 0,
                Volume = volume?.Level ?? 0.8,
                Muted = volume?.Muted ?? false
            };
        }
    }
}
