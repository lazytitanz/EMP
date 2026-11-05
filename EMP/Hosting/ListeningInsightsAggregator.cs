using System.Globalization;
using System.Text.RegularExpressions;

namespace EMP.Hosting
{
    /// <summary>
    /// Read-only aggregation of lifetime + daily listening stats for the Listening Insights UI.
    /// Does not redistribute lifetime totals across historical days.
    /// </summary>
    internal static class ListeningInsightsAggregator
    {
        private static readonly Regex MultiWhitespace = new(@"\s+", RegexOptions.Compiled);

        private static readonly object CacheGate = new();
        private static string? cacheKey;
        private static ListeningInsightsSnapshot? cacheSnapshot;

        public static ListeningInsightsSnapshot Build(
            string? rangeKey,
            long requestId,
            DateOnly? todayOverride = null,
            IReadOnlyDictionary<string, InsightsLiveTrack>? library = null)
        {
            DateOnly today = todayOverride ?? DateOnly.FromDateTime(DateTime.Now);
            string range = NormalizeRange(rangeKey);
            long revision = ListenStatsCoordinator.InsightsRevision;
            string todayKey = ListenLocalDates.FromDateTime(today.ToDateTime(TimeOnly.MinValue));
            string key = $"{range}|{todayKey}|{revision}|{requestId}";

            lock (CacheGate)
            {
                // Cache ignores requestId for payload reuse; requestId is stamped on clone.
                string dataKey = $"{range}|{todayKey}|{revision}";
                if (cacheSnapshot is not null
                    && string.Equals(cacheKey, dataKey, StringComparison.Ordinal))
                {
                    return CloneWithRequestId(cacheSnapshot, requestId);
                }
            }

            Dictionary<string, TrackListenStats> lifetime = ListenStatsStore.Snapshot();
            IReadOnlyDictionary<string, TrackListenIdentity> identities = ListenHistoryStore.SnapshotIdentities();
            string? trackingStartedOn = ListenHistoryStore.TrackingStartedOn;
            bool hasDailyData = ListenHistoryStore.HasAnyDailyData();
            bool hasLifetimeData = lifetime.Values.Any(static s => s.ListenMs > 0 || s.PlayCount > 0);

            (DateOnly requestedStart, DateOnly requestedEnd) = ResolveRangeBounds(range, today);
            DateOnly? trackingStart = ParseDay(trackingStartedOn);

            ListeningInsightsSnapshot snapshot = BuildCore(
                range,
                requestId,
                today,
                requestedStart,
                requestedEnd,
                trackingStart,
                trackingStartedOn,
                hasLifetimeData,
                hasDailyData,
                lifetime,
                identities,
                library);

            lock (CacheGate)
            {
                cacheKey = $"{range}|{todayKey}|{revision}";
                cacheSnapshot = snapshot;
            }

            return snapshot;
        }

