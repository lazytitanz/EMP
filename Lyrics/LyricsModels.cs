namespace EMP.Lyrics
{
    internal sealed class LrclibRecord
    {
        public long Id { get; init; }

        public string? TrackName { get; init; }

        public string? ArtistName { get; init; }

        public string? AlbumName { get; init; }

        public double? Duration { get; init; }

        public bool Instrumental { get; init; }

        public string? PlainLyrics { get; init; }

        public string? SyncedLyrics { get; init; }
    }

    internal sealed class LyricsLookup
    {
        public required string TrackId { get; init; }

        public required string Title { get; init; }

        public required string Artist { get; init; }

        public required string Album { get; init; }

        public double Duration { get; init; }
    }

    internal enum LyricsStatus
    {
        Found,
        NotFound,
        Failed
    }

    internal sealed class LyricsResult
    {
        public static LyricsResult NotFound { get; } = new() { Status = LyricsStatus.NotFound };

        public static LyricsResult Failed { get; } = new() { Status = LyricsStatus.Failed };

        public required LyricsStatus Status { get; init; }

        public long? LrclibId { get; init; }

        public string? SyncedLyrics { get; init; }

        public string? PlainLyrics { get; init; }

        public bool Instrumental { get; init; }
    }

    internal sealed class CachedLyrics
    {
        public int SchemaVersion { get; init; }

        public required string TrackId { get; init; }

        public required string Title { get; init; }

        public required string Artist { get; init; }

        public required string Album { get; init; }

        public double Duration { get; init; }

        public bool Found { get; init; }

        public long? LrclibId { get; init; }

        public string? SyncedLyrics { get; init; }

        public string? PlainLyrics { get; init; }

        public bool Instrumental { get; init; }

        public DateTimeOffset RetrievedAt { get; init; }
    }
}
