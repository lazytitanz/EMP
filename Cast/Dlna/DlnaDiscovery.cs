using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Xml.Linq;

namespace EMP.Cast.Dlna
{
    internal sealed class DlnaDiscovery : IDeviceDiscovery
    {
        private static readonly IPAddress SsdpAddress = IPAddress.Parse("239.255.255.250");
        private const int SsdpPort = 1900;
        private const string SearchTarget = "urn:schemas-upnp-org:device:MediaRenderer:1";
        private static readonly TimeSpan DefaultLifetime = TimeSpan.FromSeconds(45);

        private readonly object gate = new();
        private readonly Dictionary<string, CachedRenderer> devices = new(StringComparer.OrdinalIgnoreCase);
        private CancellationTokenSource? lifetime;
        private Task? loop;
        private Task? notifyLoop;
        private bool started;

        public event Action? Changed;

        public event Action<string>? DeviceLeft;

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

        public DlnaRenderer? FindRenderer(string deviceId)
        {
            lock (gate)
            {
                return devices.TryGetValue(deviceId, out CachedRenderer? cached) ? cached.Renderer : null;
            }
        }

        public PlaybackDevice? FindDevice(string deviceId)
        {
            lock (gate)
            {
                return devices.TryGetValue(deviceId, out CachedRenderer? cached) ? cached.Device : null;
            }
        }

        public void MarkUnavailable(string deviceId)
        {
            bool changed = false;
            lock (gate)
            {
                if (devices.TryGetValue(deviceId, out CachedRenderer? cached) && cached.Device.Available)
                {
                    cached.Device.Available = false;
                    changed = true;
                }
            }

            if (changed)
            {
                Changed?.Invoke();
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
                loop = Task.Run(() => RunAsync(lifetime.Token));
                notifyLoop = Task.Run(() => ListenNotifyAsync(lifetime.Token));
            }
        }

        public void Stop()
        {
            CancellationTokenSource? stopping;
            Task? running;
            Task? notify;
            lock (gate)
            {
                if (!started)
                {
                    return;
                }

                started = false;
                stopping = lifetime;
                running = loop;
                notify = notifyLoop;
                lifetime = null;
                loop = null;
                notifyLoop = null;
            }

            stopping?.Cancel();
            try
            {
                running?.Wait(TimeSpan.FromSeconds(2));
            }
            catch (Exception)
            {
                // Discovery must not block shutdown.
            }

            try
            {
                notify?.Wait(TimeSpan.FromSeconds(2));
            }
            catch (Exception)
            {
                // Notify listener must not block shutdown.
            }

            stopping?.Dispose();
        }

        public void Dispose()
        {
            Stop();
            lock (gate)
            {
                devices.Clear();
            }
        }

        private async Task RunAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    await SearchOnceAsync(cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    DlnaLog.Write($"discovery: {ex.Message}");
                }

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(8), cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        private async Task ListenNotifyAsync(CancellationToken cancellationToken)
        {
            UdpClient? client = null;
            try
            {
                client = new UdpClient();
                client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                client.ExclusiveAddressUse = false;
                client.Client.Bind(new IPEndPoint(IPAddress.Any, SsdpPort));
                IReadOnlyList<IPAddress> locals = LanAddressSelector.LocalIpv4Addresses();
                if (locals.Count == 0)
                {
                    client.JoinMulticastGroup(SsdpAddress);
                }
                else
                {
                    foreach (IPAddress local in locals)
                    {
                        client.JoinMulticastGroup(SsdpAddress, local);
                    }
                }

                DlnaLog.Write("SSDP NOTIFY listener started.");
                while (!cancellationToken.IsCancellationRequested)
                {
                    UdpReceiveResult result = await client.ReceiveAsync(cancellationToken);
                    HandleSsdpPacket(Encoding.ASCII.GetString(result.Buffer), cancellationToken);
                }
            }
            catch (OperationCanceledException)
            {
                // Stopped.
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"SSDP NOTIFY listener: {ex.Message}");
            }
            finally
            {
                client?.Dispose();
            }
        }

