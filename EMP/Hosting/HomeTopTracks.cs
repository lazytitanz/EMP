namespace EMP.Hosting
{
    internal sealed class HomeTopTrackRow
    {
        public required string TrackId { get; init; }

        public long PlayCount { get; init; }
    }

    internal sealed class HomeTopTracksResult
    {
        /// <summary>Calendar month the ranking covers, as YYYY-MM.</summary>
        public required string Month { get; init; }

        public required string StartDate { get; init; }

        public required string EndDate { get; init; }

        /// <summary>
        /// Set when daily history began inside this month (YYYY-MM-DD); the ranking then only
        /// covers part of the month and the UI must say so.
        /// </summary>
        public string? CoverageStartDate { get; init; }

        public required IReadOnlyList<HomeTopTrackRow> Tracks { get; init; }
    }

    /// <summary>
    /// Calendar-month ranking of qualified plays for Home, read from the per-day play counts in
    /// <see cref="ListenHistoryStore"/>. Never falls back to lifetime counts.
    /// </summary>
    internal static class HomeTopTracks
    {
        public const int DefaultLimit = 5;
        public const int MaxLimit = 25;

        public static bool TryParseMonth(string? value, out int year, out int month)
        {
            year = 0;
            month = 0;
            if (string.IsNullOrWhiteSpace(value) || value.Length != 7 || value[4] != '-')
            {
                return false;
            }

            return int.TryParse(value.AsSpan(0, 4), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out year)
                && int.TryParse(value.AsSpan(5, 2), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out month)
                && year is >= 1970 and <= 9999
                && month is >= 1 and <= 12;
        }

        public static HomeTopTracksResult Build(
            int year,
            int month,
            ISet<string>? libraryTrackIds,
            int limit = DefaultLimit)
        {
            string start = $"{year:D4}-{month:D2}-01";
            string end = $"{year:D4}-{month:D2}-{DateTime.DaysInMonth(year, month):D2}";
            Dictionary<string, DayTrackListenStats> stats = ListenHistoryStore.GetRange(start, end);
            string? trackingStartedOn = ListenHistoryStore.TrackingStartedOn;

            return new HomeTopTracksResult
            {
                Month = $"{year:D4}-{month:D2}",
                StartDate = start,
                EndDate = end,
                CoverageStartDate = PartialCoverageStart(trackingStartedOn, start, end),
                Tracks = Rank(stats, libraryTrackIds, limit)
            };
        }

        internal static string? PartialCoverageStart(string? trackingStartedOn, string monthStart, string monthEnd)
        {
            if (!ListenLocalDates.TryParse(trackingStartedOn, out _))
            {
                return null;
            }

            return string.CompareOrdinal(trackingStartedOn, monthStart) > 0
                && string.CompareOrdinal(trackingStartedOn, monthEnd) <= 0
                ? trackingStartedOn
                : null;
        }

        internal static IReadOnlyList<HomeTopTrackRow> Rank(
            IReadOnlyDictionary<string, DayTrackListenStats> monthStats,
            ISet<string>? libraryTrackIds,
            int limit)
        {
            int take = Math.Clamp(limit, 1, MaxLimit);
            return monthStats
                .Where(pair => pair.Value.PlayCount > 0
                    && !string.IsNullOrWhiteSpace(pair.Key)
                    && (libraryTrackIds is null || libraryTrackIds.Contains(pair.Key)))
                .OrderByDescending(static pair => pair.Value.PlayCount)
                .ThenByDescending(static pair => pair.Value.ListenMs)
                .ThenBy(static pair => pair.Key, StringComparer.Ordinal)
                .Take(take)
                .Select(static pair => new HomeTopTrackRow
                {
                    TrackId = pair.Key,
                    PlayCount = pair.Value.PlayCount
                })
                .ToList();
        }
    }
}
