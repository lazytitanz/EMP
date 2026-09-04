using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Xml.Linq;

namespace EMP.Cast.Dlna
{
    internal sealed class DlnaSession : IRemotePlaybackSession
    {
        private readonly DlnaRenderer renderer;
        private readonly HashSet<string> sinkTypes = new(StringComparer.OrdinalIgnoreCase);
        private readonly object gate = new();
        private bool seekSupported = true;
        private bool volumeSupported;
        private bool protocolInfoKnown;
        private bool nextSupported;
        private bool previousSupported;
        private bool setNextSupported;
        private bool eventingAvailable;
        private RemotePlaybackStatus last = new();
        private double libraryDuration;
        private string loadedUrl = string.Empty;
        private string? loadedTrackId;
        private string nextUrl = string.Empty;
        private string? nextTrackId;
        private double nextDuration;
        private string lastTrackUri = string.Empty;
        private string lastTransportState = string.Empty;
        private bool stopRequested;
        private bool terminalEmitted;
        private bool ignoreTransportUntilUtc;
        private DateTime ignoreUntil;
        private int rawLogsRemaining = 8;
        private TcpListener? genaListener;
        private CancellationTokenSource? genaLife;
        private Task? genaLoop;
        private string? eventSid;
        private DateTime eventRenewAt;
        private int genaPort;

        public DlnaSession(PlaybackDevice device, DlnaRenderer renderer)
        {
            Device = device;
            this.renderer = renderer;
            volumeSupported = renderer.RenderingControlUrl is not null;
        }

        public PlaybackDevice Device { get; }

        public bool SupportsSeek => seekSupported;

        public bool SupportsVolume => volumeSupported;

        public event Action<RemotePlaybackStatus>? StatusChanged;

        public event Action? Disconnected
        {
            add { }
            remove { }
        }

        public bool CanPlay(string mime, string extension)
        {
            if (!protocolInfoKnown || sinkTypes.Count == 0)
            {
                return true;
            }

            return sinkTypes.Any(item =>
                item.Contains(mime, StringComparison.OrdinalIgnoreCase)
                || item.Contains(extension.TrimStart('.'), StringComparison.OrdinalIgnoreCase)
                || item.Contains("*:*", StringComparison.Ordinal));
        }

        public async Task ConnectAsync(CancellationToken cancellationToken)
        {
            DlnaLog.Write(
                $"connect name={renderer.FriendlyName} model={renderer.Model} udn={renderer.Udn} " +
                $"eventSub={(renderer.EventSubUrl is null ? "none" : renderer.EventSubUrl)}");
            await LoadCapabilitiesAsync(cancellationToken);
            await TrySubscribeAsync(cancellationToken);
            if (volumeSupported && renderer.RenderingControlUrl is not null)
            {
                try
                {
                    XDocument? volume = await UpnpSoapClient.InvokeAsync(
                        renderer.RenderingControlUrl,
                        renderer.RenderingControlType ?? "urn:schemas-upnp-org:service:RenderingControl:1",
                        "GetVolume",
                        new Dictionary<string, string>
                        {
                            ["InstanceID"] = "0",
                            ["Channel"] = "Master"
                        },
                        cancellationToken);
                    string? value = UpnpSoapClient.ChildValue(volume, "CurrentVolume");
                    if (int.TryParse(value, out int current))
                    {
                        last = last with { Volume = Math.Clamp(current / 100.0, 0, 1) };
                    }
                }
                catch (Exception)
                {
                    volumeSupported = false;
                }
            }
        }

