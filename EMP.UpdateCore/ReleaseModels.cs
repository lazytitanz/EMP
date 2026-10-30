namespace EMP.UpdateCore;

public sealed class ReleaseInfo
{
    public required string TagName { get; init; }

    public required string Version { get; init; }

    public required string PackageFileName { get; init; }

    public required Uri PackageDownloadUrl { get; init; }

    public required string ChecksumFileName { get; init; }

    public required Uri ChecksumDownloadUrl { get; init; }

    public string? PackageDigestSha256 { get; init; }

    public long? PackageSizeBytes { get; init; }

    public bool Prerelease { get; init; }

    public bool Draft { get; init; }
}

public sealed class ReleaseAsset
{
    public required string Name { get; init; }

    public required Uri DownloadUrl { get; init; }

    public string? Digest { get; init; }

    public long? SizeBytes { get; init; }
}

public sealed class AvailableUpdate
{
    public required ReleaseInfo Release { get; init; }

    public required string CurrentVersion { get; init; }

    public string AvailableVersion => Release.Version;
}
