using EMP.Hosting;
using Xunit;

namespace EMP.Tests
{
    public sealed class ListenStatsRecoveryTests : IDisposable
    {
        private readonly string root;

        public ListenStatsRecoveryTests()
        {
            root = Path.Combine(Path.GetTempPath(), "EMP-listen-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            ListenStatsPaths.SetRootForTests(root);
            ListenStatsCoordinator.ResetForTests();
        }

        public void Dispose()
        {
            ListenStatsCoordinator.ResetForTests();
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
                // Temp cleanup is best-effort.
            }
        }

        [Fact]
        public void DuplicateUpdateId_IsRejectedAndDoesNotDoubleCount()
        {
            ListenStatsCoordinator.Load();

            Assert.True(Apply("session-a", 1, "track-1", playCount: 1, listenMs: 1000, day: "2026-10-27", dayMs: 1000));
            Assert.False(Apply("session-a", 1, "track-1", playCount: 1, listenMs: 1000, day: "2026-10-27", dayMs: 1000));
            Assert.True(ListenStatsCoordinator.PersistNowForTests());

            Dictionary<string, TrackListenStats> lifetime = ListenStatsStore.Snapshot();
            Assert.Equal(1, lifetime["track-1"].PlayCount);
            Assert.Equal(1000, lifetime["track-1"].ListenMs);

            IReadOnlyDictionary<string, DayTrackListenStats> day = ListenHistoryStore.GetDay("2026-10-27");
            Assert.Equal(1, day["track-1"].PlayCount);
            Assert.Equal(1000, day["track-1"].ListenMs);
        }

        [Fact]
        public void PersistAndReload_PreservesLifetimeAndHistory()
        {
            ListenStatsCoordinator.Load();
            Assert.True(Apply("session-b", 1, "track-2", playCount: 1, listenMs: 2500, day: "2026-10-28", dayMs: 2500));
            Assert.True(ListenStatsCoordinator.PersistNowForTests());

            ListenStatsCoordinator.ResetForTests();
            ListenStatsCoordinator.Load();

            Assert.Equal(1, ListenStatsStore.Snapshot()["track-2"].PlayCount);
            Assert.Equal(2500, ListenStatsStore.Snapshot()["track-2"].ListenMs);
            Assert.Equal(2500, ListenHistoryStore.GetDay("2026-10-28")["track-2"].ListenMs);
            Assert.True(ListenStatsCoordinator.PeekNextSeqForTests() > 1);
        }

        [Fact]
        public void PartialPersist_HistoryOnly_ReplaysIntoLifetimeWithoutDoubleCountingHistory()
        {
            ListenStatsCoordinator.Load();
            Assert.True(Apply("session-c", 1, "track-3", playCount: 1, listenMs: 4000, day: "2026-10-29", dayMs: 4000));
            Assert.True(ListenStatsCoordinator.PersistJournalAndHistoryOnlyForTests());

            // Simulate process restart: memory cleared, disk has history+journal but stale lifetime.
            ListenStatsCoordinator.ResetForTests();
            // Lifetime file should be missing / empty watermark.
            ListenStatsCoordinator.Load();

            Dictionary<string, TrackListenStats> lifetime = ListenStatsStore.Snapshot();
            Assert.Equal(1, lifetime["track-3"].PlayCount);
            Assert.Equal(4000, lifetime["track-3"].ListenMs);

            IReadOnlyDictionary<string, DayTrackListenStats> day = ListenHistoryStore.GetDay("2026-10-29");
            Assert.Equal(1, day["track-3"].PlayCount);
            Assert.Equal(4000, day["track-3"].ListenMs);

            Assert.True(ListenStatsCoordinator.PersistNowForTests());

            ListenStatsCoordinator.ResetForTests();
            ListenStatsCoordinator.Load();
            Assert.Equal(1, ListenHistoryStore.GetDay("2026-10-29")["track-3"].PlayCount);
            Assert.Equal(4000, ListenHistoryStore.GetDay("2026-10-29")["track-3"].ListenMs);
            Assert.Equal(1, ListenStatsStore.Snapshot()["track-3"].PlayCount);
        }

        [Fact]
        public void JournalCompaction_RemovesEntriesCoveredByBothWatermarks()
        {
            ListenStatsCoordinator.Load();
            Assert.True(Apply("session-d", 1, "track-4", playCount: 0, listenMs: 500, day: "2026-10-30", dayMs: 500));
            Assert.True(ListenStatsCoordinator.PersistNowForTests());

            Assert.Empty(ListenStatsCoordinator.PeekPendingEntriesForTests());
            ListenStatsJournalEnvelope journal = ListenStatsJournal.LoadOrEmpty(out bool quarantined);
            Assert.False(quarantined);
            Assert.Empty(journal.Entries);
            Assert.True(journal.NextSeq >= 2);
        }

        [Fact]
        public void NextSeq_IsStrictlyIncreasingAcrossRestartWhenJournalMissing()
        {
            ListenStatsCoordinator.Load();
            Assert.True(Apply("session-e", 1, "track-5", playCount: 1, listenMs: 100, day: "2026-10-31", dayMs: 100));
            Assert.True(ListenStatsCoordinator.PersistNowForTests());
            long afterFirst = ListenStatsCoordinator.PeekNextSeqForTests();

            File.Delete(ListenStatsPaths.ListenJournalFile);

            ListenStatsCoordinator.ResetForTests();
            ListenStatsCoordinator.Load();
            long afterReload = ListenStatsCoordinator.PeekNextSeqForTests();
            Assert.True(afterReload >= afterFirst);

            Assert.True(Apply("session-e2", 1, "track-5", playCount: 1, listenMs: 50, day: "2026-10-31", dayMs: 50));
            Assert.True(ListenStatsCoordinator.PeekNextSeqForTests() > afterReload);
        }

        [Fact]
        public void CorruptJournal_IsQuarantined_AndAggregatesRemainAuthoritative()
        {
            ListenStatsCoordinator.Load();
            Assert.True(Apply("session-f", 1, "track-6", playCount: 1, listenMs: 700, day: "2026-11-01", dayMs: 700));
            Assert.True(ListenStatsCoordinator.PersistNowForTests());

            File.WriteAllText(ListenStatsPaths.ListenJournalFile, "{ not-json");

            ListenStatsCoordinator.ResetForTests();
            ListenStatsCoordinator.Load();

            Assert.Equal(1, ListenStatsStore.Snapshot()["track-6"].PlayCount);
            Assert.Equal(700, ListenHistoryStore.GetDay("2026-11-01")["track-6"].ListenMs);

            bool foundQuarantine = Directory.GetFiles(root, "listen-stats-journal.json.corrupt-*").Length > 0;
            Assert.True(foundQuarantine);
        }

        [Fact]
        public void RangeAggregation_SumsDistinctDays()
        {
            ListenStatsCoordinator.Load();
            Assert.True(Apply("session-g", 1, "track-7", playCount: 1, listenMs: 100, day: "2026-11-02", dayMs: 100));
            Assert.True(Apply("session-g", 2, "track-7", playCount: 1, listenMs: 200, day: "2026-11-03", dayMs: 200));
            Assert.True(ListenStatsCoordinator.PersistNowForTests());

            Dictionary<string, DayTrackListenStats> range = ListenHistoryStore.GetRange("2026-11-02", "2026-11-03");
            Assert.Equal(2, range["track-7"].PlayCount);
            Assert.Equal(300, range["track-7"].ListenMs);
            Assert.Equal(300, ListenHistoryStore.TotalListenMs(range));
            Assert.Equal(1, ListenHistoryStore.DistinctTrackCount(range));
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
