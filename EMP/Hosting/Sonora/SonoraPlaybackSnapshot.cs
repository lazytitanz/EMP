namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Authoritative local-transport snapshot from Sonora, stamped with EMP command generation.
    /// </summary>
    internal sealed class SonoraPlaybackSnapshot
    {
        public required long Generation { get; init; }

        public required global::Sonora.Audio.Formats.PlaybackState State { get; init; }

        public string? TrackId { get; init; }

        public string? NextTrackId { get; init; }

        public string? SourcePath { get; init; }

        public TimeSpan Position { get; init; }

        public TimeSpan BufferedPosition { get; init; }

        public TimeSpan Duration { get; init; }

        public bool HasKnownDuration { get; init; }

        public float Volume { get; init; }

        public TimeSpan CrossfadeDuration { get; init; }
    }
}
