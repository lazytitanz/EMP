namespace EMP.UpdateCore;

/// <summary>
/// Extension point for package authenticity checks.
/// v1 ships <see cref="ChecksumAuthenticator"/> only. A future signed-manifest
/// implementation can verify an Ed25519 signature against an embedded public key.
/// Checksums from the same GitHub release are integrity checks, not independent authenticity.
/// </summary>
public interface IPackageAuthenticator
{
    Task AuthenticateAsync(PackageAuthenticationContext context, CancellationToken cancellationToken = default);
}

public sealed class PackageAuthenticationContext
{
    public required string PackagePath { get; init; }

    public required ReleaseInfo Release { get; init; }

    public required string ExpectedSha256Hex { get; init; }
}

public sealed class ChecksumAuthenticator : IPackageAuthenticator
{
    public Task AuthenticateAsync(PackageAuthenticationContext context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        return ChecksumVerifier.VerifyFileAsync(
            context.PackagePath,
            context.ExpectedSha256Hex,
            context.Release.PackageDigestSha256,
            cancellationToken);
    }
}
