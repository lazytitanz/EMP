using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace EMP.UpdateCore;

public sealed class GitHubReleaseProvider : IReleaseProvider, IDisposable
{
    public const string DefaultOwner = "lazytitanz";
    public const string DefaultRepo = "EMP";

    private readonly HttpClient _http;
    private readonly bool _ownsClient;
    private readonly string _owner;
    private readonly string _repo;

    public GitHubReleaseProvider(string? userAgentVersion = null, string owner = DefaultOwner, string repo = DefaultRepo)
        : this(CreateClient(userAgentVersion), ownsClient: true, owner, repo)
    {
    }

    public GitHubReleaseProvider(HttpClient httpClient, string owner = DefaultOwner, string repo = DefaultRepo)
        : this(httpClient, ownsClient: false, owner, repo)
    {
    }

    private GitHubReleaseProvider(HttpClient httpClient, bool ownsClient, string owner, string repo)
    {
        _http = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _ownsClient = ownsClient;
        _owner = owner;
        _repo = repo;
    }

    public async Task<ReleaseInfo?> GetLatestStableAsync(CancellationToken cancellationToken = default)
    {
        using HttpRequestMessage request = new(
            HttpMethod.Get,
            $"https://api.github.com/repos/{_owner}/{_repo}/releases/latest");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");

        using HttpResponseMessage response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        if ((int)response.StatusCode == 403 && response.Headers.Contains("X-RateLimit-Remaining"))
        {
            throw new UpdateRateLimitException("GitHub API rate limit exceeded while checking for updates.");
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new UpdateException($"GitHub releases request failed with status {(int)response.StatusCode}.");
        }

        await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using JsonDocument document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        return ParseRelease(document.RootElement);
    }

    public async Task DownloadAssetAsync(
        Uri downloadUrl,
        string destinationPath,
        IProgress<UpdateDownloadProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(downloadUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationPath);

        string? directory = Path.GetDirectoryName(destinationPath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        using HttpRequestMessage request = new(HttpMethod.Get, downloadUrl);
        request.Headers.Accept.ParseAdd("application/octet-stream");

        using HttpResponseMessage response = await _http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            throw new UpdateException($"Download failed with status {(int)response.StatusCode} for {downloadUrl}.");
        }

        long? total = response.Content.Headers.ContentLength;
        await using Stream source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using FileStream target = new(
            destinationPath,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            81920,
            FileOptions.Asynchronous | FileOptions.SequentialScan);

        byte[] buffer = new byte[81920];
        long received = 0;
        while (true)
        {
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

        if (total is > 0 && received != total.Value)
        {
            throw new UpdateException($"Downloaded size mismatch. Expected {total.Value} bytes, received {received}.");
        }
    }

    public void Dispose()
    {
        if (_ownsClient)
        {
            _http.Dispose();
        }
    }

    internal static ReleaseInfo? ParseRelease(JsonElement root)
    {
        bool draft = root.TryGetProperty("draft", out JsonElement draftElement) && draftElement.ValueKind == JsonValueKind.True;
        bool prerelease = root.TryGetProperty("prerelease", out JsonElement preElement) && preElement.ValueKind == JsonValueKind.True;
        if (draft || prerelease)
        {
            return null;
        }

        string? tagName = root.TryGetProperty("tag_name", out JsonElement tagElement) ? tagElement.GetString() : null;
        if (!VersionComparer.TryParse(tagName, out _))
        {
            throw new UpdateException($"Release tag '{tagName}' is not a valid version.");
        }

        string version = VersionComparer.Normalize(tagName);
        string packageName = ReleaseAssetNames.PackageZip(version);
        string checksumName = ReleaseAssetNames.PackageChecksum(version);

        if (!root.TryGetProperty("assets", out JsonElement assets) || assets.ValueKind != JsonValueKind.Array)
        {
            throw new UpdateNotFoundException("Release has no assets.");
        }

        ReleaseAsset? package = null;
        ReleaseAsset? checksum = null;
        foreach (JsonElement asset in assets.EnumerateArray())
        {
            string? name = asset.TryGetProperty("name", out JsonElement nameElement) ? nameElement.GetString() : null;
            string? url = asset.TryGetProperty("browser_download_url", out JsonElement urlElement) ? urlElement.GetString() : null;
            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(url))
            {
                continue;
            }

            string? digest = asset.TryGetProperty("digest", out JsonElement digestElement) ? digestElement.GetString() : null;
            long? size = asset.TryGetProperty("size", out JsonElement sizeElement) && sizeElement.TryGetInt64(out long sizeValue)
                ? sizeValue
                : null;

            ReleaseAsset parsed = new()
            {
                Name = name,
                DownloadUrl = new Uri(url),
                Digest = digest,
                SizeBytes = size
            };

            if (string.Equals(name, packageName, StringComparison.Ordinal))
            {
                package = parsed;
            }
            else if (string.Equals(name, checksumName, StringComparison.Ordinal))
            {
                checksum = parsed;
            }
        }

        if (package is null)
        {
            throw new UpdateNotFoundException($"Release asset '{packageName}' was not found.");
        }

        if (checksum is null)
        {
            throw new UpdateNotFoundException($"Release checksum asset '{checksumName}' was not found.");
        }

        return new ReleaseInfo
        {
            TagName = tagName!,
            Version = version,
            PackageFileName = package.Name,
            PackageDownloadUrl = package.DownloadUrl,
            ChecksumFileName = checksum.Name,
            ChecksumDownloadUrl = checksum.DownloadUrl,
            PackageDigestSha256 = ExtractSha256(package.Digest),
            PackageSizeBytes = package.SizeBytes,
            Prerelease = false,
            Draft = false
        };
    }

    internal static string? ExtractSha256(string? digest)
    {
        if (string.IsNullOrWhiteSpace(digest))
        {
            return null;
        }

        const string prefix = "sha256:";
        if (digest.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return digest[prefix.Length..].Trim().ToLowerInvariant();
        }

        return null;
    }

    private static HttpClient CreateClient(string? userAgentVersion)
    {
        HttpClient client = new()
        {
            Timeout = TimeSpan.FromMinutes(5)
        };
        string version = string.IsNullOrWhiteSpace(userAgentVersion) ? "0.0.0" : userAgentVersion;
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("EMP", version));
        return client;
    }
}
