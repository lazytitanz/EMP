using EMP.Library;

namespace EMP.Hosting
{
    internal sealed class MusicFolderWatchers : IDisposable
    {
        private const int DebounceMs = 600;
        private const int BufferSize = 64 * 1024;

        private readonly object gate = new();
        private readonly Dictionary<string, FileSystemWatcher> watchers = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, System.Threading.Timer> debounceTimers = new(StringComparer.OrdinalIgnoreCase);
        private readonly Action onRefreshNeeded;
        private bool disposed;

        public MusicFolderWatchers(Action onRefreshNeeded)
        {
            this.onRefreshNeeded = onRefreshNeeded;
        }

        public void Sync(IEnumerable<string> availableRoots)
        {
            HashSet<string> wanted = new(StringComparer.OrdinalIgnoreCase);
            foreach (string root in availableRoots)
            {
                string? normalized = MusicFolderPaths.TryNormalize(root);
                if (normalized is not null && Directory.Exists(normalized))
                {
                    wanted.Add(normalized);
                }
            }

            lock (gate)
            {
                ThrowIfDisposed();
                foreach (string root in watchers.Keys.Where(root => !wanted.Contains(root)).ToArray())
                {
                    StopCore(root);
                }

                foreach (string root in wanted)
                {
                    if (!watchers.ContainsKey(root))
                    {
                        StartCore(root);
                    }
                }
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }

                disposed = true;
                foreach (string root in watchers.Keys.ToArray())
                {
                    StopCore(root);
                }
            }
        }

        private void StartCore(string root)
        {
            FileSystemWatcher watcher;
            try
            {
                watcher = new FileSystemWatcher(root)
                {
                    IncludeSubdirectories = true,
                    InternalBufferSize = BufferSize,
                    NotifyFilter = NotifyFilters.FileName
                        | NotifyFilters.DirectoryName
                        | NotifyFilters.LastWrite
                        | NotifyFilters.Size
                };
                watcher.Created += OnChanged;
                watcher.Deleted += OnChanged;
                watcher.Changed += OnChanged;
                watcher.Renamed += OnRenamed;
                watcher.Error += OnError;
                watcher.EnableRaisingEvents = true;
            }
            catch (Exception)
            {
                return;
            }

            watchers[root] = watcher;
        }

        private void StopCore(string root)
        {
            if (watchers.Remove(root, out FileSystemWatcher? watcher))
            {
                watcher.EnableRaisingEvents = false;
                watcher.Created -= OnChanged;
                watcher.Deleted -= OnChanged;
                watcher.Changed -= OnChanged;
                watcher.Renamed -= OnRenamed;
                watcher.Error -= OnError;
                watcher.Dispose();
            }

            if (debounceTimers.Remove(root, out System.Threading.Timer? timer))
            {
                timer.Dispose();
            }
        }

        private void OnChanged(object sender, FileSystemEventArgs args)
        {
            if (sender is FileSystemWatcher watcher && ShouldRefresh(args))
            {
                Schedule(watcher.Path);
            }
        }

        private void OnRenamed(object sender, RenamedEventArgs args)
        {
            if (sender is FileSystemWatcher watcher && ShouldRefresh(args))
            {
                Schedule(watcher.Path);
            }
        }

        private void OnError(object sender, ErrorEventArgs args)
        {
            if (sender is FileSystemWatcher watcher)
            {
                Schedule(watcher.Path);
            }
        }

        private void Schedule(string root)
        {
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }

                if (debounceTimers.TryGetValue(root, out System.Threading.Timer? existing))
                {
                    existing.Change(DebounceMs, Timeout.Infinite);
                    return;
                }

                debounceTimers[root] = new System.Threading.Timer(
                    _ => Fire(root),
                    null,
                    DebounceMs,
                    Timeout.Infinite);
            }
        }

        private void Fire(string root)
        {
            lock (gate)
            {
                if (debounceTimers.Remove(root, out System.Threading.Timer? timer))
                {
                    timer.Dispose();
                }

                if (disposed)
                {
                    return;
                }
            }

            onRefreshNeeded();
        }

        private static bool ShouldRefresh(FileSystemEventArgs args)
        {
            if (args is RenamedEventArgs renamed)
            {
                return ShouldRefreshPath(renamed.FullPath, renamed.ChangeType)
                    || ShouldRefreshPath(renamed.OldFullPath, renamed.ChangeType);
            }

            return ShouldRefreshPath(args.FullPath, args.ChangeType);
        }

        private static bool ShouldRefreshPath(string path, WatcherChangeTypes changeType)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return false;
            }

            if (MusicLibraryScanner.IsSupportedAudioPath(path))
            {
                return true;
            }

            if (MusicLibraryScanner.IsIgnoredWatchPath(path))
            {
                return false;
            }

            if (Directory.Exists(path))
            {
                return changeType is WatcherChangeTypes.Created
                    or WatcherChangeTypes.Deleted
                    or WatcherChangeTypes.Renamed;
            }

            return changeType is WatcherChangeTypes.Deleted or WatcherChangeTypes.Renamed;
        }

        private void ThrowIfDisposed()
        {
            ObjectDisposedException.ThrowIf(disposed, this);
        }
    }
}
