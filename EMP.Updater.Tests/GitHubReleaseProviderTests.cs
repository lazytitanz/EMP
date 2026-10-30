using System.Net;
using System.Text;
using System.Text.Json;
using EMP.UpdateCore;

namespace EMP.Updater.Tests;

public class GitHubReleaseProviderTests
{
    [Fact]
    public void ParseRelease_HappyPath()
    {
        string json = """
            {
              "tag_name": "v0.3.0",
              "draft": false,
              "prerelease": false,
              "assets": [
                {
                  "name": "EMP-v0.3.0-win-x64.zip",
                  "browser_download_url": "https://example.test/EMP-v0.3.0-win-x64.zip",
                  "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "size": 10
                },
                {
                  "name": "EMP-v0.3.0-win-x64.zip.sha256",
                  "browser_download_url": "https://example.test/EMP-v0.3.0-win-x64.zip.sha256",
                  "size": 80
                }
              ]
            }
            """;

        using JsonDocument document = JsonDocument.Parse(json);
        ReleaseInfo? release = GitHubReleaseProvider.ParseRelease(document.RootElement);
        Assert.NotNull(release);
        Assert.Equal("0.3.0", release!.Version);
        Assert.Equal("EMP-v0.3.0-win-x64.zip", release.PackageFileName);
        Assert.Equal("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", release.PackageDigestSha256);
    }

    [Fact]
    public void ParseRelease_RejectsDoubleZipName()
    {
        string json = """
            {
              "tag_name": "v0.2.0",
              "draft": false,
              "prerelease": false,
              "assets": [
                {
                  "name": "EMP-v0.2.0-win-x64.zip.zip",
                  "browser_download_url": "https://example.test/EMP-v0.2.0-win-x64.zip.zip"
                }
              ]
            }
            """;

        using JsonDocument document = JsonDocument.Parse(json);
        Assert.Throws<UpdateNotFoundException>(() => GitHubReleaseProvider.ParseRelease(document.RootElement));
    }

    [Fact]
    public void ParseRelease_ReturnsNullForPrerelease()
    {
        string json = """
            {
              "tag_name": "v0.3.0",
              "draft": false,
              "prerelease": true,
              "assets": []
            }
            """;
        using JsonDocument document = JsonDocument.Parse(json);
        Assert.Null(GitHubReleaseProvider.ParseRelease(document.RootElement));
    }

    [Fact]
    public async Task GetLatestStableAsync_Handles404()
    {
        using HttpClient client = new(new StubHandler(HttpStatusCode.NotFound, "{}"));
        using GitHubReleaseProvider provider = new(client);
        Assert.Null(await provider.GetLatestStableAsync());
    }

    [Fact]
    public async Task GetLatestStableAsync_RateLimit()
    {
        HttpResponseMessage response = new(HttpStatusCode.Forbidden)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json")
        };
        response.Headers.TryAddWithoutValidation("X-RateLimit-Remaining", "0");
        using HttpClient client = new(new StubHandler(response));
        using GitHubReleaseProvider provider = new(client);
        await Assert.ThrowsAsync<UpdateRateLimitException>(() => provider.GetLatestStableAsync());
    }

    [Fact]
    public async Task GetLatestStableAsync_InvalidJson()
    {
        using HttpClient client = new(new StubHandler(HttpStatusCode.OK, "{not-json"));
        using GitHubReleaseProvider provider = new(client);
        await Assert.ThrowsAnyAsync<Exception>(() => provider.GetLatestStableAsync());
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;

        public StubHandler(HttpStatusCode status, string body)
            : this(_ => new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            })
        {
        }

        public StubHandler(HttpResponseMessage response)
            : this(_ => response)
        {
        }

        public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
        {
            _responder = responder;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return Task.FromResult(_responder(request));
        }
    }
}
