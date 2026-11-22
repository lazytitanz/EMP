using System.Net;
using System.Text;
using System.Text.Json;
using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    /// <summary>
    /// Deterministic fixtures for known popular artists. Live API smoke stays separate
    /// (see <see cref="ArtistEnrichmentLiveSmokeTests"/>).
    /// </summary>
    [Collection(ArtistMetadataTestCollection.Name)]
    public sealed class ArtistEnrichmentRegressionTests : IDisposable
    {
        private readonly string cacheRoot;

        public ArtistEnrichmentRegressionTests()
        {
            cacheRoot = Path.Combine(Path.GetTempPath(), "EMP-ArtistEnrichment", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(cacheRoot);
        }

        public void Dispose()
        {
            MusicBrainzClient.ResetTestState();
            try
            {
                if (Directory.Exists(cacheRoot))
                {
                    Directory.Delete(cacheRoot, recursive: true);
                }
            }
            catch (Exception)
            {
                // Best-effort.
            }
        }

        public static TheoryData<string, string, string, string> KnownArtists => new()
        {
            { "The Offspring", "23a03e33-a603-404e-bcbf-2c00159d7067", "Q157041", "The Offspring" },
            { "Bullet for My Valentine", "d530dbf9-69b1-404f-98f2-0431104f5a1e", "Q485385", "Bullet for My Valentine" },
            { "Post Malone", "b1e26560-60e5-4236-bbdb-9aa5a8d5ee19", "Q21621919", "Post Malone" }
        };

        [Theory]
        [MemberData(nameof(KnownArtists))]
        public async Task GetArtistLookupAsync_Fixture_ReturnsMetadataIndependentOfImage(
            string name,
            string mbid,
            string qid,
            string wikiTitle)
        {
            byte[] png = ArtistImageCacheTests.PngWithDimensions(1000, 800);
            StubHandler handler = BuildKnownArtistHandler(name, mbid, qid, wikiTitle, png, includeImage: false);

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.ArtistLookupResult lookup = await MusicBrainzClient.GetArtistLookupAsync(name);

            Assert.Equal(MusicBrainzClient.ArtistLookupStatus.Found, lookup.Status);
            Assert.True(MusicBrainzClient.HasProfileData(lookup.Profile));
            Assert.Equal(mbid, lookup.Profile.MusicBrainzId);
            Assert.Equal(qid, lookup.Profile.WikidataId);
            Assert.False(string.IsNullOrWhiteSpace(lookup.Profile.Biography));
            Assert.NotEmpty(lookup.Profile.Genres);
            // Image omitted in this fixture on purpose — metadata must still surface.
            Assert.Null(lookup.Profile.Image);
        }

        [Theory]
        [MemberData(nameof(KnownArtists))]
        public async Task GetArtistLookupAsync_Fixture_LoadsLicensedP18OrCategoryImage(
            string name,
            string mbid,
            string qid,
            string wikiTitle)
        {
            byte[] png = ArtistImageCacheTests.PngWithDimensions(1200, 800);
            StubHandler handler = BuildKnownArtistHandler(name, mbid, qid, wikiTitle, png, includeImage: true);

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.ArtistLookupResult lookup = await MusicBrainzClient.GetArtistLookupAsync(name);

            Assert.Equal(MusicBrainzClient.ArtistLookupStatus.Found, lookup.Status);
            Assert.NotNull(lookup.Profile.Image);
            Assert.False(lookup.Profile.Image!.IsCustom);
            Assert.StartsWith("https://artist-art.emp/", lookup.Profile.Image.Url);
            Assert.Contains("CC BY", lookup.Profile.Image.License, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task GetArtistLookupAsync_TransientSearch_DoesNotConfirmEmpty()
        {
            StubHandler handler = new(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
            MusicBrainzClient.ConfigureForTests(handler, cacheRoot);
            MusicBrainzClient.ArtistLookupResult lookup =
                await MusicBrainzClient.GetArtistLookupAsync("Bullet for My Valentine");
            Assert.Equal(MusicBrainzClient.ArtistLookupStatus.Transient, lookup.Status);
            Assert.False(MusicBrainzClient.HasProfileData(lookup.Profile));
            string artistsDir = Path.Combine(cacheRoot, "artists");
            Assert.True(!Directory.Exists(artistsDir) || Directory.GetFiles(artistsDir, "*.json").Length == 0);
        }

        [Fact]
        public void ResolveCommonsArtistCategoryTitle_UsesWikipediaIdentity()
        {
            Assert.Equal(
                "Category:The Offspring",
                MusicBrainzClient.ResolveCommonsArtistCategoryTitle("The Offspring", "The Offspring"));
            Assert.Equal(
                "Category:Post Malone",
                MusicBrainzClient.ResolveCommonsArtistCategoryTitle("Post Malone", "Post Malone"));
        }

        [Fact]
        public void IsUsefulArtistPhotoSubcategory_RejectsAlbumArtCategories()
        {
            Assert.False(MusicBrainzClient.IsUsefulArtistPhotoSubcategory(
                "Category:The Offspring album covers",
                "The Offspring",
                "The Offspring"));
            Assert.True(MusicBrainzClient.IsUsefulArtistPhotoSubcategory(
                "Category:Members of Bullet for My Valentine",
                "Bullet for My Valentine",
                "Bullet for My Valentine"));
        }

        [Fact]
        public void WireStatus_MapsLookupStatusesForWebView()
        {
            Assert.Equal("ok", MusicBrainzClient.WireStatus(MusicBrainzClient.ArtistLookupStatus.Found));
            Assert.Equal("empty", MusicBrainzClient.WireStatus(MusicBrainzClient.ArtistLookupStatus.ConfirmedEmpty));
            Assert.Equal("transient", MusicBrainzClient.WireStatus(MusicBrainzClient.ArtistLookupStatus.Transient));
        }

        [Fact]
        public async Task GetArtistLookupAsync_PostMaloneFixture_DeliversMetadataWhenImageTimesOut()
        {
            byte[] png = ArtistImageCacheTests.PngWithDimensions(1200, 800);
            string name = "Post Malone";
            string mbid = "b1e26560-60e5-4236-bbdb-9aa5a8d5ee19";
            string qid = "Q21621919";
            StubHandler handler = BuildKnownArtistHandler(
                name,
                mbid,
                qid,
                "Post Malone",
                png,
                includeImage: true,
                imageDownloadDelay: TimeSpan.FromSeconds(5));

            // ConfigureForTests resets the budget — set it after configure.
            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.SetImageResolutionBudgetForTests(TimeSpan.FromMilliseconds(150));
            var timer = System.Diagnostics.Stopwatch.StartNew();
            MusicBrainzClient.ArtistLookupResult lookup = await MusicBrainzClient.GetArtistLookupAsync(name);
            timer.Stop();

            Assert.Equal(MusicBrainzClient.ArtistLookupStatus.Found, lookup.Status);
            Assert.False(string.IsNullOrWhiteSpace(lookup.Profile.Biography));
            Assert.Equal(mbid, lookup.Profile.MusicBrainzId);
            // Budget is 150ms; allow one MB rate-limit spacing (~1.1s) plus overhead.
            Assert.True(timer.ElapsedMilliseconds < 3500, $"metadata blocked too long: {timer.ElapsedMilliseconds}ms");
            // Image may be null due to deadline; must not block biography delivery.
        }

        [Fact]
        public async Task GetArtistLookupAsync_Search503_FallsBackToWikipediaIdentity()
        {
            byte[] png = ArtistImageCacheTests.PngWithDimensions(1000, 800);
            string name = "Post Malone";
            string mbid = "b1e26560-60e5-4236-bbdb-9aa5a8d5ee19";
            string qid = "Q21621919";
            int searchHits = 0;
            StubHandler handler = new(request =>
            {
                string full = request.RequestUri!.AbsoluteUri;
                string host = request.RequestUri.Host;
                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("query=", StringComparison.Ordinal))
                {
                    Interlocked.Increment(ref searchHits);
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    {
                        Headers = { RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(1)) },
                        Content = new StringContent("{\"error\":\"busy\"}", Encoding.UTF8, "application/json")
                    };
                }

                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains($"/artist/{mbid}", StringComparison.Ordinal))
                {
                    return JsonResponse(
                        JsonSerializer.Serialize(new Dictionary<string, object?>
                        {
                            ["id"] = mbid,
                            ["name"] = name,
                            ["type"] = "Person",
                            ["life-span"] = new { begin = "1995-07-04" },
                            ["genres"] = new[] { new { name = "hip hop", count = 5 } },
                            ["relations"] = new[]
                            {
                                new { type = "wikidata", url = new { resource = $"https://www.wikidata.org/wiki/{qid}" } }
                            }
                        }));
                }

                if (host.Contains("wikipedia", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse(JsonSerializer.Serialize(new
                    {
                        title = name,
                        extract = "Austin Richard Post, known professionally as Post Malone, is an American rapper.",
                        wikibase_item = qid,
                        content_urls = new { desktop = new { page = "https://en.wikipedia.org/wiki/Post_Malone" } }
                    }));
                }

                if (host.Contains("wikidata", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse(JsonSerializer.Serialize(new
                    {
                        entities = new Dictionary<string, object>
                        {
                            [qid] = new
                            {
                                claims = new Dictionary<string, object>
                                {
                                    ["P434"] = new object[]
                                    {
                                        new { mainsnak = new { datavalue = new { value = mbid, type = "string" } } }
                                    },
                                    ["P18"] = new object[]
                                    {
                                        new
                                        {
                                            mainsnak = new
                                            {
                                                datavalue = new { value = "Post Malone portrait.jpg", type = "string" }
                                            }
                                        }
                                    }
                                },
                                sitelinks = new { enwiki = new { title = name } }
                            }
                        }
                    }));
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("prop=imageinfo", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"query":{"pages":{"1":{"imageinfo":[{
                          "thumburl":"https://commons.test/artist.jpg",
                          "thumbwidth":1200,"thumbheight":800,
                          "mime":"image/png",
                          "extmetadata":{
                            "LicenseShortName":{"value":"CC BY-SA 4.0"},
                            "LicenseUrl":{"value":"https://creativecommons.org/licenses/by-sa/4.0/"},
                            "Artist":{"value":"Fixture Photographer"}
                          }
                        }]}}}}
                        """);
                }

                if (full.Contains("commons.test/artist", StringComparison.Ordinal))
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new ByteArrayContent(png)
                        {
                            Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png") }
                        }
                    };
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse("{\"query\":{\"categorymembers\":[],\"search\":[]}}");
                }

                return JsonResponse("{}");
            });

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.ArtistLookupResult lookup = await MusicBrainzClient.GetArtistLookupAsync(name);

            Assert.Equal(MusicBrainzClient.ArtistLookupStatus.Found, lookup.Status);
            Assert.False(string.IsNullOrWhiteSpace(lookup.Profile.Biography));
            Assert.Equal(mbid, lookup.Profile.MusicBrainzId);
            Assert.Equal(qid, lookup.Profile.WikidataId);
            Assert.True(searchHits >= 1);
        }

        [Fact]
        public async Task GetArtistLookupAsync_KnownMbid_SkipsSearchWhenSearchIsShed()
        {
            string name = "Post Malone";
            string mbid = "b1e26560-60e5-4236-bbdb-9aa5a8d5ee19";
            string qid = "Q21621919";
            int searchHits = 0;
            StubHandler handler = new(request =>
            {
                string full = request.RequestUri!.AbsoluteUri;
                string host = request.RequestUri.Host;
                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("query=", StringComparison.Ordinal))
                {
                    Interlocked.Increment(ref searchHits);
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
                }

                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains($"/artist/{mbid}", StringComparison.Ordinal))
                {
                    return JsonResponse(
                        "{\"id\":\"" + mbid + "\",\"name\":\"Post Malone\",\"type\":\"Person\","
                        + "\"genres\":[{\"name\":\"hip hop\",\"count\":3}],"
                        + "\"relations\":[{\"type\":\"wikidata\",\"url\":{\"resource\":\"https://www.wikidata.org/wiki/"
                        + qid + "\"}}]}");
                }

                if (host.Contains("wikidata", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse(
                        "{\"entities\":{\"" + qid + "\":{\"claims\":{},\"sitelinks\":{\"enwiki\":{\"title\":\"Post Malone\"}}}}}");
                }

                if (host.Contains("wikipedia", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse(
                        "{\"title\":\"Post Malone\",\"extract\":\"Bio from Wikipedia.\","
                        + "\"wikibase_item\":\"" + qid + "\","
                        + "\"content_urls\":{\"desktop\":{\"page\":\"https://en.wikipedia.org/wiki/Post_Malone\"}}}");
                }

                return JsonResponse("{}");
            });

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.RememberMusicBrainzIdForTests(name, mbid);
            MusicBrainzClient.ArtistLookupResult lookup = await MusicBrainzClient.GetArtistLookupAsync(name);

            Assert.Equal(MusicBrainzClient.ArtistLookupStatus.Found, lookup.Status);
            Assert.Equal(mbid, lookup.Profile.MusicBrainzId);
            Assert.False(string.IsNullOrWhiteSpace(lookup.Profile.Biography));
            Assert.Equal(0, searchHits);
        }

        [Fact]
        public async Task ForceRefreshArtist_BumpsGenerationAndClearsMemoryHit()
        {
            byte[] png = ArtistImageCacheTests.PngWithDimensions(1000, 800);
            StubHandler handler = BuildKnownArtistHandler(
                "Post Malone",
                "b1e26560-60e5-4236-bbdb-9aa5a8d5ee19",
                "Q21621919",
                "Post Malone",
                png,
                includeImage: false);
            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.ArtistLookupResult first =
                await MusicBrainzClient.GetArtistLookupAsync("Post Malone");
            Assert.Equal(MusicBrainzClient.ArtistLookupStatus.Found, first.Status);

            int before = MusicBrainzClient.GetLookupGeneration("Post Malone");
            MusicBrainzClient.ForceRefreshArtist("Post Malone");
            Assert.True(MusicBrainzClient.GetLookupGeneration("Post Malone") > before);

            // Memory was cleared — a follow-up lookup must refetch (still succeeds via stub).
            MusicBrainzClient.ArtistLookupResult second =
                await MusicBrainzClient.GetArtistLookupAsync("Post Malone");
            Assert.Equal(MusicBrainzClient.ArtistLookupStatus.Found, second.Status);
            Assert.False(string.IsNullOrWhiteSpace(second.Profile.Biography));
        }

        [Fact]
        public async Task ForceRefreshArtist_ClearsDiskCacheForOneArtistOnly()
        {
            byte[] png = ArtistImageCacheTests.PngWithDimensions(1000, 800);
            StubHandler handler = BuildKnownArtistHandler(
                "Post Malone",
                "b1e26560-60e5-4236-bbdb-9aa5a8d5ee19",
                "Q21621919",
                "Post Malone",
                png,
                includeImage: false);
            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            _ = await MusicBrainzClient.GetArtistLookupAsync("Post Malone");
            Assert.NotEmpty(Directory.GetFiles(Path.Combine(cacheRoot, "artists"), "*.json"));

            MusicBrainzClient.ForceRefreshArtist("Post Malone");
            Assert.Empty(Directory.GetFiles(Path.Combine(cacheRoot, "artists"), "*.json"));
        }

        private static StubHandler BuildKnownArtistHandler(
            string name,
            string mbid,
            string qid,
            string wikiTitle,
            byte[] png,
            bool includeImage,
            TimeSpan? imageDownloadDelay = null)
        {
            string artistType = name == "Post Malone" ? "Person" : "Group";
            string wikiPath = wikiTitle.Replace(" ", "_", StringComparison.Ordinal);
            string p18 = includeImage ? $"{name} portrait.jpg" : "";

            string searchJson = JsonSerializer.Serialize(new
            {
                artists = new[]
                {
                    new
                    {
                        id = mbid,
                        name,
                        score = 100,
                        type = artistType,
                        life_span = new { begin = "1994" },
                        tags = new[] { new { name = "rock", count = 8 } }
                    }
                }
            });
            // MusicBrainz uses "life-span" with a hyphen.
            searchJson = searchJson.Replace("\"life_span\"", "\"life-span\"", StringComparison.Ordinal);

            string lookupJson = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["id"] = mbid,
                ["name"] = name,
                ["type"] = artistType,
                ["life-span"] = new { begin = "1994" },
                ["genres"] = new[] { new { name = "rock", count = 8 } },
                ["relations"] = new[]
                {
                    new { type = "wikidata", url = new { resource = $"https://www.wikidata.org/wiki/{qid}" } }
                }
            });

            object claims = includeImage
                ? new Dictionary<string, object>
                {
                    ["P18"] = new object[]
                    {
                        new
                        {
                            mainsnak = new
                            {
                                datavalue = new { value = p18, type = "string" }
                            }
                        }
                    }
                }
                : new Dictionary<string, object>();

            string wikidataJson = JsonSerializer.Serialize(new
            {
                entities = new Dictionary<string, object>
                {
                    [qid] = new
                    {
                        claims,
                        sitelinks = new { enwiki = new { title = wikiTitle } }
                    }
                }
            });

            string wikipediaJson = JsonSerializer.Serialize(new
            {
                extract = $"{name} is a musical act used in EMP regression fixtures.",
                content_urls = new { desktop = new { page = $"https://en.wikipedia.org/wiki/{wikiPath}" } }
            });

            string categoryJson = includeImage
                ? JsonSerializer.Serialize(new
                {
                    query = new
                    {
                        categorymembers = new[]
                        {
                            new { ns = 6, title = $"File:{name} category photo.jpg" }
                        }
                    }
                })
                : "{\"query\":{\"categorymembers\":[]}}";

            return new StubHandler(request =>
            {
                string host = request.RequestUri!.Host;
                string full = request.RequestUri.AbsoluteUri;

                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("query=", StringComparison.Ordinal))
                {
                    return JsonResponse(searchJson);
                }

                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains($"/artist/{mbid}", StringComparison.Ordinal))
                {
                    return JsonResponse(lookupJson);
                }

                if (host.Contains("wikidata", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse(wikidataJson);
                }

                if (host.Contains("wikipedia", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse(wikipediaJson);
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("list=search", StringComparison.Ordinal))
                {
                    return JsonResponse("{\"query\":{\"search\":[]}}");
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("list=categorymembers", StringComparison.Ordinal))
                {
                    return JsonResponse(categoryJson);
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("prop=imageinfo", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"query":{"pages":{"1":{"imageinfo":[{
                          "thumburl":"https://commons.test/artist.jpg",
                          "thumbwidth":1200,"thumbheight":800,
                          "mime":"image/png",
                          "extmetadata":{
                            "LicenseShortName":{"value":"CC BY-SA 4.0"},
                            "LicenseUrl":{"value":"https://creativecommons.org/licenses/by-sa/4.0/"},
                            "Artist":{"value":"Fixture Photographer"}
                          }
                        }]}}}}
                        """);
                }

                if (full.Contains("commons.test/artist", StringComparison.Ordinal))
                {
                    var imageResponse = new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new ByteArrayContent(png)
                        {
                            Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png") }
                        }
                    };
                    if (imageDownloadDelay is TimeSpan delay && delay > TimeSpan.Zero)
                    {
                        imageResponse.Headers.Add("X-Emp-Test-Delay-Ms", ((int)delay.TotalMilliseconds).ToString());
                    }

                    return imageResponse;
                }

                return JsonResponse("{}");
            });
        }

        private static HttpResponseMessage JsonResponse(string json) =>
            new(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            };

        private sealed class StubHandler : HttpMessageHandler
        {
            private readonly Func<HttpRequestMessage, HttpResponseMessage> responder;

            public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
            {
                this.responder = responder;
            }

            protected override async Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                // Delay happens inside responder via Thread.Sleep today for download
                // simulation; prefer async so Task.WhenAny image budgets can win.
                HttpResponseMessage response = responder(request);
                if (response.Headers.TryGetValues("X-Emp-Test-Delay-Ms", out System.Collections.Generic.IEnumerable<string>? values)
                    && int.TryParse(values.FirstOrDefault(), out int delayMs)
                    && delayMs > 0)
                {
                    await Task.Delay(delayMs, cancellationToken);
                    response.Headers.Remove("X-Emp-Test-Delay-Ms");
                }

                return response;
            }
        }
    }

    /// <summary>
    /// Optional live smoke against MusicBrainz/Wikidata/Commons. Skipped unless
    /// EMP_LIVE_ARTIST_SMOKE=1 is set in the environment.
    /// </summary>
    [Collection(ArtistMetadataTestCollection.Name)]
    public sealed class ArtistEnrichmentLiveSmokeTests
    {
        public static bool LiveEnabled =>
            string.Equals(Environment.GetEnvironmentVariable("EMP_LIVE_ARTIST_SMOKE"), "1", StringComparison.Ordinal);

        [Fact]
        public async Task Live_KnownArtists_HaveUsableProfiles()
        {
            if (!LiveEnabled)
            {
                return;
            }

            string root = Path.Combine(Path.GetTempPath(), "EMP-ArtistLiveSmoke", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                MusicBrainzClient.ResetTestState();
                foreach (string name in new[] { "The Offspring", "Bullet for My Valentine", "Post Malone" })
                {
                    MusicBrainzClient.ForceRefreshArtist(name);
                    MusicBrainzClient.ArtistLookupResult lookup = await MusicBrainzClient.GetArtistLookupAsync(name);
                    Assert.True(
                        lookup.Status != MusicBrainzClient.ArtistLookupStatus.ConfirmedEmpty,
                        $"{name} should not be confirmed-empty");
                    if (lookup.Status == MusicBrainzClient.ArtistLookupStatus.Found)
                    {
                        Assert.True(MusicBrainzClient.HasProfileData(lookup.Profile), $"{name} missing profile data");
                    }
                }
            }
            finally
            {
                MusicBrainzClient.ResetTestState();
                try { Directory.Delete(root, true); } catch { /* ignore */ }
            }
        }
    }
}