        public async Task LoadAsync(RemoteMedia media, double position, bool play, CancellationToken cancellationToken)
        {
            if (!CanPlay(media.Mime, media.Extension))
            {
                throw new FormatNotSupportedException();
            }

            lock (gate)
            {
                libraryDuration = media.Duration;
                loadedUrl = media.Url;
                loadedTrackId = media.TrackId;
                nextUrl = string.Empty;
                nextTrackId = null;
                nextDuration = 0;
                terminalEmitted = false;
                stopRequested = false;
                ignoreTransportUntilUtc = true;
                ignoreUntil = DateTime.UtcNow.AddSeconds(2.5);
                DlnaLog.Write($"load track={loadedTrackId} url={loadedUrl} duration={libraryDuration:0.##}");
            }

            string didl = BuildDidl(media);
            try
            {
                await InvokeAv("SetAVTransportURI", new Dictionary<string, string>
                {
                    ["InstanceID"] = "0",
                    ["CurrentURI"] = media.Url,
                    ["CurrentURIMetaData"] = didl
                }, cancellationToken);
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"SetAVTransportURI: {ex.Message}");
                throw new FormatNotSupportedException();
            }

            if (play)
            {
                await PlayAsync(cancellationToken);
            }

            if (position > 0.5 && seekSupported)
            {
                try
                {
                    await SeekAsync(position, cancellationToken);
                }
                catch (Exception ex)
                {
                    DlnaLog.Write($"seek on load: {ex.Message}");
                    seekSupported = false;
                }
            }
        }

