namespace EMP.UpdateCore;

/// <summary>
/// File-backed release provider for tests and scripts/test-update.ps1.
/// Still requires checksum files; does not bypass verification.
/// </summary>
public sealed class MockReleaseProvider : IReleaseProvider
{
    private readonly string _releaseDirectory;
    private readonly ReleaseInfo _release;

    public MockReleaseProvider(string releaseDirectory, ReleaseInfo release)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(releaseDirectory);
        _releaseDirectory = Path.GetFullPath(releaseDirectory);
        _release = release ?? throw new ArgumentNullException(nameof(release));
    }

    public static MockReleaseProvider FromDirectory(string releaseDirectory, string version)
    {
        string normalized = VersionComparer.Normalize(version);
        string packageName = ReleaseAssetNames.PackageZip(normalized);
        string checksumName = ReleaseAssetNames.PackageChecksum(normalized);
        string packagePath = Path.Combine(releaseDirectory, packageName);
        string checksumPath = Path.Combine(releaseDirectory, checksumName);
        if (!File.Exists(packagePath))
        {
            throw new FileNotFoundException("Mock package not found.", packagePath);
        }

        if (!File.Exists(checksumPath))
        {
            throw new FileNotFoundException("Mock checksum not found.", checksumPath);
        }

        string expected = ChecksumVerifier.ParseSha256File(File.ReadAllText(checksumPath), packageName);
        static Uri ToFileUri(string path) => new(new FileInfo(path).FullName);
        ReleaseInfo release = new()
        {
            TagName = "v" + normalized,
            Version = normalized,
            PackageFileName = packageName,
            PackageDownloadUrl = ToFileUri(packagePath),
            ChecksumFileName = checksumName,
            ChecksumDownloadUrl = ToFileUri(checksumPath),
            PackageDigestSha256 = expected,
            PackageSizeBytes = new FileInfo(packagePath).Length
        };
        return new MockReleaseProvider(releaseDirectory, release);
    }

    public Task<ReleaseInfo?> GetLatestStableAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_release.Draft || _release.Prerelease)
        {
            return Task.FromResult<ReleaseInfo?>(null);
        }

        return Task.FromResult<ReleaseInfo?>(_release);
    }

    public async Task DownloadAssetAsync(
        Uri downloadUrl,
        string destinationPath,
        IProgress<UpdateDownloadProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(downloadUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationPath);

        string sourcePath = downloadUrl.IsFile
            ? downloadUrl.LocalPath
            : Path.Combine(_releaseDirectory, Path.GetFileName(downloadUrl.LocalPath));

        if (!File.Exists(sourcePath))
        {
            // Allow file:// URIs and plain absolute paths encoded as file URIs.
            if (File.Exists(downloadUrl.OriginalString))
            {
                sourcePath = downloadUrl.OriginalString;
            }
            else
            {
                throw new FileNotFoundException("Mock asset not found.", sourcePath);
            }
        }

        string? directory = Path.GetDirectoryName(destinationPath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        long total = new FileInfo(sourcePath).Length;
        await using FileStream source = File.OpenRead(sourcePath);
        await using FileStream target = File.Create(destinationPath);
        byte[] buffer = new byte[81920];
        long received = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int read = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            received += read;
            progress?.Report(new UpdateDownloadProgress
            {
                BytesReceived = received,
                TotalBytes = total
            });
        }
    }
}