        /// <summary>Test seam: build from in-memory inputs without touching durable stores.</summary>
        internal static ListeningInsightsSnapshot BuildCore(
            string range,
            long requestId,
            DateOnly today,
            DateOnly requestedStart,
            DateOnly requestedEnd,
            DateOnly? trackingStart,
            string? trackingStartedOn,
            bool hasLifetimeData,
            bool hasDailyData,
            IReadOnlyDictionary<string, TrackListenStats> lifetime,
            IReadOnlyDictionary<string, TrackListenIdentity> identities,
            IReadOnlyDictionary<string, InsightsLiveTrack>? library,
            IReadOnlyList<DayListenTotal>? dailyTotalsOverride = null,
            IReadOnlyDictionary<string, DayTrackListenStats>? periodTracksOverride = null)
        {
            range = NormalizeRange(range);
            bool isAllTime = range == "all";

            DateOnly effectiveStart = requestedStart;
            DateOnly effectiveEnd = requestedEnd;
            string historyCoverage;
            string? historyCoverageStartDate = null;

            if (!hasDailyData || trackingStart is null)
            {
                historyCoverage = "none";
            }
            else if (trackingStart > requestedEnd)
            {
                historyCoverage = "none";
            }
            else if (trackingStart > requestedStart)
            {
                historyCoverage = "partial";
                effectiveStart = trackingStart.Value;
                historyCoverageStartDate = FormatDay(effectiveStart);
            }
            else
            {
                historyCoverage = "full";
                effectiveStart = requestedStart;
            }

            if (isAllTime)
            {
                // Activity uses recorded history span only; totals use lifetime.
                historyCoverageStartDate = trackingStartedOn;
                if (!hasDailyData)
                {
                    historyCoverage = "none";
                }
                else if (trackingStart is not null)
                {
                    historyCoverage = "partial"; // All-time activity is never "full lifetime"
                    historyCoverageStartDate = FormatDay(trackingStart.Value);
                }
            }

            string startDate = FormatDay(isAllTime ? (trackingStart ?? requestedStart) : effectiveStart);
            string endDate = FormatDay(requestedEnd);

            Dictionary<string, DayTrackListenStats> periodTracks;
            if (periodTracksOverride is not null)
            {
                periodTracks = new Dictionary<string, DayTrackListenStats>(periodTracksOverride, StringComparer.OrdinalIgnoreCase);
            }
            else if (!isAllTime && historyCoverage != "none")
            {
                periodTracks = ListenHistoryStore.GetRange(FormatDay(effectiveStart), FormatDay(effectiveEnd));
            }
            else
            {
                periodTracks = [];
            }

            List<DayListenTotal> dailyTotals;
            if (dailyTotalsOverride is not null)
            {
                dailyTotals = dailyTotalsOverride.ToList();
            }
            else if (hasDailyData)
            {
                if (isAllTime)
                {
                    (string? first, string? last) = ListenHistoryStore.GetActivitySpan();
                    dailyTotals = first is not null && last is not null
                        ? ListenHistoryStore.GetDailyTotals(first, last)
                        : [];
                }
                else if (historyCoverage != "none")
                {
                    dailyTotals = ListenHistoryStore.GetDailyTotals(FormatDay(effectiveStart), FormatDay(effectiveEnd));
                }
                else
                {
                    dailyTotals = [];
                }
            }
            else
            {
                dailyTotals = [];
            }

            long totalListenMs;
            long totalPlays;
            int uniqueTracks;
            List<TrackAgg> trackUniverse;

            if (isAllTime)
            {
                trackUniverse = lifetime
                    .Where(static pair => pair.Value.ListenMs > 0 || pair.Value.PlayCount > 0)
                    .Select(pair => new TrackAgg(
                        pair.Key,
                        Math.Max(0, pair.Value.ListenMs),
                        Math.Max(0, pair.Value.PlayCount)))
                    .ToList();
                totalListenMs = trackUniverse.Sum(static t => t.ListenMs);
                totalPlays = trackUniverse.Sum(static t => t.PlayCount);
                uniqueTracks = trackUniverse.Count;
            }
            else
            {
                trackUniverse = periodTracks
                    .Where(static pair => pair.Value.ListenMs > 0 || pair.Value.PlayCount > 0)
                    .Select(pair => new TrackAgg(
                        pair.Key,
                        Math.Max(0, pair.Value.ListenMs),
                        Math.Max(0, pair.Value.PlayCount)))
                    .ToList();
                totalListenMs = trackUniverse.Sum(static t => t.ListenMs);
                totalPlays = trackUniverse.Sum(static t => t.PlayCount);
                uniqueTracks = trackUniverse.Count;
            }

            List<ResolvedTrack> resolved = trackUniverse
                .Select(track => ResolveTrack(track, identities, library))
                .ToList();

            int tracksWithoutArtist = resolved.Count(static t => !t.HasArtist);
            List<ResolvedTrack> identifiable = resolved.Where(static t => t.HasArtist).ToList();
            string artistRankingCoverage = ResolveArtistCoverage(resolved.Count, identifiable.Count, tracksWithoutArtist);

            List<ListeningInsightsTrackRow> topTracks = resolved
                .OrderByDescending(static t => t.ListenMs)
                .ThenByDescending(static t => t.PlayCount)
                .ThenBy(static t => t.TrackId, StringComparer.OrdinalIgnoreCase)
                .Take(5)
                .Select(static t => new ListeningInsightsTrackRow
                {
                    TrackId = t.TrackId,
                    Title = string.IsNullOrWhiteSpace(t.Title) ? "Unknown track" : t.Title,
                    Artist = t.HasArtist ? t.ArtistDisplay : "Unknown artist",
                    Album = t.Album,
                    ListenMs = t.ListenMs,
                    PlayCount = t.PlayCount,
                    InLibrary = t.InLibrary
                })
                .ToList();

            List<ListeningInsightsArtistRow> topArtists = BuildTopArtists(identifiable);

            List<ListeningInsightsActivityPoint> activity = BuildActivity(
                range,
                isAllTime,
                effectiveStart,
                effectiveEnd,
                trackingStart,
                dailyTotals,
                today);

            List<ListeningInsightsHabit> habits = BuildHabits(
                resolved,
                identifiable,
                topArtists,
                dailyTotals,
                effectiveStart,
                effectiveEnd,
                today,
                historyCoverage);

            bool showGenericEmpty = !hasLifetimeData && !hasDailyData;

            string? activityScopeLabel = null;
            if (isAllTime && hasDailyData)
            {
                activityScopeLabel = "Recorded daily history only";
            }
            else if (!isAllTime && historyCoverage == "partial" && historyCoverageStartDate is not null)
            {
                activityScopeLabel = $"Daily listening history since {FormatDisplayDate(historyCoverageStartDate)}";
            }

            return new ListeningInsightsSnapshot
            {
                RequestId = requestId,
                Range = range,
                StartDate = isAllTime ? (trackingStartedOn ?? startDate) : FormatDay(effectiveStart),
                EndDate = endDate,
                TrackingStartedOn = trackingStartedOn,
                HistoryCoverage = historyCoverage,
                HistoryCoverageStartDate = historyCoverageStartDate,
                ActivityScopeLabel = activityScopeLabel,
                TotalListenMs = totalListenMs,
                TotalPlays = totalPlays,
                UniqueTracks = uniqueTracks,
                UniqueArtists = CountUniqueArtists(identifiable),
                TracksWithoutArtist = tracksWithoutArtist,
                ArtistRankingCoverage = artistRankingCoverage,
                TopTracks = topTracks,
                TopArtists = topArtists,
                Activity = activity,
                Habits = habits,
                HasLifetimeData = hasLifetimeData,
                HasDailyData = hasDailyData,
                ShowGenericEmpty = showGenericEmpty
            };
        }