        private void HandleSsdpPacket(string text, CancellationToken cancellationToken)
        {
            if (!text.StartsWith("NOTIFY", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            string? nts = ReadHeader(text, "NTS");
            string? usn = ReadHeader(text, "USN");
            string? nt = ReadHeader(text, "NT") ?? ReadHeader(text, "ST");
            TimeSpan maxAge = ReadMaxAge(text);
            string? id = DeviceIdFromUsn(usn);
            if (string.Equals(nts, "ssdp:byebye", StringComparison.OrdinalIgnoreCase))
            {
                DlnaLog.Write($"ssdp:byebye USN={usn} NT={nt} CACHE-CONTROL={ReadHeader(text, "CACHE-CONTROL")}");
                if (!string.IsNullOrWhiteSpace(id))
                {
                    RemoveDevice(id);
                }

                return;
            }

            if (!string.Equals(nts, "ssdp:alive", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            bool rendererAdvertisement = (nt ?? string.Empty).Contains("MediaRenderer", StringComparison.OrdinalIgnoreCase)
                || (usn ?? string.Empty).Contains("MediaRenderer", StringComparison.OrdinalIgnoreCase);
            if (!string.IsNullOrWhiteSpace(id))
            {
                bool known;
                lock (gate)
                {
                    known = devices.ContainsKey(id);
                    if (known)
                    {
                        TouchLocked(id, DateTime.UtcNow, maxAge);
                    }
                }

                if (known)
                {
                    return;
                }
            }

            if (!rendererAdvertisement)
            {
                return;
            }

            DlnaLog.Write($"ssdp:alive USN={usn} NT={nt} CACHE-CONTROL={ReadHeader(text, "CACHE-CONTROL")}");
            string? location = ReadHeader(text, "LOCATION");
            if (string.IsNullOrWhiteSpace(location) || !Uri.TryCreate(location, UriKind.Absolute, out Uri? uri))
            {
                return;
            }

            _ = TryAddRendererAsync(uri, maxAge, cancellationToken);
        }

        private async Task SearchOnceAsync(CancellationToken cancellationToken)
        {
            List<IPAddress> locals = LanAddressSelector.LocalIpv4Addresses().ToList();
            if (locals.Count == 0)
            {
                locals.Add(IPAddress.Any);
            }

            List<Task> searches = [];
            foreach (IPAddress local in locals)
            {
                searches.Add(SearchInterfaceAsync(local, cancellationToken));
            }

            await Task.WhenAll(searches);
            bool pruned;
            lock (gate)
            {
                pruned = PruneLocked(DateTime.UtcNow);
            }

            if (pruned)
            {
                Changed?.Invoke();
            }
        }

        private async Task SearchInterfaceAsync(IPAddress local, CancellationToken cancellationToken)
        {
            using UdpClient client = new(new IPEndPoint(local, 0));
            client.Client.ReceiveTimeout = 4000;
            client.MulticastLoopback = false;
            byte[] payload = Encoding.ASCII.GetBytes(
                "M-SEARCH * HTTP/1.1\r\n" +
                "HOST: 239.255.255.250:1900\r\n" +
                "MAN: \"ssdp:discover\"\r\n" +
                "MX: 3\r\n" +
                $"ST: {SearchTarget}\r\n" +
                "USER-AGENT: EMP/1.0\r\n\r\n");
            await client.SendAsync(payload, payload.Length, new IPEndPoint(SsdpAddress, SsdpPort));

            DateTime deadline = DateTime.UtcNow.AddSeconds(4);
            while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
            {
                TimeSpan remaining = deadline - DateTime.UtcNow;
                if (remaining <= TimeSpan.Zero)
                {
                    break;
                }

                try
                {
                    using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    timeout.CancelAfter(remaining);
                    UdpReceiveResult result = await client.ReceiveAsync(timeout.Token);
                    string text = Encoding.ASCII.GetString(result.Buffer);
                    string? location = ReadHeader(text, "LOCATION");
                    if (string.IsNullOrWhiteSpace(location) || !Uri.TryCreate(location, UriKind.Absolute, out Uri? uri))
                    {
                        continue;
                    }

                    await TryAddRendererAsync(uri, ReadMaxAge(text), cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception)
                {
                    continue;
                }
            }
        }

        private async Task TryAddRendererAsync(Uri location, TimeSpan maxAge, CancellationToken cancellationToken)
        {
            try
            {
                XDocument? document = await UpnpSoapClient.GetXmlAsync(location, cancellationToken);
                if (document is null)
                {
                    return;
                }

                DlnaRenderer? renderer = ParseRenderer(location, document);
                if (renderer is null)
                {
                    return;
                }

                bool changed = false;
                lock (gate)
                {
                    DateTime now = DateTime.UtcNow;
                    if (!devices.TryGetValue(renderer.Device.Id, out CachedRenderer? existing)
                        || existing.Device.Name != renderer.Device.Name
                        || !existing.Device.Available)
                    {
                        changed = true;
                    }

                    renderer.Device.Available = true;
                    devices[renderer.Device.Id] = new CachedRenderer(renderer.Device, renderer, now, now + maxAge);
                }

                if (changed)
                {
                    Changed?.Invoke();
                }
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"describe: {ex.Message}");
            }
        }

        internal static DlnaRenderer? ParseRenderer(Uri location, XDocument document)
        {
            XElement? device = document.Descendants().FirstOrDefault(node =>
                node.Name.LocalName == "device"
                && (node.Element(node.Name.Namespace + "deviceType")?.Value
                    ?? node.Elements().FirstOrDefault(item => item.Name.LocalName == "deviceType")?.Value ?? string.Empty)
                    .Contains("MediaRenderer", StringComparison.OrdinalIgnoreCase));
            if (device is null)
            {
                device = document.Descendants().FirstOrDefault(node => node.Name.LocalName == "device");
                string type = Value(device, "deviceType");
                if (device is null || !type.Contains("MediaRenderer", StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }
            }

            XElement? avTransport = FindService(device, "AVTransport");
            if (avTransport is null)
            {
                return null;
            }

            string udn = Value(device, "UDN");
            string name = Value(device, "friendlyName");
            string model = Value(device, "modelName");
            Uri avControl = ResolveUrl(location, Value(avTransport, "controlURL"));
            string eventSub = Value(avTransport, "eventSubURL");
            Uri? eventUrl = string.IsNullOrWhiteSpace(eventSub) ? null : ResolveUrl(location, eventSub);
            XElement? rendering = FindService(device, "RenderingControl");
            XElement? connection = FindService(device, "ConnectionManager");
            Uri? rcControl = rendering is null ? null : ResolveUrl(location, Value(rendering, "controlURL"));
            Uri? cmControl = connection is null ? null : ResolveUrl(location, Value(connection, "controlURL"));
            string avType = Value(avTransport, "serviceType");
            if (string.IsNullOrWhiteSpace(avType))
            {
                avType = "urn:schemas-upnp-org:service:AVTransport:1";
            }

            IPAddress? address = null;
            if (IPAddress.TryParse(location.Host, out IPAddress? parsed))
            {
                address = parsed;
            }

            bool tv = (model + name).Contains("TV", StringComparison.OrdinalIgnoreCase)
                || (model + name).Contains("Chromecast", StringComparison.OrdinalIgnoreCase);
            PlaybackDevice playback = new()
            {
                Id = "dlna:" + (string.IsNullOrWhiteSpace(udn) ? location.Host : udn),
                Name = string.IsNullOrWhiteSpace(name) ? "DLNA device" : name.Trim(),
                Type = "dlna",
                ProtocolLabel = "DLNA",
                Kind = tv ? "tv" : "speaker",
                Address = address,
                Available = true,
                Seek = true,
                Volume = rcControl is not null
            };

            return new DlnaRenderer
            {
                Device = playback,
                Udn = udn,
                FriendlyName = string.IsNullOrWhiteSpace(name) ? playback.Name : name.Trim(),
                Model = string.IsNullOrWhiteSpace(model) ? "unknown" : model.Trim(),
                AvTransportUrl = avControl,
                AvTransportType = avType,
                EventSubUrl = eventUrl,
                RenderingControlUrl = rcControl,
                RenderingControlType = rendering is null ? null : Value(rendering, "serviceType"),
                ConnectionManagerUrl = cmControl,
                ConnectionManagerType = connection is null ? null : Value(connection, "serviceType"),
                ScpdUrl = ResolveUrl(location, Value(avTransport, "SCPDURL"))
            };
        }

        private static XElement? FindService(XElement device, string localType)
        {
            return device.Descendants().FirstOrDefault(node =>
                node.Name.LocalName == "service"
                && (Value(node, "serviceType").Contains(localType, StringComparison.OrdinalIgnoreCase)
                    || Value(node, "serviceId").Contains(localType, StringComparison.OrdinalIgnoreCase)));
        }

        private static string Value(XElement? element, string localName)
        {
            return element?.Elements().FirstOrDefault(node => node.Name.LocalName == localName)?.Value?.Trim() ?? string.Empty;
        }

        private static Uri ResolveUrl(Uri location, string relative)
        {
            if (string.IsNullOrWhiteSpace(relative))
            {
                return location;
            }

            return Uri.TryCreate(location, relative, out Uri? resolved) ? resolved : location;
        }

        private static string? ReadHeader(string response, string name)
        {
            foreach (string line in response.Split(["\r\n", "\n"], StringSplitOptions.None))
            {
                int colon = line.IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }

                if (line[..colon].Trim().Equals(name, StringComparison.OrdinalIgnoreCase))
                {
                    return line[(colon + 1)..].Trim();
                }
            }

            return null;
        }

        private static TimeSpan ReadMaxAge(string response)
        {
            string? cache = ReadHeader(response, "CACHE-CONTROL");
            if (string.IsNullOrWhiteSpace(cache))
            {
                return DefaultLifetime;
            }

            foreach (string part in cache.Split(',', StringSplitOptions.TrimEntries))
            {
                int equals = part.IndexOf('=');
                if (equals <= 0)
                {
                    continue;
                }

                if (!part[..equals].Trim().Equals("max-age", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (int.TryParse(part[(equals + 1)..].Trim(), out int seconds) && seconds > 0)
                {
                    return TimeSpan.FromSeconds(Math.Clamp(seconds, 15, 7200));
                }
            }

            return DefaultLifetime;
        }

        private static string? DeviceIdFromUsn(string? usn)
        {
            if (string.IsNullOrWhiteSpace(usn))
            {
                return null;
            }

            string uuid = usn.Split("::", 2)[0].Trim();
            return string.IsNullOrWhiteSpace(uuid) ? null : "dlna:" + uuid;
        }

        private void TouchLocked(string id, DateTime now, TimeSpan maxAge)
        {
            if (!devices.TryGetValue(id, out CachedRenderer? cached))
            {
                return;
            }

            devices[id] = cached with { Seen = now, Expires = now + maxAge };
            cached.Device.Available = true;
        }

        private void RemoveDevice(string id)
        {
            bool removed;
            lock (gate)
            {
                removed = devices.Remove(id);
            }

            if (removed)
            {
                Changed?.Invoke();
                DeviceLeft?.Invoke(id);
            }
        }

        private bool PruneLocked(DateTime now)
        {
            bool changed = false;
            foreach (string id in devices.Keys.ToArray())
            {
                if (now > devices[id].Expires)
                {
                    DlnaLog.Write($"expired {id} after CACHE-CONTROL lifetime.");
                    devices.Remove(id);
                    changed = true;
                }
            }

            return changed;
        }

        private sealed record CachedRenderer(PlaybackDevice Device, DlnaRenderer Renderer, DateTime Seen, DateTime Expires);
    }

    internal sealed class DlnaRenderer
    {
        public required PlaybackDevice Device { get; init; }

        public string Udn { get; init; } = string.Empty;

        public string FriendlyName { get; init; } = string.Empty;

        public string Model { get; init; } = "unknown";

        public required Uri AvTransportUrl { get; init; }

        public required string AvTransportType { get; init; }

        public Uri? EventSubUrl { get; init; }

        public Uri? RenderingControlUrl { get; init; }

        public string? RenderingControlType { get; init; }

        public Uri? ConnectionManagerUrl { get; init; }

        public string? ConnectionManagerType { get; init; }

        public Uri? ScpdUrl { get; init; }
    }
}
