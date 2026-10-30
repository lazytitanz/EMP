namespace EMP.UpdateCore;

public interface IReleaseProvider
{
    Task<ReleaseInfo?> GetLatestStableAsync(CancellationToken cancellationToken = default);

    Task DownloadAssetAsync(
        Uri downloadUrl,
        string destinationPath,
        IProgress<UpdateDownloadProgress>? progress = null,
        CancellationToken cancellationToken = default);
}

public sealed class UpdateDownloadProgress
{
    public required long BytesReceived { get; init; }

    public long? TotalBytes { get; init; }

    public double? Fraction => TotalBytes is > 0 ? (double)BytesReceived / TotalBytes.Value : null;
}