        public static void ClearCacheForTests()
        {
            lock (CacheGate)
            {
                cacheKey = null;
                cacheSnapshot = null;
            }
        }

        internal static string NormalizeArtistKey(string? artist)
        {
            if (string.IsNullOrWhiteSpace(artist))
            {
                return string.Empty;
            }

            string trimmed = artist.Trim();
            return MultiWhitespace.Replace(trimmed, " ").ToUpperInvariant();
        }

        internal static bool HasIdentifiableArtist(string? artist)
            => NormalizeArtistKey(artist).Length > 0;

        internal static string NormalizeRange(string? rangeKey)
        {
            return rangeKey?.Trim().ToLowerInvariant() switch
            {
                "last7" or "7" or "week" => "last7",
                "year" or "thisyear" or "ytd" => "year",
                "all" or "alltime" or "lifetime" => "all",
                _ => "last30"
            };
        }

        internal static (DateOnly Start, DateOnly End) ResolveRangeBounds(string range, DateOnly today)
        {
            return NormalizeRange(range) switch
            {
                "last7" => (today.AddDays(-6), today),
                "year" => (new DateOnly(today.Year, 1, 1), today),
                "all" => (new DateOnly(1970, 1, 1), today),
                _ => (today.AddDays(-29), today)
            };
        }

        internal static (int Current, int Longest) ComputeStreaks(
            IReadOnlyCollection<string> listeningDays,
            DateOnly windowStart,
            DateOnly windowEnd,
            DateOnly today)
        {
            HashSet<DateOnly> set = [];
            foreach (string day in listeningDays)
            {
                if (!ListenLocalDates.TryParse(day, out DateOnly date))
                {
                    continue;
                }

                if (date < windowStart || date > windowEnd)
                {
                    continue;
                }

                set.Add(date);
            }

            int longest = 0;
            int run = 0;
            for (DateOnly cursor = windowStart; cursor <= windowEnd; cursor = cursor.AddDays(1))
            {
                if (set.Contains(cursor))
                {
                    run++;
                    longest = Math.Max(longest, run);
                }
                else
                {
                    run = 0;
                }
            }

            int current = 0;
            DateOnly? anchor = null;
            if (set.Contains(today) && today >= windowStart && today <= windowEnd)
            {
                anchor = today;
            }
            else
            {
                DateOnly yesterday = today.AddDays(-1);
                if (set.Contains(yesterday) && yesterday >= windowStart && yesterday <= windowEnd)
                {
                    anchor = yesterday;
                }
            }

            if (anchor is not null)
            {
                for (DateOnly cursor = anchor.Value; cursor >= windowStart; cursor = cursor.AddDays(-1))
                {
                    if (!set.Contains(cursor))
                    {
                        break;
                    }

                    current++;
                }
            }

            return (current, longest);
        }

