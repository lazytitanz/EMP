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
            // Sharpcaster 3.x: FindReceiversAsync(TimeSpan) only sets the *quick*
            // progressive stage. Passing 5s there left medium/full at 800ms/2s and
            // made the first open look empty; Rescan "fixed" it by warming mDNS.
            using ChromecastLocator locator = new();
            EventHandler<ChromecastReceiverEventArgs>? foundHandler = (_, args) =>
            {
                if (args.Receiver is not null)
                {
                    UpsertReceivers([args.Receiver]);
                }
            };

            locator.ChromecastReceiverFound += foundHandler;
            try
            {
                // Continuous discovery raises events as receivers appear (5s scans).
                locator.StartContinuousDiscovery(TimeSpan.FromSeconds(5));

                // Parallel progressive probe with a long final stage so the drawer
                // usually fills on the first open instead of only after Rescan.
                await ProbeOnceAsync(
                        locator,
                        quick: TimeSpan.FromMilliseconds(500),
                        medium: TimeSpan.FromSeconds(2),
                        full: TimeSpan.FromSeconds(6),
                        cancellationToken)
                    .ConfigureAwait(false);

                if (!cancellationToken.IsCancellationRequested && !HasDevices())
                {
                    await ProbeOnceAsync(
                            locator,
                            quick: TimeSpan.FromSeconds(1),
                            medium: TimeSpan.FromSeconds(3),
                            full: TimeSpan.FromSeconds(8),
                            cancellationToken)
                        .ConfigureAwait(false);
                }

                try
                {
                    await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                }
            }
            finally
            {
                locator.ChromecastReceiverFound -= foundHandler;
                try
                {
                    locator.StopContinuousDiscovery();
                }
                catch (Exception)
                {
                    // Ignore shutdown races inside Sharpcaster.
                }
            }
        }

        private bool HasDevices()
        {
            lock (gate)
            {
                return devices.Count > 0;
            }
        }

        private async Task ProbeOnceAsync(
            ChromecastLocator locator,
            TimeSpan quick,
            TimeSpan medium,
            TimeSpan full,
            CancellationToken cancellationToken)
        {
            try
            {
                IEnumerable<ChromecastReceiver> found = await locator
                    .FindReceiversAsync(quick, medium, full)
                    .WaitAsync(cancellationToken)
                    .ConfigureAwait(false);
                UpsertReceivers(found);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"EMP Cast discovery: {ex.Message}");
            }
        }

        private void UpsertReceivers(IEnumerable<ChromecastReceiver> found)
        {
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
                        || existing.Device.Name != device.Name
                        || !existing.Device.Available)
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
