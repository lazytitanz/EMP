namespace EMP.Hosting
{
    internal sealed class InsightsLiveTrack
    {
        public string Title { get; init; } = string.Empty;

        public string Artist { get; init; } = string.Empty;

        public string Album { get; init; } = string.Empty;

        public bool InLibrary { get; init; }
    }

    internal sealed class ListeningInsightsTrackRow
    {
        public required string TrackId { get; init; }

        public required string Title { get; init; }

        public required string Artist { get; init; }

        public required string Album { get; init; }

        public long ListenMs { get; init; }

        public long PlayCount { get; init; }

        public bool InLibrary { get; init; }
    }

    internal sealed class ListeningInsightsArtistRow
    {
        public required string ArtistName { get; init; }

        public long ListenMs { get; init; }

        public long PlayCount { get; init; }

        public required IReadOnlyList<string> SampleTrackIds { get; init; }
    }

    internal sealed class ListeningInsightsActivityPoint
    {
        public required string Key { get; init; }

        public required string Label { get; init; }

        public long ListenMs { get; init; }

        public long PlayCount { get; init; }
    }

    internal sealed class ListeningInsightsHabit
    {
        public required string Id { get; init; }

        public required string Title { get; init; }

        public required string Body { get; init; }

        public string? TrackId { get; init; }

        public string? ArtistName { get; init; }
    }

    internal sealed class ListeningInsightsSnapshot
    {
        public long RequestId { get; init; }

        public required string Range { get; init; }

        public required string StartDate { get; init; }

        public required string EndDate { get; init; }

        public string? TrackingStartedOn { get; init; }

        public required string HistoryCoverage { get; init; }

        public string? HistoryCoverageStartDate { get; init; }

        public string? ActivityScopeLabel { get; init; }

        public long TotalListenMs { get; init; }

        public long TotalPlays { get; init; }

        public int UniqueTracks { get; init; }

        public int UniqueArtists { get; init; }

        public int TracksWithoutArtist { get; init; }

        public required string ArtistRankingCoverage { get; init; }

        public required IReadOnlyList<ListeningInsightsTrackRow> TopTracks { get; init; }

        public required IReadOnlyList<ListeningInsightsArtistRow> TopArtists { get; init; }

        public required IReadOnlyList<ListeningInsightsActivityPoint> Activity { get; init; }

        public required IReadOnlyList<ListeningInsightsHabit> Habits { get; init; }

        public bool HasLifetimeData { get; init; }

        public bool HasDailyData { get; init; }

        public bool ShowGenericEmpty { get; init; }
    }
}
