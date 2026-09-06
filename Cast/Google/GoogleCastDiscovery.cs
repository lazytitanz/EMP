using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Sharpcaster;
using Sharpcaster.Models;

namespace EMP.Cast.Google
{
    internal sealed class GoogleCastDiscovery : IDeviceDiscovery
    {
        private readonly object gate = new();
        private readonly Dictionary<string, CachedReceiver> devices = new(StringComparer.OrdinalIgnoreCase);
        private CancellationTokenSource? lifetime;
        private Task? loop;
        private Task drain = Task.CompletedTask;
        private bool started;

        public event Action? Changed;

        public IReadOnlyList<PlaybackDevice> Devices
        {
            get
            {
                lock (gate)
                {
                    PruneLocked(DateTime.UtcNow);
                    return devices.Values.Select(item => item.Device).ToArray();
                }
            }
        }

        public ChromecastReceiver? FindReceiver(string deviceId)
        {
            lock (gate)
            {
                return devices.TryGetValue(deviceId, out CachedReceiver? cached) ? cached.Receiver : null;
            }
        }

        public PlaybackDevice? FindDevice(string deviceId)
        {
            lock (gate)
            {
                return devices.TryGetValue(deviceId, out CachedReceiver? cached) ? cached.Device : null;
            }
        }

        public void Start()
        {
            lock (gate)
            {
                if (started)
                {
                    return;
                }

                started = true;
                lifetime = new CancellationTokenSource();
                CancellationToken token = lifetime.Token;
                Task previous = drain;
                loop = Task.Run(async () =>
                {
                    // Waiting on the previous run keeps a restart from doubling up
                    // the discovery loops that publish device changes.
                    await previous.ConfigureAwait(false);
                    await RunAsync(token).ConfigureAwait(false);
                });
            }
        }

        public Task StopAsync()
        {
            lock (gate)
            {
                if (!started)
                {
                    return drain;
                }

                started = false;
                CancellationTokenSource? stopping = lifetime;
                Task? running = loop;
                lifetime = null;
                loop = null;
                drain = Task.Run(() => DrainAsync(stopping, running));
                return drain;
            }
        }

        private static async Task DrainAsync(CancellationTokenSource? stopping, Task? running)
        {
            stopping?.Cancel();
            if (running is not null)
            {
                try
                {
                    await running.ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // The loop swallows its own failures; nothing to salvage here.
                }
            }

            stopping?.Dispose();
        }

        public void Dispose()
        {
            Task stopping = StopAsync();
            try
            {
                stopping.Wait(TimeSpan.FromSeconds(2));
            }
            catch (Exception)
            {
                // Discovery must not block shutdown.
            }

            lock (gate)
            {
                devices.Clear();
            }
        }

        private async Task RunAsync(CancellationToken cancellationToken)
        {
            ChromecastLocator locator = new();
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    // FindReceiversAsync takes no token, so abandon it on cancellation
                    // instead of letting the loop outlive Stop by a full scan window.
                    IEnumerable<ChromecastReceiver> found = await locator
                        .FindReceiversAsync(TimeSpan.FromSeconds(5))
                        .WaitAsync(cancellationToken);
                    DateTime now = DateTime.UtcNow;
                    bool changed = false;
                    lock (gate)
                    {
                        foreach (ChromecastReceiver receiver in found)
                        {
                            PlaybackDevice device = ToDevice(receiver);
                            if (string.IsNullOrWhiteSpace(device.Id))
                            {
                                continue;
                            }

                            if (!devices.TryGetValue(device.Id, out CachedReceiver? existing)
                                || existing.Device.Name != device.Name)
                            {
                                changed = true;
                            }

                            devices[device.Id] = new CachedReceiver(device, receiver, now);
                        }

                        changed |= PruneLocked(now);
                    }

                    if (changed)
                    {
                        Changed?.Invoke();
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"EMP Cast discovery: {ex.Message}");
                }

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(4), cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        private bool PruneLocked(DateTime now)
        {
            bool changed = false;
            foreach (string id in devices.Keys.ToArray())
            {
                if (now - devices[id].Seen > TimeSpan.FromSeconds(45))
                {
                    devices.Remove(id);
                    changed = true;
                }
            }

            return changed;
        }

        internal static PlaybackDevice ToDevice(ChromecastReceiver receiver)
        {
            string host = receiver.DeviceUri?.Host ?? string.Empty;
            IPAddress? address = null;
            if (IPAddress.TryParse(host, out IPAddress? parsed))
            {
                address = parsed;
            }
            else if (!string.IsNullOrWhiteSpace(host))
            {
                try
                {
                    address = Dns.GetHostAddresses(host)
                        .FirstOrDefault(item => item.AddressFamily == AddressFamily.InterNetwork);
                }
                catch (Exception)
                {
                    address = null;
                }
            }

            string extraId = string.Empty;
            if (receiver.ExtraInformation is not null
                && receiver.ExtraInformation.TryGetValue("id", out string? foundId)
                && !string.IsNullOrWhiteSpace(foundId))
            {
                extraId = foundId;
            }
            string id = "cast:" + (string.IsNullOrWhiteSpace(extraId) ? $"{host}:{receiver.Port}" : extraId);
            string model = receiver.Model ?? string.Empty;
            bool audio = model.Contains("Audio", StringComparison.OrdinalIgnoreCase)
                || model.Contains("Speaker", StringComparison.OrdinalIgnoreCase);
            return new PlaybackDevice
            {
                Id = id,
                Name = string.IsNullOrWhiteSpace(receiver.Name) ? "Chromecast" : receiver.Name.Trim(),
                Type = "cast",
                ProtocolLabel = "Google Cast",
                Kind = audio ? "speaker" : "tv",
                Address = address,
                Available = true,
                Seek = true,
                Volume = true
            };
        }

        private sealed record CachedReceiver(PlaybackDevice Device, ChromecastReceiver Receiver, DateTime Seen);
    }
}
