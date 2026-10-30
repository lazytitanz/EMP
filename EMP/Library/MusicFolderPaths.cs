namespace EMP.Library
{
    internal static class MusicFolderPaths
    {
        public static string? TryNormalize(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return null;
            }

            try
            {
                return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path.Trim()));
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static bool EqualsPath(string left, string right)
        {
            return string.Equals(
                Path.TrimEndingDirectorySeparator(left),
                Path.TrimEndingDirectorySeparator(right),
                StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsStrictParent(string parent, string child)
        {
            parent = Path.TrimEndingDirectorySeparator(parent);
            child = Path.TrimEndingDirectorySeparator(child);
            if (EqualsPath(parent, child) || parent.Length == 0)
            {
                return false;
            }

            if (child.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return child.StartsWith(parent + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        public static List<string> NormalizeConfigured(IEnumerable<string?> paths)
        {
            List<string> normalized = [];
            foreach (string? path in paths)
            {
                string? item = TryNormalize(path);
                if (item is null || normalized.Any(existing => EqualsPath(existing, item)))
                {
                    continue;
                }

                normalized.Add(item);
            }

            return normalized
                .Where(path => !normalized.Any(other => IsStrictParent(other, path)))
                .ToList();
        }
    }
}
