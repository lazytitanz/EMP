namespace EMP.Cast
{
    internal sealed class DeviceBroker : IDisposable
    {
        private readonly Google.GoogleCastDiscovery cast = new();
        private readonly Dlna.DlnaDiscovery dlna = new();
        private readonly object gate = new();
        private Task drain = Task.CompletedTask;
        private bool started;

        public DeviceBroker()
        {
            ChangedHandler = () => Changed?.Invoke();
            DeviceLeftHandler = id => DeviceLeft?.Invoke(id);
            cast.Changed += ChangedHandler;
            dlna.Changed += ChangedHandler;
            dlna.DeviceLeft += DeviceLeftHandler;
        }

        private readonly Action ChangedHandler;
        private readonly Action<string> DeviceLeftHandler;

        public event Action? Changed;

        public event Action<string>? DeviceLeft;

        public IReadOnlyList<PlaybackDevice> Devices
        {
            get
            {
                Dictionary<string, PlaybackDevice> merged = new(StringComparer.OrdinalIgnoreCase);
                foreach (PlaybackDevice device in cast.Devices.Concat(dlna.Devices))
                {
                    merged[device.Id] = device;
                }

                return merged.Values
                    .OrderBy(device => device.Name, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
            }
        }

        public bool Scanning { get; private set; }

        public PlaybackDevice? Find(string deviceId)
        {
            return cast.FindDevice(deviceId) ?? dlna.FindDevice(deviceId);
        }

        public void MarkUnavailable(string? deviceId)
        {
            if (!string.IsNullOrWhiteSpace(deviceId))
            {
                dlna.MarkUnavailable(deviceId);
            }
        }

        public IRemotePlaybackSession? CreateSession(string deviceId)
        {
            Sharpcaster.Models.ChromecastReceiver? receiver = cast.FindReceiver(deviceId);
            PlaybackDevice? castDevice = cast.FindDevice(deviceId);
            if (receiver is not null && castDevice is not null)
            {
                return new Google.GoogleCastSession(castDevice, receiver);
            }

            Dlna.DlnaRenderer? renderer = dlna.FindRenderer(deviceId);
            PlaybackDevice? dlnaDevice = dlna.FindDevice(deviceId);
            if (renderer is not null && dlnaDevice is not null)
            {
                return new Dlna.DlnaSession(dlnaDevice, renderer);
            }

            return null;
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
                Scanning = true;
            }

            cast.Start();
            dlna.Start();
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
                Scanning = false;
                drain = Task.WhenAll(cast.StopAsync(), dlna.StopAsync());
                return drain;
            }
        }

        public void Dispose()
        {
            _ = StopAsync();
            cast.Changed -= ChangedHandler;
            dlna.Changed -= ChangedHandler;
            dlna.DeviceLeft -= DeviceLeftHandler;
            cast.Dispose();
            dlna.Dispose();
        }
    }
}
