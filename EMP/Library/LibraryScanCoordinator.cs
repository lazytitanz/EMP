namespace EMP.Library
{
    /// <summary>
    /// Ensures only one full library scan runs at a time. Overlapping watcher/folder
    /// requests coalesce into a follow-up scan. Manual refresh request ids attach to
    /// the in-flight scan so every refresh receives a completion without an extra pass.
    /// </summary>
    internal sealed class LibraryScanCoordinator
    {
        private readonly object gate = new();
        private readonly List<string> pendingRequestIds = [];
        private bool running;
        private bool coalesce;
        private int generation;
        private bool disposed;

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
