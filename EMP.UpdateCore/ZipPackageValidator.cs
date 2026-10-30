using System.IO.Compression;

namespace EMP.UpdateCore;

public static class ZipPackageValidator
{
    public const long DefaultMaxUncompressedBytes = 1L * 1024 * 1024 * 1024;
    public const int DefaultMaxEntryCount = 50_000;

    private static readonly HashSet<string> AllowedRootExecutables = new(StringComparer.OrdinalIgnoreCase)
    {
        "EMP.exe",
        "EMP.Updater.exe"
    };

    public static IReadOnlyList<string> ListEntries(string zipPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(zipPath);
        using ZipArchive archive = ZipFile.OpenRead(zipPath);
        return archive.Entries
            .Where(static e => !string.IsNullOrWhiteSpace(e.FullName) && !e.FullName.EndsWith('/') && !e.FullName.EndsWith('\\'))
            .Select(static e => NormalizeEntryPath(e.FullName))
            .ToArray();
    }

    public static void Validate(string zipPath, long maxUncompressedBytes = DefaultMaxUncompressedBytes, int maxEntryCount = DefaultMaxEntryCount)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(zipPath);
        if (!File.Exists(zipPath))
        {
            throw new UpdatePackageException("Package ZIP was not found.");
        }

        using ZipArchive archive = ZipFile.OpenRead(zipPath);
        if (archive.Entries.Count == 0)
        {
            throw new UpdatePackageException("Package ZIP is empty.");
        }

        if (archive.Entries.Count > maxEntryCount)
        {
            throw new UpdatePackageException("Package ZIP has too many entries.");
        }

        long totalUncompressed = 0;
        bool hasEmp = false;
        bool hasUpdater = false;

        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string normalized = NormalizeEntryPath(entry.FullName);
            if (string.IsNullOrWhiteSpace(normalized))
            {
                continue;
            }

            ValidateEntryPath(normalized);

            if (normalized.EndsWith('/'))
            {
                continue;
            }

            totalUncompressed += entry.Length;
            if (totalUncompressed > maxUncompressedBytes)
            {
                throw new UpdatePackageException("Package ZIP uncompressed size exceeds the allowed limit.");
            }

            if (normalized.Contains('/') || normalized.Contains('\\'))
            {
                continue;
            }

            if (normalized.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                && !AllowedRootExecutables.Contains(normalized))
            {
                throw new UpdatePackageException($"Unexpected root executable '{normalized}' in package.");
            }

            if (string.Equals(normalized, "EMP.exe", StringComparison.OrdinalIgnoreCase))
            {
                hasEmp = true;
            }
            else if (string.Equals(normalized, "EMP.Updater.exe", StringComparison.OrdinalIgnoreCase))
            {
                hasUpdater = true;
            }
        }

        if (!hasEmp)
        {
            throw new UpdatePackageException("Package is missing EMP.exe at the archive root.");
        }

        if (!hasUpdater)
        {
            throw new UpdatePackageException("Package is missing EMP.Updater.exe at the archive root.");
        }
    }

    public static void ExtractTo(string zipPath, string destinationDirectory)
    {
        Validate(zipPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationDirectory);
        Directory.CreateDirectory(destinationDirectory);

        string fullDestination = Path.GetFullPath(destinationDirectory);
        using ZipArchive archive = ZipFile.OpenRead(zipPath);
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string normalized = NormalizeEntryPath(entry.FullName);
            if (string.IsNullOrWhiteSpace(normalized) || normalized.EndsWith('/'))
            {
                if (!string.IsNullOrWhiteSpace(normalized))
                {
                    Directory.CreateDirectory(Path.Combine(fullDestination, normalized.TrimEnd('/')));
                }

                continue;
            }

            ValidateEntryPath(normalized);
            string targetPath = Path.GetFullPath(Path.Combine(fullDestination, normalized.Replace('/', Path.DirectorySeparatorChar)));
            if (!targetPath.StartsWith(fullDestination + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                && !string.Equals(targetPath, fullDestination, StringComparison.OrdinalIgnoreCase))
            {
                throw new UpdatePackageException($"Refusing to extract outside destination: '{entry.FullName}'.");
            }

            string? parent = Path.GetDirectoryName(targetPath);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                Directory.CreateDirectory(parent);
            }

            entry.ExtractToFile(targetPath, overwrite: true);
        }
    }

    public static string NormalizeEntryPath(string fullName)
    {
        string value = fullName.Replace('\\', '/').Trim();
        while (value.StartsWith("./", StringComparison.Ordinal))
        {
            value = value[2..];
        }

        return value;
    }

    private static void ValidateEntryPath(string normalized)
    {
        if (Path.IsPathRooted(normalized) || normalized.Contains(':'))
        {
            throw new UpdatePackageException($"Package contains an absolute path entry: '{normalized}'.");
        }

        string[] parts = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Any(static part => part is "." or ".."))
        {
            throw new UpdatePackageException($"Package contains a path traversal entry: '{normalized}'.");
        }
    }
}
