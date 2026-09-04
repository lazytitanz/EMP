using System.Net;
using System.Text.Json.Serialization;

namespace EMP.Cast
{
    internal sealed class PlaybackDevice
    {
        public required string Id { get; init; }

        public required string Name { get; init; }

        public required string Type { get; init; }

        public string ProtocolLabel { get; init; } = string.Empty;

        public string Kind { get; init; } = "speaker";

        [JsonIgnore]
        public IPAddress? Address { get; init; }

        public bool Available { get; set; } = true;

        public bool Seek { get; init; }

        public bool Volume { get; init; }
    }

    internal sealed class RemoteMedia
    {
        public string? TrackId { get; init; }

        public required string Url { get; init; }

        public required string Mime { get; init; }

        public required string Extension { get; init; }

        public required string Title { get; init; }

        public required string Artist { get; init; }

        public required string Album { get; init; }

        public string? ArtworkUrl { get; init; }

        public double Duration { get; init; }
    }

    internal sealed record RemotePlaybackStatus
    {
        public bool Playing { get; init; }

        public bool Ended { get; init; }

        public bool Error { get; init; }

        public bool FormatError { get; init; }

        public double Position { get; init; }

        public double Duration { get; init; }

        public double Volume { get; init; } = 0.8;

        public bool Muted { get; init; }

        public string? Skip { get; init; }

        public string? AppliedTrackId { get; init; }
    }

    internal sealed class FormatNotSupportedException : Exception
    {
        public FormatNotSupportedException()
            : base("This device can't play this audio format.")
        {
        }
    }

    internal interface IRemotePlaybackSession : IAsyncDisposable
    {
        PlaybackDevice Device { get; }

        bool CanPlay(string mime, string extension);

        bool SupportsSeek { get; }

        bool SupportsVolume { get; }

        event Action<RemotePlaybackStatus>? StatusChanged;

        event Action? Disconnected;

        Task ConnectAsync(CancellationToken cancellationToken);

        Task LoadAsync(RemoteMedia media, double position, bool play, CancellationToken cancellationToken);

        Task SetNextMediaAsync(RemoteMedia? media, CancellationToken cancellationToken);

        Task PlayAsync(CancellationToken cancellationToken);

        Task PauseAsync(CancellationToken cancellationToken);

        Task StopAsync(CancellationToken cancellationToken);

        Task SeekAsync(double position, CancellationToken cancellationToken);

        Task SetVolumeAsync(double level, bool muted, CancellationToken cancellationToken);

        Task<RemotePlaybackStatus> GetStatusAsync(CancellationToken cancellationToken);
    }

    internal interface IDeviceDiscovery : IDisposable
    {
        event Action? Changed;

        IReadOnlyList<PlaybackDevice> Devices { get; }

        void Start();

        void Stop();
    }
}
