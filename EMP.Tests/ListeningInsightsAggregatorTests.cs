using EMP.Hosting;
using Xunit;

namespace EMP.Tests
{
    [CollectionDefinition("ListenStatsPaths")]
    public sealed class ListenStatsPathsCollection
    {
    }

    [Collection("ListenStatsPaths")]
    public sealed class ListeningInsightsAggregatorTests : IDisposable
    {
        private readonly string root;

        public ListeningInsightsAggregatorTests()
        {
            root = Path.Combine(Path.GetTempPath(), "EMP-insights-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            ListenStatsPaths.SetRootForTests(root);
            ListenStatsCoordinator.ResetForTests();
            ListeningInsightsAggregator.ClearCacheForTests();
        }

        public void Dispose()
        {
            ListenStatsCoordinator.ResetForTests();
            ListeningInsightsAggregator.ClearCacheForTests();
            ListenStatsPaths.SetRootForTests(null);
            try
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, recursive: true);
                }
            }
            catch (Exception)
            {
                // Best-effort temp cleanup.
            }
        }

        [Fact]
        public void NormalizeArtistKey_CollapsesCaseAndWhitespace_DoesNotSplitCollaborations()
        {
            Assert.Equal(
                ListeningInsightsAggregator.NormalizeArtistKey("  Foo   Bar "),
                ListeningInsightsAggregator.NormalizeArtistKey("foo bar"));
            Assert.True(ListeningInsightsAggregator.HasIdentifiableArtist("A feat. B"));
            Assert.False(ListeningInsightsAggregator.HasIdentifiableArtist("   "));
            Assert.Equal(
                ListeningInsightsAggregator.NormalizeArtistKey("A & B"),
                ListeningInsightsAggregator.NormalizeArtistKey("a & b"));
            Assert.NotEqual(
                ListeningInsightsAggregator.NormalizeArtistKey("A & B"),
                ListeningInsightsAggregator.NormalizeArtistKey("A"));
        }

        [Fact]
        public void ComputeStreaks_CurrentRemainsActiveWhenYesterdayListenedButNotToday()
        {
            DateOnly today = new(2026, 11, 4);
            DateOnly start = new(2026, 11, 1);
            string[] days = ["2026-11-02", "2026-11-03"]; // yesterday + day before

            (int current, int longest) = ListeningInsightsAggregator.ComputeStreaks(days, start, today, today);
            Assert.Equal(2, current);
            Assert.Equal(2, longest);
        }

        [Fact]
        public void ComputeStreaks_IgnoresDaysBeforeWindowStart()
        {
            DateOnly today = new(2026, 11, 4);
            DateOnly start = new(2026, 11, 2); // tracking started mid-window
            string[] days = ["2026-11-01", "2026-11-02", "2026-11-03"];

            (int current, int longest) = ListeningInsightsAggregator.ComputeStreaks(days, start, today, today);
            Assert.Equal(2, current);
            Assert.Equal(2, longest);
        }

        [Fact]
        public void PeriodRange_UsesDailyHistoryOnly_AndClipsToTrackingStart()
        {
            DateOnly today = new(2026, 11, 10);
            Dictionary<string, DayTrackListenStats> period = new(StringComparer.OrdinalIgnoreCase)
            {
                ["t1"] = new DayTrackListenStats { ListenMs = 120_000, PlayCount = 2 },
                ["t2"] = new DayTrackListenStats { ListenMs = 60_000, PlayCount = 1 }
            };
            Dictionary<string, TrackListenIdentity> identities = new(StringComparer.OrdinalIgnoreCase)
            {
                ["t1"] = new TrackListenIdentity { Title = "Song One", Artist = "Artist A", Album = "Alb" },
                ["t2"] = new TrackListenIdentity { Title = "Song Two", Artist = "Artist B", Album = "Alb" }
            };
            List<DayListenTotal> daily =
            [
                new() { Day = "2026-11-05", ListenMs = 90_000, PlayCount = 1 },
                new() { Day = "2026-11-08", ListenMs = 90_000, PlayCount = 2 }
            ];

            ListeningInsightsSnapshot snap = ListeningInsightsAggregator.BuildCore(
                range: "last30",
                requestId: 7,
                today: today,
                requestedStart: today.AddDays(-29),
                requestedEnd: today,
                trackingStart: new DateOnly(2026, 11, 5),
                trackingStartedOn: "2026-11-05",
                hasLifetimeData: true,
                hasDailyData: true,
                lifetime: new Dictionary<string, TrackListenStats>(StringComparer.OrdinalIgnoreCase)
                {
                    ["t1"] = new TrackListenStats { ListenMs = 999_999, PlayCount = 99 }
                },
                identities: identities,
                library: null,
                dailyTotalsOverride: daily,
                periodTracksOverride: period);

            Assert.Equal(7, snap.RequestId);
            Assert.Equal("partial", snap.HistoryCoverage);
            Assert.Equal("2026-11-05", snap.HistoryCoverageStartDate);
            Assert.Equal(180_000, snap.TotalListenMs); // period only, not lifetime
            Assert.Equal(3, snap.TotalPlays);
            Assert.Equal(2, snap.UniqueTracks);
            Assert.Equal(2, snap.UniqueArtists);
            Assert.Equal("complete", snap.ArtistRankingCoverage);
            Assert.Equal("Song One", snap.TopTracks[0].Title);
            Assert.Equal("Artist A", snap.TopArtists[0].ArtistName);
            Assert.False(snap.ShowGenericEmpty);
        }

        [Fact]
        public void AllTime_PreservesLifetimeTotals_MarksPartialArtistCoverage()
        {
            DateOnly today = new(2026, 11, 10);
            Dictionary<string, TrackListenStats> lifetime = new(StringComparer.OrdinalIgnoreCase)
            {
                ["known"] = new TrackListenStats { ListenMs = 300_000, PlayCount = 4 },
                ["mystery"] = new TrackListenStats { ListenMs = 200_000, PlayCount = 3 }
            };
            Dictionary<string, TrackListenIdentity> identities = new(StringComparer.OrdinalIgnoreCase)
            {
                ["known"] = new TrackListenIdentity { Title = "Known", Artist = "Visible Artist", Album = "A" },
                ["mystery"] = new TrackListenIdentity { Title = "Mystery", Artist = "", Album = "B" }
            };

            ListeningInsightsSnapshot snap = ListeningInsightsAggregator.BuildCore(
                range: "all",
                requestId: 1,
                today: today,
                requestedStart: new DateOnly(1970, 1, 1),
                requestedEnd: today,
                trackingStart: new DateOnly(2026, 11, 1),
                trackingStartedOn: "2026-11-01",
                hasLifetimeData: true,
                hasDailyData: false,
                lifetime: lifetime,
                identities: identities,
                library: null,
                dailyTotalsOverride: Array.Empty<DayListenTotal>(),
                periodTracksOverride: new Dictionary<string, DayTrackListenStats>(StringComparer.OrdinalIgnoreCase));

            Assert.Equal(500_000, snap.TotalListenMs);
            Assert.Equal(7, snap.TotalPlays);
            Assert.Equal(2, snap.UniqueTracks);
            Assert.Equal(1, snap.UniqueArtists);
            Assert.Equal(1, snap.TracksWithoutArtist);
            Assert.Equal("partial", snap.ArtistRankingCoverage);
            Assert.Single(snap.TopArtists);
            Assert.Equal("Visible Artist", snap.TopArtists[0].ArtistName);
            Assert.Equal(2, snap.TopTracks.Count);
            Assert.True(snap.HasLifetimeData);
            Assert.False(snap.HasDailyData);
            Assert.False(snap.ShowGenericEmpty);
            Assert.Empty(snap.Activity);
        }

        [Fact]
        public void TrueEmpty_ShowsGenericEmpty()
        {
            DateOnly today = new(2026, 11, 10);
            ListeningInsightsSnapshot snap = ListeningInsightsAggregator.BuildCore(
                range: "last30",
                requestId: 3,
                today: today,
                requestedStart: today.AddDays(-29),
                requestedEnd: today,
                trackingStart: null,
                trackingStartedOn: null,
                hasLifetimeData: false,
                hasDailyData: false,
                lifetime: new Dictionary<string, TrackListenStats>(StringComparer.OrdinalIgnoreCase),
                identities: new Dictionary<string, TrackListenIdentity>(StringComparer.OrdinalIgnoreCase),
                library: null);

            Assert.True(snap.ShowGenericEmpty);
            Assert.Equal("none", snap.HistoryCoverage);
            Assert.Equal("unavailable", snap.ArtistRankingCoverage);
        }

        [Fact]
        public void InsightsRevision_AdvancesOnApply()
        {
            ListenStatsCoordinator.Load();
            long before = ListenStatsCoordinator.InsightsRevision;
            Assert.True(Apply("rev", 1, "track-r", 1, 1000, "2026-11-04", 1000));
            long after = ListenStatsCoordinator.InsightsRevision;
            Assert.True(after > before);
        }

        [Fact]
        public void Cache_InvalidatesWhenRevisionChanges()
        {
            ListenStatsCoordinator.Load();
            Assert.True(Apply("cache", 1, "track-c", 1, 5000, "2026-11-04", 5000));
            SeedIdentity("track-c", "Cached", "Artist C");
            ListeningInsightsAggregator.ClearCacheForTests();

            ListeningInsightsSnapshot first = ListeningInsightsAggregator.Build("last7", requestId: 10);
            Assert.Equal(5000, first.TotalListenMs);

            Assert.True(Apply("cache", 2, "track-c", 1, 2000, "2026-11-04", 2000));
            ListeningInsightsSnapshot second = ListeningInsightsAggregator.Build("last7", requestId: 11);
            Assert.Equal(7000, second.TotalListenMs);
            Assert.Equal(11, second.RequestId);
        }

        [Fact]
        public void YearBounds_UseLocalCalendarYear()
        {
            DateOnly today = new(2026, 6, 15);
            (DateOnly start, DateOnly end) = ListeningInsightsAggregator.ResolveRangeBounds("year", today);
            Assert.Equal(new DateOnly(2026, 1, 1), start);
            Assert.Equal(today, end);
        }

        private static void SeedIdentity(string trackId, string title, string artist)
        {
            ListenHistoryEnvelope envelope = ListenHistoryStore.CaptureEnvelope();
            envelope.Identities[trackId] = new TrackListenIdentity
            {
                Title = title,
                Artist = artist,
                Album = "Test",
                DurationSec = 200
            };
            ListenHistoryStore.ReplaceFromEnvelope(envelope);
        }

        private static bool Apply(
            string token,
            long updateId,
            string trackId,
            long playCount,
            long listenMs,
            string day,
            long dayMs)
        {
            long lastPlayedAt = 0;
            if (playCount > 0)
            {
                DateTime localNoon = DateOnly.Parse(day).ToDateTime(new TimeOnly(12, 0));
                lastPlayedAt = new DateTimeOffset(localNoon, TimeZoneInfo.Local.GetUtcOffset(localNoon))
                    .ToUnixTimeMilliseconds();
            }

            return ListenStatsCoordinator.ApplyUpdate(
                token,
                updateId,
                trackId,
                playCount,
                listenMs,
                lastPlayedAt,
                new Dictionary<string, long>(StringComparer.Ordinal) { [day] = dayMs });
        }
    }
}
