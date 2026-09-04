using System.Diagnostics;
using System.Net;
using EMP.Library;

namespace EMP.Cast
{
    internal sealed class CastCoordinator : IDisposable
    {
        private const int PollFailureLimit = 3;

        private readonly DeviceBroker broker = new();
        private readonly LanMediaServer server = new();
        private readonly object gate = new();
        private readonly Action<string, object> post;
        private IRemotePlaybackSession? session;
        private string? activeDeviceId;
        private string? connectingDeviceId;
        private string? currentTrackId;
        private string? nextTrackId;
        private bool discoveryHeld;
        private bool disposed;
        private CancellationTokenSource? operation;
        private PeriodicTimer? statusTimer;
        private CancellationTokenSource? statusLoop;
        private bool endedNotified;
        private int pollFailures;
        private int pollBusy;
        private int leaving;

        public CastCoordinator(Action<string, object> post)
        {
            this.post = post;
            devicesChanged = PostDevices;
            broker.Changed += devicesChanged;
            broker.DeviceLeft += OnDeviceLeft;
        }

        private readonly Action devicesChanged;

        public void SetDiscoveryEnabled(bool enabled)
        {
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (enabled)
                {
                    discoveryHeld = true;
                    broker.Start();
                }
                else
                {
                    discoveryHeld = false;
                    if (session is null && connectingDeviceId is null)
                    {
                        broker.Stop();
                    }
                }
            }

            PostDevices();
        }

        public void Select(string? deviceId, string? trackId, string? nextId, double position, bool playing, double volume, bool muted)
        {
            nextTrackId = nextId;
            _ = SelectAsync(deviceId, trackId, position, playing, volume, muted);
        }

        public void Command(string? action, string? trackId, string? nextId, double position, bool playing, double volume, bool muted)
        {
            if (!string.IsNullOrWhiteSpace(nextId))
            {
                nextTrackId = nextId;
            }

            _ = CommandAsync(action, trackId, position, playing, volume, muted);
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            broker.Changed -= devicesChanged;
            broker.DeviceLeft -= OnDeviceLeft;
            CancelOperation();
            StopStatusLoop();
            IRemotePlaybackSession? closing = session;
            session = null;
            if (closing is not null)
            {
                closing.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(2));
            }