        private static ListeningInsightsSnapshot CloneWithRequestId(ListeningInsightsSnapshot source, long requestId)
        {
            return new ListeningInsightsSnapshot
            {
                RequestId = requestId,
                Range = source.Range,
                StartDate = source.StartDate,
                EndDate = source.EndDate,
                TrackingStartedOn = source.TrackingStartedOn,
                HistoryCoverage = source.HistoryCoverage,
                HistoryCoverageStartDate = source.HistoryCoverageStartDate,
                ActivityScopeLabel = source.ActivityScopeLabel,
                TotalListenMs = source.TotalListenMs,
                TotalPlays = source.TotalPlays,
                UniqueTracks = source.UniqueTracks,
                UniqueArtists = source.UniqueArtists,
                TracksWithoutArtist = source.TracksWithoutArtist,
                ArtistRankingCoverage = source.ArtistRankingCoverage,
                TopTracks = source.TopTracks,
                TopArtists = source.TopArtists,
                Activity = source.Activity,
                Habits = source.Habits,
                HasLifetimeData = source.HasLifetimeData,
                HasDailyData = source.HasDailyData,
                ShowGenericEmpty = source.ShowGenericEmpty
            };
        }

        private static ResolvedTrack ResolveTrack(
            TrackAgg track,
            IReadOnlyDictionary<string, TrackListenIdentity> identities,
            IReadOnlyDictionary<string, InsightsLiveTrack>? library)
        {
            identities.TryGetValue(track.TrackId, out TrackListenIdentity? identity);
            InsightsLiveTrack? live = null;
            if (library is not null)
            {
                library.TryGetValue(track.TrackId, out live);
            }

            string title = FirstNonEmpty(identity?.Title, live?.Title, "Unknown track");
            string artist = FirstNonEmpty(identity?.Artist, live?.Artist, string.Empty);
            string album = FirstNonEmpty(identity?.Album, live?.Album, string.Empty);
            bool inLibrary = live?.InLibrary == true;

            return new ResolvedTrack(
                track.TrackId,
                title,
                artist.Trim(),
                album,
                track.ListenMs,
                track.PlayCount,
                inLibrary,
                HasIdentifiableArtist(artist));
        }

        private static string ResolveArtistCoverage(int totalTracks, int identifiable, int withoutArtist)
        {
            if (totalTracks == 0)
            {
                return "unavailable";
            }

            if (identifiable == 0)
            {
                return "unavailable";
            }

            if (withoutArtist > 0)
            {
                return "partial";
            }

            return "complete";
        }

        private static List<ListeningInsightsArtistRow> BuildTopArtists(List<ResolvedTrack> identifiable)
        {
            Dictionary<string, ArtistAgg> map = new(StringComparer.Ordinal);
            foreach (ResolvedTrack track in identifiable)
            {
                string key = NormalizeArtistKey(track.ArtistDisplay);
                if (key.Length == 0)
                {
                    continue;
                }

                if (!map.TryGetValue(key, out ArtistAgg? agg))
                {
                    agg = new ArtistAgg(track.ArtistDisplay);
                    map[key] = agg;
                }

                agg.ListenMs += track.ListenMs;
                agg.PlayCount += track.PlayCount;
                if (agg.SampleTrackIds.Count < 4
                    && !agg.SampleTrackIds.Contains(track.TrackId, StringComparer.OrdinalIgnoreCase))
                {
                    agg.SampleTrackIds.Add(track.TrackId);
                }
            }

            return map.Values
                .OrderByDescending(static a => a.ListenMs)
                .ThenByDescending(static a => a.PlayCount)
                .ThenBy(static a => a.DisplayName, StringComparer.OrdinalIgnoreCase)
                .Take(5)
                .Select(static a => new ListeningInsightsArtistRow
                {
                    ArtistName = a.DisplayName,
                    ListenMs = a.ListenMs,
                    PlayCount = a.PlayCount,
                    SampleTrackIds = a.SampleTrackIds.ToList()
                })
                .ToList();
        }