        public async Task SetNextMediaAsync(RemoteMedia? media, CancellationToken cancellationToken)
        {
            lock (gate)
            {
                nextUrl = media?.Url ?? string.Empty;
                nextTrackId = media?.TrackId;
                nextDuration = media?.Duration ?? 0;
            }

            if (!setNextSupported)
            {
                return;
            }

            try
            {
                Dictionary<string, string> args = new()
                {
                    ["InstanceID"] = "0",
                    ["NextURI"] = media?.Url ?? string.Empty,
                    ["NextURIMetaData"] = media is null ? string.Empty : BuildDidl(media)
                };
                await InvokeAv("SetNextAVTransportURI", args, cancellationToken);
                DlnaLog.Write($"SetNextAVTransportURI {(media is null ? "cleared" : media.Url)}");
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"SetNextAVTransportURI: {ex.Message}");
                setNextSupported = false;
            }
        }

        public Task PlayAsync(CancellationToken cancellationToken)
        {
            lock (gate)
            {
                stopRequested = false;
            }

            return InvokeAv("Play", new Dictionary<string, string>
            {
                ["InstanceID"] = "0",
                ["Speed"] = "1"
            }, cancellationToken);
        }

        public Task PauseAsync(CancellationToken cancellationToken)
        {
            return InvokeAv("Pause", new Dictionary<string, string>
            {
                ["InstanceID"] = "0"
            }, cancellationToken);
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            lock (gate)
            {
                stopRequested = true;
            }

            return InvokeAv("Stop", new Dictionary<string, string>
            {
                ["InstanceID"] = "0"
            }, cancellationToken);
        }

        public async Task SeekAsync(double position, CancellationToken cancellationToken)
        {
            if (!seekSupported)
            {
                return;
            }

            try
            {
                await InvokeAv("Seek", new Dictionary<string, string>
                {
                    ["InstanceID"] = "0",
                    ["Unit"] = "REL_TIME",
                    ["Target"] = FormatTime(position)
                }, cancellationToken);
            }
            catch (Exception)
            {
                seekSupported = false;
                throw;
            }
        }

        public async Task SetVolumeAsync(double level, bool muted, CancellationToken cancellationToken)
        {
            if (!volumeSupported || renderer.RenderingControlUrl is null)
            {
                return;
            }

            string service = renderer.RenderingControlType ?? "urn:schemas-upnp-org:service:RenderingControl:1";
            try
            {
                await UpnpSoapClient.InvokeAsync(
                    renderer.RenderingControlUrl,
                    service,
                    "SetVolume",
                    new Dictionary<string, string>
                    {
                        ["InstanceID"] = "0",
                        ["Channel"] = "Master",
                        ["DesiredVolume"] = Math.Clamp((int)Math.Round(level * 100), 0, 100).ToString(CultureInfo.InvariantCulture)
                    },
                    cancellationToken);
                await UpnpSoapClient.InvokeAsync(
                    renderer.RenderingControlUrl,
                    service,
                    "SetMute",
                    new Dictionary<string, string>
                    {
                        ["InstanceID"] = "0",
                        ["Channel"] = "Master",
                        ["DesiredMute"] = muted ? "1" : "0"
                    },
                    cancellationToken);
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"volume: {ex.Message}");
                volumeSupported = false;
            }
        }

        public async Task<RemotePlaybackStatus> GetStatusAsync(CancellationToken cancellationToken)
        {
            await MaybeRenewEventingAsync(cancellationToken);
            (XDocument? transport, string transportXml) = await UpnpSoapClient.InvokeRawAsync(
                renderer.AvTransportUrl,
                renderer.AvTransportType,
                "GetTransportInfo",
                new Dictionary<string, string> { ["InstanceID"] = "0" },
                cancellationToken);
            string state = UpnpSoapClient.ChildValue(transport, "CurrentTransportState") ?? string.Empty;
            (XDocument? position, string positionXml) = await UpnpSoapClient.InvokeRawAsync(
                renderer.AvTransportUrl,
                renderer.AvTransportType,
                "GetPositionInfo",
                new Dictionary<string, string> { ["InstanceID"] = "0" },
                cancellationToken);
            string? relRaw = UpnpSoapClient.ChildValue(position, "RelTime");
            string? durationRaw = UpnpSoapClient.ChildValue(position, "TrackDuration");
            string? absRaw = UpnpSoapClient.ChildValue(position, "AbsTime");
            string? trackRaw = UpnpSoapClient.ChildValue(position, "Track");
            string? trackUri = UpnpSoapClient.ChildValue(position, "TrackURI");
            LogPosition(state, relRaw, durationRaw, absRaw, trackRaw, trackUri, transportXml, positionXml);
            return ApplySnapshot(state, trackUri, relRaw, durationRaw);
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(2));
                await StopAsync(timeout.Token);
            }
            catch (Exception)
            {
                // Best-effort stop.
            }

            await StopEventingAsync();
        }

        private RemotePlaybackStatus ApplySnapshot(string state, string? trackUri, string? relRaw, string? durationRaw)
        {
            lock (gate)
            {
                bool playing = state.Equals("PLAYING", StringComparison.OrdinalIgnoreCase)
                    || state.Equals("TRANSITIONING", StringComparison.OrdinalIgnoreCase);
                bool stopped = state.Equals("STOPPED", StringComparison.OrdinalIgnoreCase)
                    || state.Equals("NO_MEDIA_PRESENT", StringComparison.OrdinalIgnoreCase);
                double rendererDuration = ParseDuration(durationRaw);
                double duration = libraryDuration > 1 ? libraryDuration : (rendererDuration > 0 ? rendererDuration : last.Duration);
                double position = ParsePosition(relRaw, duration);
                bool ignore = ignoreTransportUntilUtc && DateTime.UtcNow < ignoreUntil;
                if (ignoreTransportUntilUtc && DateTime.UtcNow >= ignoreUntil)
                {
                    ignoreTransportUntilUtc = false;
                }

                string uri = trackUri ?? string.Empty;
                string? skip = null;
                string? appliedId = null;
                bool ended = false;
                if (!ignore && !terminalEmitted)
                {
                    if (UriMatches(uri, nextUrl) && !string.IsNullOrWhiteSpace(nextTrackId))
                    {
                        skip = "applied";
                        appliedId = nextTrackId;
                        loadedUrl = nextUrl;
                        loadedTrackId = nextTrackId;
                        libraryDuration = nextDuration > 1 ? nextDuration : libraryDuration;
                        nextUrl = string.Empty;
                        nextTrackId = null;
                        nextDuration = 0;
                        terminalEmitted = false;
                        DlnaLog.Write($"TrackURI matched next media ({appliedId}); treating as applied skip.");
                    }
                    else if (stopped && duration > 1 && position >= duration - 1.25 && position > 1)
                    {
                        ended = true;
                        terminalEmitted = true;
                        DlnaLog.Write($"ended state={state} pos={position:0.##} dur={duration:0.##}");
                    }
                    else if (nextSupported
                        && stopped
                        && !stopRequested
                        && UriCleared(uri)
                        && (duration <= 1 || position < duration - 2.5))
                    {
                        skip = "next";
                        terminalEmitted = true;
                        DlnaLog.Write($"Next heuristic: state={state} uri='{uri}' pos={position:0.##} dur={duration:0.##}");
                    }
                }

                if (skip == "applied")
                {
                    terminalEmitted = false;
                }

                lastTrackUri = uri;
                lastTransportState = state;
                last = last with
                {
                    Playing = playing,
                    Ended = ended,
                    Position = position,
                    Duration = duration,
                    Skip = skip,
                    AppliedTrackId = appliedId
                };
                return last;
            }
        }

        private void ApplyLastChange(string xml)
        {
            DlnaLog.Write($"LastChange {TrimLog(xml)}");
            try
            {
                XDocument document = XDocument.Parse(xml);
                XElement? instance = document.Descendants().FirstOrDefault(node => node.Name.LocalName == "InstanceID")
                    ?? document.Root;
                if (instance is null)
                {
                    return;
                }

                string state = lastTransportState;
                string uri = lastTrackUri;
                string? relRaw = null;
                string? durationRaw = null;
                foreach (XElement child in instance.Elements())
                {
                    string name = child.Name.LocalName;
                    string value = UpnpSoapClient.AttributeOrValue(child);
                    if (name is "TransportState" or "CurrentTransportState")
                    {
                        state = value;
                    }
                    else if (name is "CurrentTrackURI" or "AVTransportURI" or "TrackURI")
                    {
                        uri = value;
                    }
                    else if (name is "RelativeTimePosition" or "RelTime")
                    {
                        relRaw = value;
                    }
                    else if (name is "CurrentTrackDuration" or "TrackDuration")
                    {
                        durationRaw = value;
                    }
                }

                RemotePlaybackStatus status = ApplySnapshot(state, uri, relRaw, durationRaw);
                StatusChanged?.Invoke(status);
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"LastChange parse: {ex.Message}");
            }
        }

        private double ParsePosition(string? raw, double duration)
        {
            if (!TryParseTime(raw, out double seconds, out TimeParseKind kind))
            {
                return last.Position;
            }

            if (kind == TimeParseKind.NotImplemented)
            {
                return last.Position;
            }

            if (duration > 1 && seconds > duration + 8)
            {
                return last.Position;
            }

            return Math.Max(0, seconds);
        }

        private static double ParseDuration(string? raw)
        {
            if (!TryParseTime(raw, out double seconds, out TimeParseKind kind)
                || kind is TimeParseKind.NotImplemented or TimeParseKind.Zero)
            {
                return 0;
            }

            return seconds;
        }

        private void LogPosition(
            string state,
            string? rel,
            string? duration,
            string? abs,
            string? track,
            string? uri,
            string transportXml,
            string positionXml)
        {
            bool changed = !string.Equals(state, lastTransportState, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(uri ?? string.Empty, lastTrackUri, StringComparison.Ordinal);
            if (changed || rawLogsRemaining > 0)
            {
                DlnaLog.Write(
                    $"GetTransportInfo state={state} GetPositionInfo RelTime={rel} TrackDuration={duration} " +
                    $"AbsTime={abs} Track={track} TrackURI={uri}");
            }

            if (rawLogsRemaining > 0)
            {
                rawLogsRemaining--;
                DlnaLog.Write($"raw GetTransportInfo {TrimLog(transportXml)}");
                DlnaLog.Write($"raw GetPositionInfo {TrimLog(positionXml)}");
            }
        }

        private async Task LoadCapabilitiesAsync(CancellationToken cancellationToken)
        {
            if (renderer.ScpdUrl is not null)
            {
                try
                {
                    XDocument? scpd = await UpnpSoapClient.GetXmlAsync(renderer.ScpdUrl, cancellationToken);
                    HashSet<string> actions = new(StringComparer.OrdinalIgnoreCase);
                    if (scpd is not null)
                    {
                        foreach (XElement node in scpd.Descendants().Where(item => item.Name.LocalName == "name"))
                        {
                            string name = node.Value.Trim();
                            if (name.Length > 0)
                            {
                                actions.Add(name);
                            }
                        }
                    }

                    seekSupported = actions.Count == 0 || actions.Contains("Seek");
                    nextSupported = actions.Contains("Next");
                    previousSupported = actions.Contains("Previous");
                    setNextSupported = actions.Contains("SetNextAVTransportURI");
                    eventingAvailable = renderer.EventSubUrl is not null;
                    DlnaLog.Write(
                        $"SCPD actions Next={nextSupported} Previous={previousSupported} " +
                        $"SetNextAVTransportURI={setNextSupported} Seek={seekSupported} " +
                        $"eventSubURL={(eventingAvailable ? "yes" : "no")}");
                }
                catch (Exception ex)
                {
                    DlnaLog.Write($"SCPD: {ex.Message}");
                    seekSupported = true;
                }
            }
            else
            {
                DlnaLog.Write("SCPD URL missing; assuming Seek and no NextURI.");
            }

            if (renderer.ConnectionManagerUrl is null)
            {
                return;
            }

            try
            {
                XDocument? protocol = await UpnpSoapClient.InvokeAsync(
                    renderer.ConnectionManagerUrl,
                    renderer.ConnectionManagerType ?? "urn:schemas-upnp-org:service:ConnectionManager:1",
                    "GetProtocolInfo",
                    new Dictionary<string, string>(),
                    cancellationToken);
                string sink = UpnpSoapClient.ChildValue(protocol, "Sink") ?? string.Empty;
                foreach (string item in sink.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    sinkTypes.Add(item);
                }

                protocolInfoKnown = sinkTypes.Count > 0;
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"GetProtocolInfo: {ex.Message}");
            }
        }

        private async Task TrySubscribeAsync(CancellationToken cancellationToken)
        {
            if (renderer.EventSubUrl is null)
            {
                DlnaLog.Write("event subscription unavailable (no eventSubURL).");
                return;
            }

            try
            {
                StartGenaListener();
                IPAddress? host = LanAddressSelector.ForDevice(Device.Address);
                if (host is null || genaPort == 0)
                {
                    DlnaLog.Write("event subscription skipped (no LAN callback address).");
                    return;
                }

                Uri callback = new($"http://{host}:{genaPort}/e");
                (string Sid, TimeSpan Timeout)? result = await UpnpSoapClient.SubscribeAsync(
                    renderer.EventSubUrl,
                    callback,
                    cancellationToken);
                if (result is null)
                {
                    DlnaLog.Write("event subscription not accepted.");
                    return;
                }

                eventSid = result.Value.Sid;
                eventRenewAt = DateTime.UtcNow.Add(result.Value.Timeout.Subtract(TimeSpan.FromSeconds(60)));
                if (eventRenewAt <= DateTime.UtcNow)
                {
                    eventRenewAt = DateTime.UtcNow.Add(result.Value.Timeout / 2);
                }

                DlnaLog.Write($"event subscription ok sid={eventSid} timeout={result.Value.Timeout.TotalSeconds:0}s");
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"event subscription: {ex.Message}");
            }
        }

        private async Task MaybeRenewEventingAsync(CancellationToken cancellationToken)
        {
            if (eventSid is null || renderer.EventSubUrl is null || DateTime.UtcNow < eventRenewAt)
            {
                return;
            }

            try
            {
                await UpnpSoapClient.RenewAsync(renderer.EventSubUrl, eventSid, cancellationToken);
                eventRenewAt = DateTime.UtcNow.AddMinutes(4);
                DlnaLog.Write("event subscription renewed.");
            }
            catch (Exception ex)
            {
                DlnaLog.Write($"event renew: {ex.Message}");
                eventSid = null;
            }
        }

        private void StartGenaListener()
        {
            if (genaListener is not null)
            {
                return;
            }

            TcpListener listener = new(IPAddress.Any, 0);
            listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            listener.Start();
            genaPort = ((IPEndPoint)listener.LocalEndpoint).Port;
            genaListener = listener;
            genaLife = new CancellationTokenSource();
            genaLoop = Task.Run(() => AcceptGenaAsync(listener, genaLife.Token));
        }

        private async Task AcceptGenaAsync(TcpListener listener, CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync(cancellationToken);
                }
                catch (Exception)
                {
                    return;
                }

                _ = Task.Run(() => HandleGenaClientAsync(client), cancellationToken);
            }
        }

        private async Task HandleGenaClientAsync(TcpClient client)
        {
            using TcpClient held = client;
            try
            {
                await using NetworkStream stream = held.GetStream();
                string text = await ReadHttpMessageAsync(stream);
                if (text.StartsWith("NOTIFY", StringComparison.OrdinalIgnoreCase))
                {
                    int split = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                    string body = split >= 0 ? text[(split + 4)..] : string.Empty;
                    if (!string.IsNullOrWhiteSpace(body))
                    {
                        string? lastChange = ExtractLastChange(body);
                        if (!string.IsNullOrWhiteSpace(lastChange))
                        {
                            ApplyLastChange(WebUtility.HtmlDecode(lastChange));
                        }
                    }
                }

                byte[] ok = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(ok);
            }
            catch (Exception)
            {
                // Event callback failures must not break playback.
            }
        }

        private async Task StopEventingAsync()
        {
            string? sid = eventSid;
            eventSid = null;
            if (sid is not null && renderer.EventSubUrl is not null)
            {
                try
                {
                    using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(2));
                    await UpnpSoapClient.UnsubscribeAsync(renderer.EventSubUrl, sid, timeout.Token);
                }
                catch (Exception)
                {
                    // Best-effort unsubscribe.
                }
            }

            try
            {
                genaLife?.Cancel();
            }
            catch (Exception)
            {
                // Ignore.
            }

            try
            {
                genaListener?.Stop();
            }
            catch (Exception)
            {
                // Ignore.
            }

            genaListener = null;
            genaLife?.Dispose();
            genaLife = null;
            genaLoop = null;
            genaPort = 0;
        }

        private Task<XDocument?> InvokeAv(string action, Dictionary<string, string> args, CancellationToken cancellationToken)
        {
            return UpnpSoapClient.InvokeAsync(renderer.AvTransportUrl, renderer.AvTransportType, action, args, cancellationToken);
        }

        private static string BuildDidl(RemoteMedia media)
        {
            string title = System.Security.SecurityElement.Escape(media.Title) ?? string.Empty;
            string artist = System.Security.SecurityElement.Escape(media.Artist) ?? string.Empty;
            string album = System.Security.SecurityElement.Escape(media.Album) ?? string.Empty;
            string url = System.Security.SecurityElement.Escape(media.Url) ?? string.Empty;
            string mime = System.Security.SecurityElement.Escape(media.Mime) ?? "audio/mpeg";
            string duration = media.Duration > 0 ? $" duration=\"{FormatTime(media.Duration)}\"" : string.Empty;
            return
                "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" " +
                "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" " +
                "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">" +
                "<item id=\"0\" parentID=\"-1\" restricted=\"1\">" +
                $"<dc:title>{title}</dc:title>" +
                $"<upnp:artist>{artist}</upnp:artist>" +
                $"<upnp:album>{album}</upnp:album>" +
                "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
                $"<res protocolInfo=\"http-get:*:{mime}:*\"{duration}>{url}</res>" +
                "</item></DIDL-Lite>";
        }

        private static string FormatTime(double seconds)
        {
            TimeSpan span = TimeSpan.FromSeconds(Math.Max(0, seconds));
            return string.Create(CultureInfo.InvariantCulture, $"{(int)span.TotalHours}:{span.Minutes:00}:{span.Seconds:00}");
        }

        private static bool TryParseTime(string? value, out double seconds, out TimeParseKind kind)
        {
            seconds = 0;
            if (string.IsNullOrWhiteSpace(value))
            {
                kind = TimeParseKind.Invalid;
                return false;
            }

            string trimmed = value.Trim();
            if (trimmed.Equals("NOT_IMPLEMENTED", StringComparison.OrdinalIgnoreCase))
            {
                kind = TimeParseKind.NotImplemented;
                return true;
            }

            string[] parts = trimmed.Split(':');
            if (parts.Length != 3
                || !int.TryParse(parts[0], out int hours)
                || !int.TryParse(parts[1], out int minutes)
                || !double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out double secs))
            {
                kind = TimeParseKind.Invalid;
                return false;
            }

            seconds = hours * 3600 + minutes * 60 + secs;
            kind = seconds <= 0 ? TimeParseKind.Zero : TimeParseKind.Valid;
            return true;
        }

        private static bool UriMatches(string candidate, string expected)
        {
            if (string.IsNullOrWhiteSpace(candidate) || string.IsNullOrWhiteSpace(expected))
            {
                return false;
            }

            if (string.Equals(candidate.Trim(), expected.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            string left = TokenOf(candidate);
            string right = TokenOf(expected);
            return left.Length > 0 && string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }

        private static bool UriCleared(string uri)
        {
            return string.IsNullOrWhiteSpace(uri)
                || uri.Equals("NOT_IMPLEMENTED", StringComparison.OrdinalIgnoreCase);
        }

        private static string TokenOf(string uri)
        {
            int slash = uri.LastIndexOf('/');
            return slash >= 0 && slash < uri.Length - 1 ? uri[(slash + 1)..] : uri;
        }

        private static string ExtractLastChange(string body)
        {
            try
            {
                XDocument document = XDocument.Parse(body);
                XElement? last = document.Descendants().FirstOrDefault(node => node.Name.LocalName == "LastChange");
                if (last is null)
                {
                    return body;
                }

                if (last.HasElements)
                {
                    return last.Elements().First().ToString();
                }

                return last.Value;
            }
            catch (Exception)
            {
                return body;
            }
        }

        private static async Task<string> ReadHttpMessageAsync(NetworkStream stream)
        {
            MemoryStream buffer = new();
            byte[] chunk = new byte[1024];
            int? contentLength = null;
            while (buffer.Length < 64 * 1024)
            {
                int read = await stream.ReadAsync(chunk);
                if (read <= 0)
                {
                    break;
                }

                buffer.Write(chunk, 0, read);
                string text = Encoding.UTF8.GetString(buffer.ToArray());
                int headerEnd = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                if (headerEnd < 0)
                {
                    continue;
                }

                if (contentLength is null)
                {
                    contentLength = -1;
                    foreach (string line in text[..headerEnd].Split(["\r\n", "\n"], StringSplitOptions.None))
                    {
                        if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)
                            && int.TryParse(line[15..].Trim(), out int parsed))
                        {
                            contentLength = parsed;
                        }
                    }
                }

                int bodyBytes = buffer.ToArray().Length - Encoding.UTF8.GetByteCount(text[..(headerEnd + 4)]);
                if (contentLength >= 0)
                {
                    if (bodyBytes >= contentLength)
                    {
                        return Encoding.UTF8.GetString(buffer.ToArray());
                    }
                }
                else if (bodyBytes > 0)
                {
                    return Encoding.UTF8.GetString(buffer.ToArray());
                }
            }

            return Encoding.UTF8.GetString(buffer.ToArray());
        }

        private static string TrimLog(string value)
        {
            string flat = value.ReplaceLineEndings(" ");
            return flat.Length <= 800 ? flat : flat[..800] + "…";
        }

        private enum TimeParseKind
        {
            Invalid,
            NotImplemented,
            Zero,
            Valid
        }
    }
}