            server.Dispose();
            broker.Dispose();
        }

        private async Task SelectAsync(string? deviceId, string? trackId, double position, bool playing, double volume, bool muted)
        {
            CancelOperation();
            CancellationTokenSource cts = new();
            operation = cts;
            CancellationToken cancellationToken = cts.Token;
            IRemotePlaybackSession? created = null;
            try
            {
                if (string.IsNullOrWhiteSpace(deviceId) || deviceId == "local")
                {
                    await ReturnLocalAsync();
                    return;
                }

                PlaybackDevice? device = broker.Find(deviceId);
                created = broker.CreateSession(deviceId);
                if (device is null || created is null)
                {
                    PostError("connect", "Couldn't connect to that device.", deviceId, true);
                    await ReturnLocalAsync();
                    return;
                }

                connectingDeviceId = deviceId;
                endedNotified = false;
                pollFailures = 0;
                broker.Start();
                PostStatus("connecting", deviceId, trackId, playing, position, 0, volume, false, false);
                PostDevices();

                server.Start();
                currentTrackId = trackId;
                server.Permit(trackId, nextTrackId);
                LibraryMediaIndex.Retain(new[] { trackId, nextTrackId }.OfType<string>());

                using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(20));

                await created.ConnectAsync(timeout.Token);

                IRemotePlaybackSession? previous = session;
                session = created;
                created.StatusChanged += OnSessionStatus;
                created.Disconnected += OnSessionDisconnected;
                if (previous is not null)
                {
                    previous.StatusChanged -= OnSessionStatus;
                    previous.Disconnected -= OnSessionDisconnected;
                    await previous.DisposeAsync();
                }

                if (!string.IsNullOrWhiteSpace(trackId) && LibraryMediaIndex.TryGet(trackId, out LibraryMediaLocation location))
                {
                    RemoteMedia media = BuildMedia(device.Address, location);
                    if (!created.CanPlay(media.Mime, media.Extension))
                    {
                        throw new FormatNotSupportedException();
                    }

                    await created.SetVolumeAsync(Math.Clamp(volume / 100.0, 0, 1), muted, timeout.Token);
                    await created.LoadAsync(media, position, playing, timeout.Token);
                    await PrepareNextAsync(created, timeout.Token);
                    PostStatus("connected", deviceId, trackId, playing, position, location.Duration, volume, created.SupportsVolume, false);
                }
                else
                {
                    await created.SetVolumeAsync(Math.Clamp(volume / 100.0, 0, 1), muted, timeout.Token);
                    PostStatus("connected", deviceId, trackId, false, 0, 0, volume, created.SupportsVolume, false);
                }

                activeDeviceId = deviceId;
                connectingDeviceId = null;
                Interlocked.Exchange(ref leaving, 0);
                StartStatusLoop();
                PostDevices();
                return;
            }
            catch (FormatNotSupportedException)
            {
                if (!ReferenceEquals(session, created) && created is not null)
                {
                    await created.DisposeAsync();
                }

                await FailAsync(deviceId, "format", "This device can't play this audio format.");
            }
            catch (Exception ex)
            {
                if (!ReferenceEquals(session, created) && created is not null)
                {
                    try
                    {
                        await created.DisposeAsync();
                    }
                    catch (Exception)
                    {
                        // Ignore.
                    }
                }

                Debug.WriteLine($"EMP cast select: {ex.Message}");
                string name = broker.Find(deviceId ?? string.Empty)?.Name ?? "that device";
                await FailAsync(deviceId, "connect", $"Couldn't connect to {name}.");
            }
        }

        private async Task CommandAsync(string? action, string? trackId, double position, bool playing, double volume, bool muted)
        {
            IRemotePlaybackSession? current = session;
            string? deviceId = activeDeviceId;
            if (current is null || deviceId is null)
            {
                return;
            }

            try
            {
                switch (action)
                {
                    case "play":
                        await current.PlayAsync(CancellationToken.None);
                        break;
                    case "pause":
                        await current.PauseAsync(CancellationToken.None);
                        break;
                    case "stop":
                        await current.StopAsync(CancellationToken.None);
                        break;
                    case "seek":
                        await current.SeekAsync(position, CancellationToken.None);
                        break;
                    case "volume":
                        await current.SetVolumeAsync(Math.Clamp(volume / 100.0, 0, 1), muted, CancellationToken.None);
                        break;
                    case "load":
                        await LoadTrackAsync(current, deviceId, trackId, position, playing, volume, muted);
                        break;
                    case "sync":
                        await SyncTrackAsync(current, trackId);
                        break;
                    default:
                        break;
                }
            }
            catch (FormatNotSupportedException)
            {
                PostError("format", "This device can't play this audio format.", deviceId, true);
                await ReturnLocalAsync();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"EMP cast command {action}: {ex.Message}");
                if (action is "play" or "load")
                {
                    await LoseSessionAsync($"Connection to {current.Device.Name} was lost");
                }
            }
        }

        private async Task LoadTrackAsync(
            IRemotePlaybackSession current,
            string deviceId,
            string? trackId,
            double position,
            bool playing,
            double volume,
            bool muted)
        {
            if (string.IsNullOrWhiteSpace(trackId) || !LibraryMediaIndex.TryGet(trackId, out LibraryMediaLocation location))
            {
                return;
            }

            endedNotified = false;
            currentTrackId = trackId;
            server.Permit(trackId, nextTrackId);
            RemoteMedia media = BuildMedia(current.Device.Address, location);
            if (!current.CanPlay(media.Mime, media.Extension))
            {
                throw new FormatNotSupportedException();
            }

            await current.LoadAsync(media, position, playing, CancellationToken.None);
            await PrepareNextAsync(current, CancellationToken.None);
            PostStatus("connected", deviceId, trackId, playing, position, location.Duration, volume, current.SupportsVolume, false);
        }

        private async Task SyncTrackAsync(IRemotePlaybackSession current, string? trackId)
        {
            if (!string.IsNullOrWhiteSpace(trackId))
            {
                currentTrackId = trackId;
            }

            endedNotified = false;
            server.Permit(currentTrackId, nextTrackId);
            LibraryMediaIndex.Retain(new[] { currentTrackId, nextTrackId }.OfType<string>());
            await PrepareNextAsync(current, CancellationToken.None);
        }

        private async Task PrepareNextAsync(IRemotePlaybackSession current, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(nextTrackId)
                || string.Equals(nextTrackId, currentTrackId, StringComparison.OrdinalIgnoreCase)
                || !LibraryMediaIndex.TryGet(nextTrackId, out LibraryMediaLocation location))
            {
                await current.SetNextMediaAsync(null, cancellationToken);
                return;
            }

            await current.SetNextMediaAsync(BuildMedia(current.Device.Address, location), cancellationToken);
        }

        private RemoteMedia BuildMedia(IPAddress? address, LibraryMediaLocation location)
        {
            string? url = server.MediaUrl(address, location.TrackId);
            if (string.IsNullOrWhiteSpace(url))
            {
                throw new InvalidOperationException("Media URL is unavailable.");
            }

            return new RemoteMedia
            {
                TrackId = location.TrackId,
                Url = url,
                Mime = MediaTypes.FromPath(location.FullPath),
                Extension = Path.GetExtension(location.FullPath),
                Title = location.Title,
                Artist = location.Artist,
                Album = location.Album,
                ArtworkUrl = server.ArtworkUrl(address, location.TrackId),
                Duration = location.Duration
            };
        }

        private async Task FailAsync(string? deviceId, string code, string message)
        {
            PostError(code, message, deviceId ?? string.Empty, true);
            await ReturnLocalAsync();
        }

        private async Task LoseSessionAsync(string message)
        {
            if (Interlocked.CompareExchange(ref leaving, 1, 0) != 0)
            {
                return;
            }

            try
            {
                string? deviceId = activeDeviceId;
                if (deviceId is null && session is null)
                {
                    return;
                }

                broker.MarkUnavailable(deviceId);
                PostError("lost", message, deviceId ?? string.Empty, true);
                await ReturnLocalAsync();
            }
            finally
            {
                Interlocked.Exchange(ref leaving, 0);
            }
        }

        private async Task ReturnLocalAsync()
        {
            StopStatusLoop();
            pollFailures = 0;
            connectingDeviceId = null;
            activeDeviceId = null;
            IRemotePlaybackSession? closing = session;
            session = null;
            if (closing is not null)
            {
                closing.StatusChanged -= OnSessionStatus;
                closing.Disconnected -= OnSessionDisconnected;
                try
                {
                    await closing.DisposeAsync();
                }
                catch (Exception)
                {
                    // Ignore.
                }
            }

            await server.StopAsync();
            if (!discoveryHeld)
            {
                broker.Stop();
            }

            PostStatus("local", "local", currentTrackId, false, 0, 0, 80, false, false);
            PostDevices();
        }

        private void OnDeviceLeft(string deviceId)
        {
            if (!string.Equals(deviceId, activeDeviceId, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            string name = session?.Device.Name ?? broker.Find(deviceId)?.Name ?? "the device";
            Debug.WriteLine($"EMP DLNA: ssdp:byebye for active device {deviceId}");
            _ = LoseSessionAsync($"Connection to {name} was lost");
        }

        private void OnSessionStatus(RemotePlaybackStatus status)
        {
            string? deviceId = activeDeviceId;
            if (deviceId is null)
            {
                return;
            }

            if (status.FormatError || status.Error)
            {
                string code = status.FormatError ? "format" : "lost";
                string message = status.FormatError
                    ? "This device can't play this audio format."
                    : $"Connection to {session?.Device.Name ?? "the device"} was lost";
                if (status.FormatError)
                {
                    PostError(code, message, deviceId, true);
                    _ = ReturnLocalAsync();
                }
                else
                {
                    _ = LoseSessionAsync(message);
                }

                return;
            }

            pollFailures = 0;
            string? skip = status.Skip;
            if (string.Equals(skip, "applied", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(status.AppliedTrackId))
            {
                currentTrackId = status.AppliedTrackId;
                endedNotified = false;
            }

            bool ended = status.Ended && !endedNotified && status.Position > 1 && string.IsNullOrWhiteSpace(skip);
            if (ended || skip is "next" or "previous")
            {
                endedNotified = true;
            }

            PostStatus(
                "connected",
                deviceId,
                currentTrackId,
                status.Playing,
                status.Position,
                ResolveDuration(status.Duration),
                status.Volume * 100,
                session?.SupportsVolume == true,
                ended,
                skip);
        }

        private double ResolveDuration(double reported)
        {
            if (!string.IsNullOrWhiteSpace(currentTrackId)
                && LibraryMediaIndex.TryGet(currentTrackId, out LibraryMediaLocation location)
                && location.Duration > 1)
            {
                return location.Duration;
            }

            return reported > 0 ? reported : 0;
        }

        private void OnSessionDisconnected()
        {
            string name = session?.Device.Name ?? "the device";
            _ = LoseSessionAsync($"Connection to {name} was lost");
        }

        private void StartStatusLoop()
        {
            StopStatusLoop();
            pollFailures = 0;
            statusLoop = new CancellationTokenSource();
            statusTimer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            CancellationToken token = statusLoop.Token;
            PeriodicTimer timer = statusTimer;
            _ = Task.Run(async () =>
            {
                try
                {
                    while (await timer.WaitForNextTickAsync(token))
                    {
                        IRemotePlaybackSession? current = session;
                        if (current is null)
                        {
                            continue;
                        }

                        if (Interlocked.Exchange(ref pollBusy, 1) == 1)
                        {
                            continue;
                        }

                        try
                        {
                            RemotePlaybackStatus status = await current.GetStatusAsync(token);
                            pollFailures = 0;
                            OnSessionStatus(status);
                        }
                        catch (OperationCanceledException) when (token.IsCancellationRequested)
                        {
                            return;
                        }
                        catch (Exception ex)
                        {
                            pollFailures++;
                            Debug.WriteLine($"EMP DLNA: poll failure {pollFailures}/{PollFailureLimit}: {ex.Message}");
                            if (pollFailures >= PollFailureLimit)
                            {
                                string name = current.Device.Name;
                                await LoseSessionAsync($"Connection to {name} was lost");
                                return;
                            }
                        }
                        finally
                        {
                            Interlocked.Exchange(ref pollBusy, 0);
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    // Stopped.
                }
            }, token);
        }

        private void StopStatusLoop()
        {
            statusLoop?.Cancel();
            statusLoop?.Dispose();
            statusLoop = null;
            statusTimer?.Dispose();
            statusTimer = null;
            Interlocked.Exchange(ref pollBusy, 0);
        }

        private void CancelOperation()
        {
            operation?.Cancel();
            operation?.Dispose();
            operation = null;
        }

        private void PostDevices()
        {
            post("castDevices", new
            {
                type = "castDevices",
                scanning = broker.Scanning || discoveryHeld,
                devices = broker.Devices.Select(device => new
                {
                    id = device.Id,
                    name = device.Name,
                    type = device.Type,
                    protocolLabel = device.ProtocolLabel,
                    kind = device.Kind,
                    available = device.Available,
                    volume = device.Volume,
                    seek = device.Seek
                }).ToArray()
            });
        }

        private void PostStatus(
            string state,
            string deviceId,
            string? trackId,
            bool playing,
            double position,
            double duration,
            double volume,
            bool volumeAvailable,
            bool ended,
            string? skip = null)
        {
            post("castStatus", new
            {
                type = "castStatus",
                state,
                deviceId,
                trackId,
                playing,
                position,
                duration,
                volume,
                volumeAvailable,
                ended,
                skip
            });
        }

        private void PostError(string code, string message, string deviceId, bool fatal)
        {
            post("castError", new
            {
                type = "castError",
                code,
                message,
                deviceId,
                fatal
            });
        }
    }
}