        private static int CountUniqueArtists(List<ResolvedTrack> identifiable)
        {
            HashSet<string> keys = new(StringComparer.Ordinal);
            foreach (ResolvedTrack track in identifiable)
            {
                string key = NormalizeArtistKey(track.ArtistDisplay);
                if (key.Length > 0)
                {
                    keys.Add(key);
                }
            }

            return keys.Count;
        }

        private static List<ListeningInsightsActivityPoint> BuildActivity(
            string range,
            bool isAllTime,
            DateOnly effectiveStart,
            DateOnly effectiveEnd,
            DateOnly? trackingStart,
            List<DayListenTotal> dailyTotals,
            DateOnly today)
        {
            if (dailyTotals.Count == 0)
            {
                return [];
            }

            Dictionary<string, DayListenTotal> byDay = dailyTotals
                .ToDictionary(static d => d.Day, StringComparer.Ordinal);

            if (range is "last7" or "last30")
            {
                DateOnly start = effectiveStart;
                DateOnly end = effectiveEnd;
                List<ListeningInsightsActivityPoint> points = [];
                for (DateOnly cursor = start; cursor <= end; cursor = cursor.AddDays(1))
                {
                    string key = FormatDay(cursor);
                    byDay.TryGetValue(key, out DayListenTotal? row);
                    points.Add(new ListeningInsightsActivityPoint
                    {
                        Key = key,
                        Label = cursor.ToString("MMM d", CultureInfo.InvariantCulture),
                        ListenMs = row?.ListenMs ?? 0,
                        PlayCount = row?.PlayCount ?? 0
                    });
                }

                return points;
            }

            // Monthly aggregation for year / all-time history span.
            DateOnly spanStart = isAllTime
                ? (trackingStart ?? (ListenLocalDates.TryParse(dailyTotals[0].Day, out DateOnly first) ? first : today))
                : effectiveStart;
            DateOnly spanEnd = isAllTime
                ? (ListenLocalDates.TryParse(dailyTotals[^1].Day, out DateOnly last) ? last : today)
                : effectiveEnd;

            Dictionary<string, (long ListenMs, long PlayCount)> months = new(StringComparer.Ordinal);
            foreach (DayListenTotal day in dailyTotals)
            {
                if (!ListenLocalDates.TryParse(day.Day, out DateOnly date))
                {
                    continue;
                }

                if (date < spanStart || date > spanEnd)
                {
                    continue;
                }

                string monthKey = $"{date.Year:D4}-{date.Month:D2}";
                if (!months.TryGetValue(monthKey, out (long ListenMs, long PlayCount) agg))
                {
                    agg = (0, 0);
                }

                months[monthKey] = (agg.ListenMs + day.ListenMs, agg.PlayCount + day.PlayCount);
            }

            List<ListeningInsightsActivityPoint> monthly = [];
            DateOnly monthCursor = new(spanStart.Year, spanStart.Month, 1);
            DateOnly monthEnd = new(spanEnd.Year, spanEnd.Month, 1);
            while (monthCursor <= monthEnd)
            {
                string key = $"{monthCursor.Year:D4}-{monthCursor.Month:D2}";
                months.TryGetValue(key, out (long ListenMs, long PlayCount) agg);
                monthly.Add(new ListeningInsightsActivityPoint
                {
                    Key = key,
                    Label = monthCursor.ToString("MMM yyyy", CultureInfo.InvariantCulture),
                    ListenMs = agg.ListenMs,
                    PlayCount = agg.PlayCount
                });
                monthCursor = monthCursor.AddMonths(1);
            }

            return monthly;
        }

