namespace EMP.Library
{
    internal static class LibraryMediaIndex
    {
        private static readonly object Gate = new();
        private static Dictionary<string, LibraryMediaLocation> current = new(StringComparer.OrdinalIgnoreCase);
        private static Dictionary<string, LibraryMediaLocation> retained = new(StringComparer.OrdinalIgnoreCase);

        public static void Replace(IReadOnlyDictionary<string, LibraryMediaLocation> locations)
        {
            ArgumentNullException.ThrowIfNull(locations);

            lock (Gate)
            {
                current = new Dictionary<string, LibraryMediaLocation>(locations, StringComparer.OrdinalIgnoreCase);
                foreach (string id in retained.Keys.ToArray())
                {
                    if (current.ContainsKey(id))
                    {
                        retained.Remove(id);
                    }
                }
            }
        }

        public static void Retain(IEnumerable<string> trackIds)
        {
            ArgumentNullException.ThrowIfNull(trackIds);

            lock (Gate)
            {
                HashSet<string> keep = new(StringComparer.OrdinalIgnoreCase);
                foreach (string id in trackIds)
                {
                    if (!string.IsNullOrWhiteSpace(id))
                    {
                        keep.Add(id);
                    }
                }

                foreach (string id in retained.Keys.ToArray())
                {
                    if (!keep.Contains(id))
                    {
                        retained.Remove(id);
                    }
                }

                foreach (string id in keep)
                {
                    if (current.TryGetValue(id, out LibraryMediaLocation? location))
                    {
                        retained[id] = location;
                    }
                }
            }
        }

        public static void Clear()
        {
            lock (Gate)
            {
                current.Clear();
                retained.Clear();
            }
        }

        public static bool TryGet(string? trackId, out LibraryMediaLocation location)
        {
            location = null!;
            if (string.IsNullOrWhiteSpace(trackId))
            {
                return false;
            }

            lock (Gate)
            {
                if (current.TryGetValue(trackId, out LibraryMediaLocation? found)
                    || retained.TryGetValue(trackId, out found))
                {
                    location = found;
                    return true;
                }
            }

            return false;
        }

        public static bool IsRetained(string trackId)
        {
            if (string.IsNullOrWhiteSpace(trackId))
            {
                return false;
            }

            lock (Gate)
            {
                return retained.ContainsKey(trackId);
            }
        }
    }
}
