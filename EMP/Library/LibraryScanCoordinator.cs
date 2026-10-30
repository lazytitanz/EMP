namespace EMP.Library
{
    /// <summary>
    /// Ensures only one full library scan runs at a time. Overlapping watcher/folder
    /// requests coalesce into a follow-up scan. Manual refresh request ids attach to
    /// the in-flight scan so every refresh receives a completion without an extra pass.
    /// Metadata edit sessions defer watcher-driven scans until targeted patching finishes.
    /// </summary>
    internal sealed class LibraryScanCoordinator
    {
        private readonly object gate = new();
        private readonly List<string> pendingRequestIds = [];
        private bool running;
        private bool coalesce;
        private int generation;
        private bool disposed;
        private int metadataEditSessions;
        private bool deferredWatcherRefresh;
        private bool deferredNeedsFullScan;

        public bool IsMetadataEditActive
        {
            get
            {
                lock (gate)
                {
                    return metadataEditSessions > 0;
                }
            }
        }

        public void BeginMetadataEditSession()
        {
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }

                metadataEditSessions++;
            }
        }

        /// <summary>
        /// Ends an edit session. Returns whether a full rescan should run because watchers
        /// observed unrelated library changes (creates/deletes/renames) during the session.
        /// </summary>
        public bool EndMetadataEditSession(bool editedPathsFullyPatched)
        {
            lock (gate)
            {
                if (disposed)
                {
                    return false;
                }

                if (metadataEditSessions > 0)
                {
                    metadataEditSessions--;
                }

                if (metadataEditSessions > 0)
                {
                    return false;
                }

                bool needsFullScan = deferredNeedsFullScan || (deferredWatcherRefresh && !editedPathsFullyPatched);
                deferredWatcherRefresh = false;
                deferredNeedsFullScan = false;
                return needsFullScan;
            }
        }

        /// <summary>
        /// Called when a watcher or folder-config change wants a refresh. During a metadata
        /// edit session the request is deferred instead of starting a scan.
        /// </summary>
        public bool TryDeferWatcherRefresh(bool requiresFullScan = false)
        {
            lock (gate)
            {
                if (disposed || metadataEditSessions <= 0)
                {
                    return false;
                }

                deferredWatcherRefresh = true;
                if (requiresFullScan)
                {
                    deferredNeedsFullScan = true;
                }

                return true;
            }
        }

        public void Request(string? requestId, Action<int> startScan)
        {
            ArgumentNullException.ThrowIfNull(startScan);

            int scanGeneration;
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }

                if (!string.IsNullOrWhiteSpace(requestId))
                {
                    pendingRequestIds.Add(requestId);
                }

                if (metadataEditSessions > 0)
                {
                    // Manual refresh ids wait; watcher-style requests (no id) are deferred.
                    if (string.IsNullOrWhiteSpace(requestId))
                    {
                        deferredWatcherRefresh = true;
                    }

                    return;
                }

                if (running)
                {
                    // Watcher / folder-config changes need a fresh pass after the current scan.
                    // Manual refresh ids ride the in-flight result instead of forcing another scan.
                    if (string.IsNullOrWhiteSpace(requestId))
                    {
                        coalesce = true;
                    }

                    return;
                }

                running = true;
                coalesce = false;
                scanGeneration = ++generation;
            }

            startScan(scanGeneration);
        }

        /// <summary>
        /// Takes request ids waiting for this completion. Call once per finished scan
        /// before <see cref="TryStartFollowUp"/>.
        /// </summary>
        public IReadOnlyList<string> TakeCompletionRequestIds()
        {
            lock (gate)
            {
                List<string> waiters = [.. pendingRequestIds];
                pendingRequestIds.Clear();
                return waiters;
            }
        }

        /// <summary>
        /// After delivering a scan result, start another scan when coalesced work remains.
        /// </summary>
        public bool TryStartFollowUp(int completedGeneration, Action<int> startScan)
        {
            ArgumentNullException.ThrowIfNull(startScan);

            int nextGeneration;
            lock (gate)
            {
                if (disposed || completedGeneration != generation)
                {
                    return false;
                }

                if (metadataEditSessions > 0)
                {
                    running = false;
                    if (coalesce)
                    {
                        deferredWatcherRefresh = true;
                        coalesce = false;
                    }

                    return false;
                }

                if (!coalesce && pendingRequestIds.Count == 0)
                {
                    running = false;
                    return false;
                }

                coalesce = false;
                nextGeneration = ++generation;
            }

            startScan(nextGeneration);
            return true;
        }

        public void Shutdown()
        {
            lock (gate)
            {
                disposed = true;
                running = false;
                coalesce = false;
                generation++;
                metadataEditSessions = 0;
                deferredWatcherRefresh = false;
                deferredNeedsFullScan = false;
                pendingRequestIds.Clear();
            }
        }

        public bool IsCurrent(int scanGeneration)
        {
            lock (gate)
            {
                return !disposed && scanGeneration == generation;
            }
        }
    }
}