        private static List<ListeningInsightsHabit> BuildHabits(
            List<ResolvedTrack> resolved,
            List<ResolvedTrack> identifiable,
            List<ListeningInsightsArtistRow> topArtists,
            List<DayListenTotal> dailyTotals,
            DateOnly windowStart,
            DateOnly windowEnd,
            DateOnly today,
            string historyCoverage)
        {
            List<ListeningInsightsHabit> habits = [];

            ResolvedTrack? onRepeat = resolved
                .Where(static t => t.PlayCount > 0)
                .OrderByDescending(static t => t.PlayCount)
                .ThenByDescending(static t => t.ListenMs)
                .ThenBy(static t => t.TrackId, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
            if (onRepeat is not null && onRepeat.PlayCount >= 2)
            {
                habits.Add(new ListeningInsightsHabit
                {
                    Id = "onRepeat",
                    Title = "On Repeat",
                    Body = $"{onRepeat.Title} — {onRepeat.PlayCount} plays",
                    TrackId = onRepeat.TrackId
                });
            }

            DayListenTotal? mostActive = dailyTotals
                .Where(static d => d.ListenMs > 0)
                .OrderByDescending(static d => d.ListenMs)
                .ThenBy(static d => d.Day, StringComparer.Ordinal)
                .FirstOrDefault();
            if (mostActive is not null)
            {
                habits.Add(new ListeningInsightsHabit
                {
                    Id = "mostActiveDay",
                    Title = "Your most active day",
                    Body = $"{FormatDisplayDate(mostActive.Day)} · {FormatDuration(mostActive.ListenMs)}"
                });
            }

            ResolvedTrack? deepCut = resolved
                .Where(static t => t.PlayCount > 0 && t.PlayCount <= 2 && t.ListenMs >= 120_000)
                .OrderByDescending(static t => t.ListenMs)
                .ThenBy(static t => t.PlayCount)
                .ThenBy(static t => t.TrackId, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
            if (deepCut is not null)
            {
                habits.Add(new ListeningInsightsHabit
                {
                    Id = "deepCuts",
                    Title = "Deep cuts",
                    Body = $"{deepCut.Title} got {FormatDuration(deepCut.ListenMs)} across {deepCut.PlayCount} play{(deepCut.PlayCount == 1 ? "" : "s")}",
                    TrackId = deepCut.TrackId
                });
            }

            if (topArtists.Count > 0)
            {
                ListeningInsightsArtistRow favorite = topArtists[0];
                habits.Add(new ListeningInsightsHabit
                {
                    Id = "favoriteArtist",
                    Title = "Your favorite artist",
                    Body = $"{favorite.ArtistName} · {FormatDuration(favorite.ListenMs)}",
                    ArtistName = favorite.ArtistName
                });
            }

            if (historyCoverage != "none")
            {
                List<string> listeningDays = dailyTotals
                    .Where(static d => d.ListenMs > 0)
                    .Select(static d => d.Day)
                    .ToList();
                (int current, int longest) = ComputeStreaks(listeningDays, windowStart, windowEnd, today);
                if (current > 0)
                {
                    habits.Add(new ListeningInsightsHabit
                    {
                        Id = "listeningStreak",
                        Title = "Listening streak",
                        Body = current == 1
                            ? "1 day and counting"
                            : $"{current} days and counting"
                    });
                }
                else if (longest >= 2)
                {
                    habits.Add(new ListeningInsightsHabit
                    {
                        Id = "listeningStreak",
                        Title = "Longest streak",
                        Body = $"{longest} days in a row"
                    });
                }
            }

            return habits.Take(5).ToList();
        }

        private static string FormatDuration(long listenMs)
        {
            long totalMinutes = Math.Max(0, listenMs) / 60_000;
            if (totalMinutes < 60)
            {
                return $"{totalMinutes} min";
            }

            long hours = totalMinutes / 60;
            long minutes = totalMinutes % 60;
            return minutes == 0 ? $"{hours} hr" : $"{hours} hr {minutes} min";
        }

        private static string FormatDisplayDate(string yyyyMmDd)
        {
            if (!ListenLocalDates.TryParse(yyyyMmDd, out DateOnly date))
            {
                return yyyyMmDd;
            }

            return date.ToString("MMMM d, yyyy", CultureInfo.InvariantCulture);
        }

        private static string FormatDay(DateOnly date)
            => $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";

        private static DateOnly? ParseDay(string? key)
            => ListenLocalDates.TryParse(key, out DateOnly date) ? date : null;

        private static string FirstNonEmpty(params string?[] values)
        {
            foreach (string? value in values)
            {
                if (!string.IsNullOrWhiteSpace(value))
                {
                    return value.Trim();
                }
            }

            return string.Empty;
        }

        private sealed record TrackAgg(string TrackId, long ListenMs, long PlayCount);

        private sealed record ResolvedTrack(
            string TrackId,
            string Title,
            string ArtistDisplay,
            string Album,
            long ListenMs,
            long PlayCount,
            bool InLibrary,
            bool HasArtist);

        private sealed class ArtistAgg
        {
            public ArtistAgg(string displayName)
            {
                DisplayName = displayName;
            }

            public string DisplayName { get; }

            public long ListenMs { get; set; }

            public long PlayCount { get; set; }

            public List<string> SampleTrackIds { get; } = [];
        }
    }
}
