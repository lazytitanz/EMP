using System.Net;
using System.Text;
using System.Text.Json;
using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    [Collection(ArtistMetadataTestCollection.Name)]
    public sealed class ArtistProfileIdentityTests : IDisposable
    {
        private readonly string cacheRoot;

        public ArtistProfileIdentityTests()
        {
            cacheRoot = Path.Combine(Path.GetTempPath(), "EMP-ArtistProfileTests", Guid.NewGuid().ToString("N"));
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
                // Best-effort cleanup.
            }
        }

        [Fact]
        public void SelectConfidentArtist_AcceptsSingleExactMatch()
        {
            using JsonDocument document = JsonDocument.Parse("""
                {"artists":[{"id":"mb-1","name":"Audioslave","score":98}]}
                """);
            JsonElement? selected = MusicBrainzClient.SelectConfidentArtist(
                document.RootElement.GetProperty("artists"),
                "Audioslave");
            Assert.NotNull(selected);
            Assert.Equal("mb-1", selected!.Value.GetProperty("id").GetString());
        }

        [Fact]
        public void SelectConfidentArtist_OmitsWhenMultipleMusicalExactMatchesAreClose()
        {
            using JsonDocument document = JsonDocument.Parse("""
                {"artists":[
                  {"id":"a","name":"Sphere","score":95,"disambiguation":"band","tags":[{"name":"jazz","count":3}]},
                  {"id":"b","name":"Sphere","score":92,"disambiguation":"rapper","tags":[{"name":"hip hop","count":4}]}
                ]}
                """);
            Assert.Null(MusicBrainzClient.SelectConfidentArtist(
                document.RootElement.GetProperty("artists"),
                "Sphere"));
        }

        [Fact]
        public void SelectConfidentArtist_PrefersUniqueMusicEvidenceAmongExactMatches()
        {
            using JsonDocument document = JsonDocument.Parse("""
                {"artists":[
                  {"id":"f4e4a8c2-4ee8-42eb-9c6a-0c21a06097a6","name":"Julia Wolf","score":100,
                   "disambiguation":"alternative rock singer-songwriter from New York",
                   "tags":[{"name":"alternative rock","count":1}],
                   "ipis":["00897133007"]},
                  {"id":"b89456e0-cf8d-4a29-baed-4b2d1fe3ef6a","name":"Julia Wolf","score":90,
                   "disambiguation":"design"}
                ]}
                """);
            JsonElement? selected = MusicBrainzClient.SelectConfidentArtist(
                document.RootElement.GetProperty("artists"),
                "Julia Wolf");
            Assert.NotNull(selected);
            Assert.Equal("f4e4a8c2-4ee8-42eb-9c6a-0c21a06097a6", selected!.Value.GetProperty("id").GetString());
        }

        [Fact]
        public void SelectConfidentArtist_AcceptsDominantExactMatchAmongMany()
        {
            using JsonDocument document = JsonDocument.Parse("""
                {"artists":[
                  {"id":"a","name":"Nova","score":100},
                  {"id":"b","name":"Nova","score":70}
                ]}
                """);
            JsonElement? selected = MusicBrainzClient.SelectConfidentArtist(
                document.RootElement.GetProperty("artists"),
                "Nova");
            Assert.NotNull(selected);
            Assert.Equal("a", selected!.Value.GetProperty("id").GetString());
        }

        [Fact]
        public void SelectConfidentArtist_NeverAcceptsNonExactHighScore()
        {
            using JsonDocument document = JsonDocument.Parse("""
                {"artists":[{"id":"x","name":"Audio Slave","score":100}]}
                """);
            Assert.Null(MusicBrainzClient.SelectConfidentArtist(
                document.RootElement.GetProperty("artists"),
                "Audioslave"));
        }

        [Theory]
        [InlineData("CC BY 4.0", true)]
        [InlineData("CC BY-SA 3.0", true)]
        [InlineData("CC0", true)]
        [InlineData("Public domain", true)]
        [InlineData("GNU Free Documentation License", false)]
        [InlineData("Fair use", false)]
        [InlineData("", false)]
        public void IsAllowedLicense_FiltersUnsupportedLicenses(string license, bool allowed)
        {
            Assert.Equal(allowed, MusicBrainzClient.IsAllowedLicense(license));
        }

        [Fact]
        public void TryReadLicense_RequiresAttributionForCcBy()
        {
            using JsonDocument document = JsonDocument.Parse("""
                {
                  "extmetadata": {
                    "LicenseShortName": { "value": "CC BY 4.0" },
                    "LicenseUrl": { "value": "https://creativecommons.org/licenses/by/4.0/" }
                  }
                }
                """);
            Assert.False(MusicBrainzClient.TryReadLicense(
                document.RootElement,
                out _,
                out _,
                out _,
                out _));
        }

        [Fact]
        public void TryReadLicense_AcceptsCompleteCcByMetadata()
        {
            using JsonDocument document = JsonDocument.Parse("""
                {
                  "extmetadata": {
                    "LicenseShortName": { "value": "CC BY-SA 3.0" },
                    "LicenseUrl": { "value": "https://creativecommons.org/licenses/by-sa/3.0/" },
                    "Artist": { "value": "Jane Photographer" },
                    "Credit": { "value": "Jane Photographer / Wikimedia Commons" }
                  }
                }
                """);
            Assert.True(MusicBrainzClient.TryReadLicense(
                document.RootElement,
                out string? license,
                out string? licenseUrl,
                out string? author,
                out string? credit));
            Assert.Equal("CC BY-SA 3.0", license);
            Assert.Equal("https://creativecommons.org/licenses/by-sa/3.0/", licenseUrl);
            Assert.Equal("Jane Photographer", author);
            Assert.Contains("Jane Photographer", credit);
        }

        [Fact]
        public async Task GetArtistProfileAsync_DoesNotNegativeCacheTransientFailures()
        {
            StubHandler handler = new(request =>
            {
                if (request.RequestUri!.Host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase))
                {
                    return new HttpResponseMessage(HttpStatusCode.TooManyRequests);
                }

                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{}", Encoding.UTF8, "application/json")
                };
            });

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot);
            MusicBrainzClient.ArtistProfile first = await MusicBrainzClient.GetArtistProfileAsync("Transient Artist");
            Assert.False(MusicBrainzClient.HasProfileData(first));

            string artistsDir = Path.Combine(cacheRoot, "artists");
            if (Directory.Exists(artistsDir))
            {
                Assert.Empty(Directory.GetFiles(artistsDir, "*.json"));
            }
        }

        [Fact]
        public async Task GetArtistProfileAsync_CachesConfirmedEmptyAndPreservesStaleOnFailure()
        {
            int musicBrainzCalls = 0;
            StubHandler handler = new(request =>
            {
                string host = request.RequestUri!.Host;
                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && request.RequestUri.AbsolutePath.Contains("/artist/", StringComparison.Ordinal))
                {
                    // lookup path unused in empty search
                }

                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase))
                {
                    musicBrainzCalls++;
                    if (musicBrainzCalls == 1)
                    {
                        return JsonResponse("""{"artists":[]}""");
                    }

                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
                }

                return JsonResponse("{}");
            });

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot);
            MusicBrainzClient.ArtistProfile empty = await MusicBrainzClient.GetArtistProfileAsync("Missing Artist");
            Assert.False(MusicBrainzClient.HasProfileData(empty));
            Assert.True(Directory.Exists(Path.Combine(cacheRoot, "artists")));
            Assert.NotEmpty(Directory.GetFiles(Path.Combine(cacheRoot, "artists"), "*.json"));

            // Warm memory clear to force disk read of confirmed-empty.
            MusicBrainzClient.ResetTestState();
            MusicBrainzClient.ConfigureForTests(handler, cacheRoot);
            MusicBrainzClient.ArtistProfile cachedEmpty = await MusicBrainzClient.GetArtistProfileAsync("Missing Artist");
            Assert.False(MusicBrainzClient.HasProfileData(cachedEmpty));
        }

        [Theory]
        [InlineData("File:Giveon portrait 2021.jpg", false)]
        [InlineData("File:Giveon album cover.png", true)]
        [InlineData("File:Band logo.svg", true)]
        [InlineData("File:Artist wordmark.png", true)]
        [InlineData("File:Some discography chart.jpg", true)]
        public void IsUnsuitableCommonsTitle_RejectsAlbumArtAndLogos(string title, bool unsuitable)
        {
            Assert.Equal(unsuitable, MusicBrainzClient.IsUnsuitableCommonsTitle(title));
        }

        [Fact]
        public void SelectConfidentCommonsSearchTitle_RequiresSingleStrongNameMatch()
        {
            Assert.Equal(
                "File:Julia Wolf live 2019.jpg",
                MusicBrainzClient.SelectConfidentCommonsSearchTitle(
                    [
                        "File:Julia Wolf live 2019.jpg",
                        "File:Random festival crowd.jpg",
                        "File:Julia Wolf album cover.png"
                    ],
                    "Julia Wolf"));

            Assert.Null(MusicBrainzClient.SelectConfidentCommonsSearchTitle(
                [
                    "File:Julia Wolf live 2019.jpg",
                    "File:Julia Wolf studio portrait.jpg"
                ],
                "Julia Wolf"));

            Assert.Null(MusicBrainzClient.SelectConfidentCommonsSearchTitle(
                ["File:Someone else.jpg"],
                "Julia Wolf"));
        }

        [Fact]
        public async Task GetArtistProfileAsync_CommonsSearchFillsImageWhenP18Missing()
        {
            byte[] png = ArtistImageCacheTests.PngWithDimensions(1000, 800);
            StubHandler handler = new(request =>
            {
                string host = request.RequestUri!.Host;
                string full = request.RequestUri.AbsoluteUri;
                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("query=", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"artists":[{"id":"mbid-img","name":"Julia Wolf","score":100,"type":"Person",
                          "life-span":{"begin":"1990"},"tags":[{"name":"pop","count":4}]}]}
                        """);
                }

                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("/artist/mbid-img", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"id":"mbid-img","name":"Julia Wolf","type":"Person",
                         "life-span":{"begin":"1990"},
                         "genres":[{"name":"pop","count":4}],
                         "relations":[{"type":"wikidata","url":{"resource":"https://www.wikidata.org/wiki/Q9"}}]}
                        """);
                }

                if (host.Contains("wikidata", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse("""
                        {"entities":{"Q9":{"claims":{},"sitelinks":{"enwiki":{"title":"Julia Wolf"}}}}}
                        """);
                }

                if (host.Contains("wikipedia", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse("""
                        {"extract":"Julia Wolf is a singer.",
                         "content_urls":{"desktop":{"page":"https://en.wikipedia.org/wiki/Julia_Wolf"}}}
                        """);
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("list=search", StringComparison.Ordinal)
                    && full.Contains("haswbstatement", StringComparison.Ordinal))
                {
                    return JsonResponse("""{"query":{"search":[]}}""");
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("list=search", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"query":{"search":[{"title":"File:Julia Wolf live 2019.jpg"}]}}
                        """);
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("prop=imageinfo", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"query":{"pages":{"1":{"imageinfo":[{
                          "thumburl":"https://commons.test/julia.jpg",
                          "thumbwidth":1000,"thumbheight":800,
                          "url":"https://commons.test/julia-full.jpg",
                          "descriptionurl":"https://commons.wikimedia.org/wiki/File:Julia_Wolf_live_2019.jpg",
                          "mime":"image/png",
                          "extmetadata":{
                            "LicenseShortName":{"value":"CC BY-SA 3.0"},
                            "LicenseUrl":{"value":"https://creativecommons.org/licenses/by-sa/3.0/"},
                            "Artist":{"value":"Photographer"}
                          }
                        }]}}}}
                        """);
                }

                if (full.Contains("commons.test/julia", StringComparison.Ordinal))
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new ByteArrayContent(png)
                        {
                            Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png") }
                        }
                    };
                }

                return JsonResponse("{}");
            });

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.ArtistProfile profile = await MusicBrainzClient.GetArtistProfileAsync("Julia Wolf");
            Assert.True(MusicBrainzClient.HasProfileData(profile));
            Assert.NotNull(profile.Image);
            Assert.False(profile.Image!.IsCustom);
            Assert.Equal("CC BY-SA 3.0", profile.Image.License);
            Assert.StartsWith("https://artist-art.emp/", profile.Image.Url);
        }

        [Fact]
        public async Task GetArtistProfileAsync_RejectsUnlicensedCommonsSearchHit()
        {
            StubHandler handler = new(request =>
            {
                string host = request.RequestUri!.Host;
                string full = request.RequestUri.AbsoluteUri;
                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("query=", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"artists":[{"id":"mbid-fair","name":"Fair Use Band","score":100,"type":"Group"}]}
                        """);
                }

                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("/artist/mbid-fair", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"id":"mbid-fair","name":"Fair Use Band","type":"Group",
                         "relations":[{"type":"wikidata","url":{"resource":"https://www.wikidata.org/wiki/Q8"}}]}
                        """);
                }

                if (host.Contains("wikidata", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse("""{"entities":{"Q8":{"claims":{},"sitelinks":{}}}}""");
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("list=search", StringComparison.Ordinal)
                    && full.Contains("haswbstatement", StringComparison.Ordinal))
                {
                    return JsonResponse("""{"query":{"search":[]}}""");
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("list=search", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"query":{"search":[{"title":"File:Fair Use Band live.jpg"}]}}
                        """);
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("prop=imageinfo", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"query":{"pages":{"1":{"imageinfo":[{
                          "thumburl":"https://commons.test/fair.jpg",
                          "thumbwidth":1000,"thumbheight":800,
                          "mime":"image/jpeg",
                          "extmetadata":{
                            "LicenseShortName":{"value":"Fair use"}
                          }
                        }]}}}}
                        """);
                }

                return JsonResponse("{}");
            });

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.ArtistProfile profile = await MusicBrainzClient.GetArtistProfileAsync("Fair Use Band");
            Assert.True(MusicBrainzClient.HasProfileData(profile));
            Assert.Null(profile.Image);
        }

        [Fact]
        public async Task GetArtistProfileAsync_ImageResolutionRetryWithoutSchemaBump()
        {
            byte[] png = ArtistImageCacheTests.PngWithDimensions(1000, 800);
            // Seed an older cache entry: metadata present, no image, imageResolutionVersion 0.
            string keyHash = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(
                    System.Text.Encoding.UTF8.GetBytes("retry artist".Trim().ToLowerInvariant())))[..16];
            string artistsDir = Path.Combine(cacheRoot, "artists");
            Directory.CreateDirectory(artistsDir);
            File.WriteAllText(Path.Combine(artistsDir, $"{keyHash}.json"), """
                {
                  "schemaVersion": 3,
                  "imageResolutionVersion": 0,
                  "confirmedEmpty": false,
                  "cachedAt": "2099-01-01T00:00:00+00:00",
                  "profile": {
                    "name": "Retry Artist",
                    "musicBrainzId": "mbid-retry",
                    "wikidataId": "Q7",
                    "type": "Person",
                    "genres": ["Soul"],
                    "biography": "A singer."
                  }
                }
                """);

            StubHandler handler = new(request =>
            {
                string host = request.RequestUri!.Host;
                string full = request.RequestUri.AbsoluteUri;
                if (host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase))
                {
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
                }

                if (host.Contains("wikidata", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse("""{"entities":{"Q7":{"claims":{},"sitelinks":{}}}}""");
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("list=search", StringComparison.Ordinal)
                    && full.Contains("haswbstatement", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"query":{"search":[{"title":"File:Retry Artist portrait.jpg"}]}}
                        """);
                }

                if (host.Contains("commons", StringComparison.OrdinalIgnoreCase)
                    && full.Contains("prop=imageinfo", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"query":{"pages":{"1":{"imageinfo":[{
                          "thumburl":"https://commons.test/retry.jpg",
                          "thumbwidth":1000,"thumbheight":800,
                          "mime":"image/png",
                          "extmetadata":{
                            "LicenseShortName":{"value":"CC BY 4.0"},
                            "LicenseUrl":{"value":"https://creativecommons.org/licenses/by/4.0/"},
                            "Artist":{"value":"Pat"}
                          }
                        }]}}}}
                        """);
                }

                if (full.Contains("commons.test/retry", StringComparison.Ordinal))
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new ByteArrayContent(png)
                        {
                            Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png") }
                        }
                    };
                }

                return JsonResponse("{}");
            });

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot, Path.Combine(cacheRoot, "images"));
            MusicBrainzClient.ArtistProfile profile = await MusicBrainzClient.GetArtistProfileAsync("Retry Artist");
            Assert.Equal("A singer.", profile.Biography);
            Assert.NotNull(profile.Image);
            Assert.Contains("Soul", profile.Genres);
        }

        [Fact]
        public async Task GetArtistProfileAsync_UsesConfidentMatchAndPersistsProfile()
        {
            StubHandler handler = new(request =>
            {
                string path = request.RequestUri!.AbsolutePath + request.RequestUri.Query;
                if (request.RequestUri.Host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && path.Contains("query=", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"artists":[{"id":"mbid-1","name":"Audioslave","score":100,"type":"Group",
                          "life-span":{"begin":"2001"},"tags":[{"name":"alternative rock","count":12}]}]}
                        """);
                }

                if (request.RequestUri.Host.Contains("musicbrainz", StringComparison.OrdinalIgnoreCase)
                    && path.Contains("/artist/mbid-1", StringComparison.Ordinal))
                {
                    return JsonResponse("""
                        {"id":"mbid-1","name":"Audioslave","type":"Group",
                         "life-span":{"begin":"2001","end":"2007"},
                         "genres":[{"name":"alternative rock","count":20}],
                         "relations":[{"type":"wikidata","url":{"resource":"https://www.wikidata.org/wiki/Q484109"}}]}
                        """);
                }

                if (request.RequestUri.Host.Contains("wikidata", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse("""
                        {"entities":{"Q484109":{"claims":{},"sitelinks":{"enwiki":{"title":"Audioslave"}}}}}
                        """);
                }

                if (request.RequestUri.Host.Contains("wikipedia", StringComparison.OrdinalIgnoreCase))
                {
                    return JsonResponse("""
                        {"extract":"Audioslave was an American rock supergroup.",
                         "content_urls":{"desktop":{"page":"https://en.wikipedia.org/wiki/Audioslave"}}}
                        """);
                }

                return JsonResponse("{}");
            });

            MusicBrainzClient.ConfigureForTests(handler, cacheRoot);
            MusicBrainzClient.ArtistProfile profile = await MusicBrainzClient.GetArtistProfileAsync("Audioslave");
            Assert.True(MusicBrainzClient.HasProfileData(profile));
            Assert.Equal("mbid-1", profile.MusicBrainzId);
            Assert.Equal("Q484109", profile.WikidataId);
            Assert.Equal("Group", profile.Type);
            Assert.Equal("2001", profile.BeginYear);
            Assert.Equal("2007", profile.EndYear);
            Assert.Contains(profile.Genres, genre => genre.Contains("Alternative", StringComparison.OrdinalIgnoreCase));
            Assert.Contains("Audioslave was an American rock supergroup.", profile.Biography);
            Assert.Equal("https://en.wikipedia.org/wiki/Audioslave", profile.WikipediaUrl);
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

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                return Task.FromResult(responder(request));
            }
        }
    }
}
