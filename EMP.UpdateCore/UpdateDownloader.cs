namespace EMP.UpdateCore;

public sealed class UpdateDownloader
{
    private readonly IReleaseProvider _provider;
    private readonly IPackageAuthenticator _authenticator;
    private readonly UpdatePaths _paths;

    public UpdateDownloader(
        IReleaseProvider provider,
        UpdatePaths paths,
        IPackageAuthenticator? authenticator = null)
    {
        _provider = provider ?? throw new ArgumentNullException(nameof(provider));
        _paths = paths ?? throw new ArgumentNullException(nameof(paths));
        _authenticator = authenticator ?? new ChecksumAuthenticator();
    }

    public async Task<AvailableUpdate?> CheckForUpdateAsync(
        string currentVersion,
        CancellationToken cancellationToken = default)
    {
        ReleaseInfo? release = await _provider.GetLatestStableAsync(cancellationToken).ConfigureAwait(false);
        if (release is null)
        {
            return null;
        }

        if (!VersionComparer.IsNewer(release.Version, currentVersion))
        {
            return null;
        }

        return new AvailableUpdate
        {
            Release = release,
            CurrentVersion = currentVersion
        };
    }

    public async Task<string> DownloadAndVerifyAsync(
        ReleaseInfo release,
        IProgress<UpdateDownloadProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(release);
        _paths.EnsureCreated();

        string pendingPackage = Path.Combine(_paths.PendingDirectory, release.PackageFileName);
        string pendingChecksum = Path.Combine(_paths.PendingDirectory, release.ChecksumFileName);
        string partialPackage = pendingPackage + ".partial";
        string partialChecksum = pendingChecksum + ".partial";

        try
        {
            if (File.Exists(partialPackage))
            {
                File.Delete(partialPackage);
            }

            if (File.Exists(partialChecksum))
            {
                File.Delete(partialChecksum);
            }

            await _provider.DownloadAssetAsync(release.ChecksumDownloadUrl, partialChecksum, null, cancellationToken)
                .ConfigureAwait(false);
            File.Move(partialChecksum, pendingChecksum, overwrite: true);

            await _provider.DownloadAssetAsync(release.PackageDownloadUrl, partialPackage, progress, cancellationToken)
                .ConfigureAwait(false);
            File.Move(partialPackage, pendingPackage, overwrite: true);

            string expected = ChecksumVerifier.ParseSha256File(await File.ReadAllTextAsync(pendingChecksum, cancellationToken).ConfigureAwait(false), release.PackageFileName);
            await _authenticator.AuthenticateAsync(
                new PackageAuthenticationContext
                {
                    PackagePath = pendingPackage,
                    Release = release,
                    ExpectedSha256Hex = expected
                },
                cancellationToken).ConfigureAwait(false);

            ZipPackageValidator.Validate(pendingPackage);
            return pendingPackage;
        }
        catch
        {
            TryDelete(partialPackage);
            TryDelete(partialChecksum);
            throw;
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception)
        {
            // Best effort cleanup.
        }
    }
}
