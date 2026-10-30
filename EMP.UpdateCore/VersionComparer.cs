namespace EMP.UpdateCore;

public static class VersionComparer
{
    public static bool TryParse(string? tagOrVersion, out Version version)
    {
        version = new Version(0, 0, 0);
        if (string.IsNullOrWhiteSpace(tagOrVersion))
        {
            return false;
        }

        string value = tagOrVersion.Trim();
        if (value.StartsWith('v') || value.StartsWith('V'))
        {
            value = value[1..];
        }

        int dash = value.IndexOfAny(['-', '+']);
        if (dash >= 0)
        {
            value = value[..dash];
        }

        if (!Version.TryParse(value, out Version? parsed) || parsed is null)
        {
            return false;
        }

        // Normalize missing components so 1.2 compares as 1.2.0.
        version = new Version(
            Math.Max(parsed.Major, 0),
            Math.Max(parsed.Minor, 0),
            Math.Max(parsed.Build, 0),
            Math.Max(parsed.Revision, 0));
        return true;
    }

    public static int Compare(string? left, string? right)
    {
        if (!TryParse(left, out Version leftVersion) || !TryParse(right, out Version rightVersion))
        {
            return 0;
        }

        return leftVersion.CompareTo(rightVersion);
    }

    public static bool IsNewer(string? candidate, string? current)
    {
        if (!TryParse(candidate, out Version candidateVersion) || !TryParse(current, out Version currentVersion))
        {
            return false;
        }

        return candidateVersion > currentVersion;
    }

    public static string Normalize(string? tagOrVersion)
    {
        if (!TryParse(tagOrVersion, out Version version))
        {
            throw new FormatException($"Invalid version '{tagOrVersion}'.");
        }

        return $"{version.Major}.{version.Minor}.{Math.Max(version.Build, 0)}";
    }
}
