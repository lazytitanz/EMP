namespace EMP.Hosting
{
    /// <summary>
    /// Coordinates lifetime stats, historical daily stats, and the durable update journal.
    /// ApplyUpdate never performs synchronous disk I/O; PersistDirty / FlushSync own writes.
    /// </summary>
    internal static class ListenStatsCoordinator
    {
        private const int FlushRetryLimit = 5;

        private static readonly object Gate = new();
        private static readonly object WriterGate = new();
        private static readonly List<ListenStatsJournalEntry> PendingEntries = [];

        private static string? sessionToken;
        private static long lastUpdateId;
        private static long nextSeq = 1;
        private static long dirtyGeneration;
        private static long persistedGeneration;
        private static System.Threading.Timer? debounceTimer;
        private static int writeQueued;
        private static bool loaded;

        public static void ResetForTests()
        {
            lock (WriterGate)
            {
                lock (Gate)
                {
                    sessionToken = null;
                    lastUpdateId = 0;
                    nextSeq = 1;
                    dirtyGeneration = 0;
                    persistedGeneration = 0;
                    PendingEntries.Clear();
                    loaded = false;
                    debounceTimer?.Change(Timeout.Infinite, Timeout.Infinite);
                }
            }

            ListenStatsStore.ResetForTests();
            ListenHistoryStore.ResetForTests();
        }

        public static void Load()
        {
            lock (WriterGate)
            {
                lock (Gate)
                {
                    Load_NoLock();
                }
            }
        }

        public static bool ApplyUpdate(
            string? sessionTokenValue,
            long updateId,
            string? trackId,
            long playCountDelta,
            long listenMsDelta,
            long lastPlayedAt,
            IReadOnlyDictionary<string, long>? dayListenMsDelta)
        {
            if (string.IsNullOrWhiteSpace(sessionTokenValue)
                || string.IsNullOrWhiteSpace(trackId)
                || updateId <= 0)
            {
                return false;
            }

            bool hasDayDelta = dayListenMsDelta is not null
                && dayListenMsDelta.Any(static pair => pair.Value > 0 && !string.IsNullOrWhiteSpace(pair.Key));

            if (playCountDelta == 0 && listenMsDelta == 0 && lastPlayedAt <= 0 && !hasDayDelta)
            {
                // Still consume the update id below so duplicates cannot re-enter with payload later.
            }

            bool scheduleSave = false;
            lock (Gate)
            {
                EnsureLoaded_NoLock();

                if (!string.Equals(sessionToken, sessionTokenValue, StringComparison.Ordinal))
                {
                    sessionToken = sessionTokenValue;
                    lastUpdateId = 0;
                }

                if (updateId <= lastUpdateId)
                {
                    return false;
                }

                lastUpdateId = updateId;

                if (playCountDelta == 0 && listenMsDelta == 0 && lastPlayedAt <= 0 && !hasDayDelta)
                {
                    return true;
                }

                Dictionary<string, long> dayDelta = NormalizeDayDelta(dayListenMsDelta);
                if (dayDelta.Count == 0 && listenMsDelta > 0)
                {
                    // Legacy payloads without day buckets: attribute listen time to local today / lastPlayedAt day.
                    string day = lastPlayedAt > 0
                        ? ListenLocalDates.FromUnixMilliseconds(lastPlayedAt)
                        : ListenLocalDates.FromDateTime(DateTime.Now);
                    dayDelta[day] = listenMsDelta;
                }

                long seq = nextSeq++;
                var entry = new ListenStatsJournalEntry
                {
                    Seq = seq,
                    SessionToken = sessionTokenValue,
                    UpdateId = updateId,
                    TrackId = trackId,
                    PlayCountDelta = Math.Max(0, playCountDelta),
                    ListenMsDelta = Math.Max(0, listenMsDelta),
                    LastPlayedAt = Math.Max(0, lastPlayedAt),
                    DayListenMsDelta = dayDelta
                };

                ApplyEntryToStores_NoLock(entry);
                PendingEntries.Add(CloneEntry(entry));
                dirtyGeneration++;
                scheduleSave = true;
            }

            if (scheduleSave)
            {
                ScheduleDebouncedSave();
            }

            return true;
        }

        public static void FlushSync()
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                debounceTimer?.Change(Timeout.Infinite, Timeout.Infinite);
            }

            lock (WriterGate)
            {
                for (int attempt = 0; attempt < FlushRetryLimit; attempt++)
                {
                    bool dirty;
                    lock (Gate)
                    {
                        dirty = dirtyGeneration > persistedGeneration;
                    }

                    if (!dirty)
                    {
                        return;
                    }

                    if (!PersistDirty_NoWriterLock())
                    {
                        continue;
                    }
                }
            }
        }

        /// <summary>
        /// Test seam: run one persist cycle under the writer gate.
        /// </summary>
        public static bool PersistNowForTests()
        {
            lock (WriterGate)
            {
                return PersistDirty_NoWriterLock();
            }
        }

        /// <summary>
        /// Test seam: write journal + history only (simulates crash before lifetime write).
        /// </summary>
        public static bool PersistJournalAndHistoryOnlyForTests()
        {
            lock (WriterGate)
            {
                long flushSeq;
                ListenStatsJournalEnvelope journalEnvelope;
                ListenHistoryEnvelope historyEnvelope;
                lock (Gate)
                {
                    EnsureLoaded_NoLock();
                    if (dirtyGeneration <= persistedGeneration && PendingEntries.Count == 0)
                    {
                        return true;
                    }

                    flushSeq = PendingEntries.Count > 0
                        ? PendingEntries.Max(static e => e.Seq)
                        : Math.Max(ListenStatsStore.LastJournalSeq, ListenHistoryStore.LastJournalSeq);

                    ListenHistoryStore.EnsureTrackingStartedOn();
                    historyEnvelope = ListenHistoryStore.CaptureEnvelope();
                    historyEnvelope.LastJournalSeq = Math.Max(historyEnvelope.LastJournalSeq, flushSeq);

                    journalEnvelope = BuildJournalEnvelope_NoLock();
                }

                if (!ListenStatsJournal.TryWrite(journalEnvelope))
                {
                    return false;
                }

                if (!ListenHistoryStore.TryWriteEnvelope(historyEnvelope))
                {
                    return false;
                }

                ListenHistoryStore.SetLastJournalSeq(flushSeq);
                // Intentionally skip lifetime write and compaction.
                return true;
            }
        }

        public static long PeekNextSeqForTests()
        {
            lock (Gate)
            {
                EnsureLoaded_NoLock();
                return nextSeq;
            }
        }

        public static IReadOnlyList<ListenStatsJournalEntry> PeekPendingEntriesForTests()
        {
            lock (Gate)
            {
                return PendingEntries.Select(CloneEntry).ToArray();
            }
        }

        private static void Load_NoLock()
        {
            sessionToken = null;
            lastUpdateId = 0;
            dirtyGeneration = 0;
            persistedGeneration = 0;
            PendingEntries.Clear();
            loaded = true;

            ListenStatsStore.LoadDiskOnly();
            ListenHistoryStore.Load();

            ListenStatsJournalEnvelope journal = ListenStatsJournal.LoadOrEmpty(out _);
            long highWater = Math.Max(ListenStatsStore.LastJournalSeq, ListenHistoryStore.LastJournalSeq);

            foreach (ListenStatsJournalEntry entry in journal.Entries ?? [])
            {
                if (entry.Seq > highWater)
                {
                    highWater = entry.Seq;
                }
            }

            if (journal.NextSeq - 1 > highWater)
            {
                highWater = journal.NextSeq - 1;
            }

            nextSeq = Math.Max(1, highWater + 1);

            // Replay pending journal entries into whichever aggregate lagged.
            List<ListenStatsJournalEntry> retained = [];
            bool replayed = false;
            foreach (ListenStatsJournalEntry entry in (journal.Entries ?? []).OrderBy(static e => e.Seq))
            {
                if (string.IsNullOrWhiteSpace(entry.TrackId) || entry.Seq <= 0)
                {
                    continue;
                }

                bool needLifetime = entry.Seq > ListenStatsStore.LastJournalSeq;
                bool needHistory = entry.Seq > ListenHistoryStore.LastJournalSeq;
                if (!needLifetime && !needHistory)
                {
                    continue;
                }

                replayed = true;

                if (needLifetime)
                {
                    ListenStatsStore.ApplyDelta(
                        entry.TrackId,
                        entry.PlayCountDelta,
                        entry.ListenMsDelta,
                        entry.LastPlayedAt);
                    ListenStatsStore.SetLastJournalSeq(entry.Seq);
                }

                if (needHistory)
                {
                    ListenHistoryStore.ApplyEntry(
                        entry.TrackId,
                        entry.PlayCountDelta,
                        entry.LastPlayedAt,
                        entry.DayListenMsDelta);
                    ListenHistoryStore.SetLastJournalSeq(entry.Seq);
                }

                retained.Add(CloneEntry(entry));
            }

            PendingEntries.AddRange(retained);

            long minWatermark = Math.Min(ListenStatsStore.LastJournalSeq, ListenHistoryStore.LastJournalSeq);
            PendingEntries.RemoveAll(entry => entry.Seq <= minWatermark);

            // Replayed updates must be flushed so the lagging aggregate file catches up,
            // even when in-memory watermarks already match after replay.
            if (replayed
                || PendingEntries.Count > 0
                || ListenStatsStore.LastJournalSeq != ListenHistoryStore.LastJournalSeq)
            {
                dirtyGeneration++;
                ScheduleDebouncedSave();
            }
        }

        private static void EnsureLoaded_NoLock()
        {
            if (!loaded)
            {
                Load_NoLock();
            }
        }

        private static void ApplyEntryToStores_NoLock(ListenStatsJournalEntry entry)
        {
            ListenStatsStore.ApplyDelta(
                entry.TrackId,
                entry.PlayCountDelta,
                entry.ListenMsDelta,
                entry.LastPlayedAt);
            ListenStatsStore.SetLastJournalSeq(entry.Seq);

            ListenHistoryStore.ApplyEntry(
                entry.TrackId,
                entry.PlayCountDelta,
                entry.LastPlayedAt,
                entry.DayListenMsDelta);
            ListenHistoryStore.SetLastJournalSeq(entry.Seq);
            ListenHistoryStore.EnsureTrackingStartedOn();
        }

        private static void ScheduleDebouncedSave()
        {
            lock (Gate)
            {
                debounceTimer ??= new System.Threading.Timer(_ => OnDebounceElapsed(), null, Timeout.Infinite, Timeout.Infinite);
                debounceTimer.Change(3000, Timeout.Infinite);
            }
        }

        private static void OnDebounceElapsed()
        {
            if (Interlocked.CompareExchange(ref writeQueued, 1, 0) != 0)
            {
                return;
            }

            try
            {
                Task.Run(() =>
                {
                    try
                    {
                        lock (WriterGate)
                        {
                            PersistDirty_NoWriterLock();
                        }
                    }
                    finally
                    {
                        Interlocked.Exchange(ref writeQueued, 0);

                        bool stillDirty;
                        lock (Gate)
                        {
                            stillDirty = dirtyGeneration > persistedGeneration;
                        }

                        if (stillDirty)
                        {
                            ScheduleDebouncedSave();
                        }
                    }
                });
            }
            catch (Exception)
            {
                Interlocked.Exchange(ref writeQueued, 0);
            }
        }

        private static bool PersistDirty_NoWriterLock()
        {
            long generation;
            long flushSeq;
            ListenStatsJournalEnvelope journalEnvelope;
            ListenHistoryEnvelope historyEnvelope;
            ListenStatsEnvelope lifetimeEnvelope;

            lock (Gate)
            {
                EnsureLoaded_NoLock();
                if (dirtyGeneration <= persistedGeneration)
                {
                    return true;
                }

                generation = dirtyGeneration;
                flushSeq = PendingEntries.Count > 0
                    ? PendingEntries.Max(static e => e.Seq)
                    : Math.Max(ListenStatsStore.LastJournalSeq, ListenHistoryStore.LastJournalSeq);

                ListenHistoryStore.EnsureTrackingStartedOn();
                historyEnvelope = ListenHistoryStore.CaptureEnvelope();
                historyEnvelope.LastJournalSeq = Math.Max(historyEnvelope.LastJournalSeq, flushSeq);

                lifetimeEnvelope = ListenStatsStore.CaptureEnvelope();
                lifetimeEnvelope.LastJournalSeq = Math.Max(lifetimeEnvelope.LastJournalSeq, flushSeq);

                journalEnvelope = BuildJournalEnvelope_NoLock();
            }

            // 1) Journal first so accepted updates survive if aggregates fail mid-write.
            if (!ListenStatsJournal.TryWrite(journalEnvelope))
            {
                return false;
            }

            // 2) History aggregate with watermark.
            if (!ListenHistoryStore.TryWriteEnvelope(historyEnvelope))
            {
                return false;
            }

            ListenHistoryStore.SetLastJournalSeq(flushSeq);

            // 3) Lifetime aggregate with watermark.
            if (!ListenStatsStore.TryWriteEnvelope(lifetimeEnvelope))
            {
                return false;
            }

            ListenStatsStore.SetLastJournalSeq(flushSeq);

            // 4) Compact journal to entries not covered by both watermarks.
            long minWatermark;
            ListenStatsJournalEnvelope compacted;
            lock (Gate)
            {
                minWatermark = Math.Min(ListenStatsStore.LastJournalSeq, ListenHistoryStore.LastJournalSeq);
                PendingEntries.RemoveAll(entry => entry.Seq <= minWatermark);
                compacted = BuildJournalEnvelope_NoLock();
            }

            if (!ListenStatsJournal.TryWrite(compacted))
            {
                // Aggregates are durable; compaction can retry later.
                lock (Gate)
                {
                    if (generation > persistedGeneration)
                    {
                        dirtyGeneration++;
                    }
                }

                return false;
            }

            lock (Gate)
            {
                if (generation > persistedGeneration)
                {
                    persistedGeneration = generation;
                }
            }

            return true;
        }

        private static ListenStatsJournalEnvelope BuildJournalEnvelope_NoLock()
        {
            return new ListenStatsJournalEnvelope
            {
                SchemaVersion = ListenStatsJournal.SchemaVersion,
                NextSeq = nextSeq,
                Entries = PendingEntries.Select(CloneEntry).OrderBy(static e => e.Seq).ToList()
            };
        }

        private static Dictionary<string, long> NormalizeDayDelta(IReadOnlyDictionary<string, long>? dayListenMsDelta)
        {
            Dictionary<string, long> dayDelta = new(StringComparer.Ordinal);
            if (dayListenMsDelta is null)
            {
                return dayDelta;
            }

            foreach (KeyValuePair<string, long> pair in dayListenMsDelta)
            {
                if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value <= 0)
                {
                    continue;
                }

                if (!ListenLocalDates.TryParse(pair.Key, out _))
                {
                    continue;
                }

                dayDelta[pair.Key] = dayDelta.TryGetValue(pair.Key, out long existing)
                    ? existing + pair.Value
                    : pair.Value;
            }

            return dayDelta;
        }

        private static ListenStatsJournalEntry CloneEntry(ListenStatsJournalEntry entry)
        {
            return new ListenStatsJournalEntry
            {
                Seq = entry.Seq,
                SessionToken = entry.SessionToken,
                UpdateId = entry.UpdateId,
                TrackId = entry.TrackId,
                PlayCountDelta = entry.PlayCountDelta,
                ListenMsDelta = entry.ListenMsDelta,
                LastPlayedAt = entry.LastPlayedAt,
                DayListenMsDelta = new Dictionary<string, long>(entry.DayListenMsDelta ?? [], StringComparer.Ordinal)
            };
        }
    }
}
