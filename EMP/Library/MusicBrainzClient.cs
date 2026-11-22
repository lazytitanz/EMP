using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace EMP.Library
{
    /// <summary>
    /// Resolves rich artist profiles via MusicBrainz → verified Wikidata → Wikipedia/Commons.
    /// Artist identity remains name-keyed for EMP navigation; external IDs are enrichment only.
    /// </summary>
    internal static class MusicBrainzClient
    {
        private const int SchemaVersion = 3;
        /// <summary>
        /// Advances independently of <see cref="SchemaVersion"/> so artists cached without a photo
        /// can retry image resolution without discarding bios/genres or successful image blobs.
        /// v2: Commons category discovery after P18/P180/title search.
        /// </summary>
        private const int ImageResolutionVersion = 2;
        private const int MaxCommonsCategoryFileAttempts = 8;
        private const int MaxCommonsCategorySubcats = 4;
        private const int MaxGenres = 4;
        private const int MinExactScore = 80;
        private const int DominantExactScore = 90;
        private const int DominantScoreGap = 20;
        private const int MaxCommonsSearchCandidates = 6;
        private const int MaxCommonsDepictAttempts = 4;
        private const string ProjectUrl = "https://github.com/lazytitanz/EMP";
        private const string LogPrefix = "EMP artist:";

        private static readonly Regex UnsuitableCommonsTitle = new(
            @"\b(album\s*cover|cover\s*art|coverart|logo|wordmark|word\s*mark|favicon|icon|barcode|discography|mixtape|single\s*cover|ep\s*cover|soundtrack\s*cover|stub|svg)\b|\.svg\b",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly HashSet<string> MusicDisambiguationHints = new(StringComparer.OrdinalIgnoreCase)
        {
            "singer", "songwriter", "musician", "rapper", "band", "group", "dj", "producer",
            "vocalist", "guitarist", "drummer", "bassist", "composer", "mc", "artist",
            "rock", "pop", "hip hop", "hip-hop", "metal", "punk", "jazz", "indie", "folk",
            "electronic", "soul", "r&b", "rnb", "country", "blues"
        };

        private static readonly HashSet<string> NonMusicDisambiguationHints = new(StringComparer.OrdinalIgnoreCase)
        {
            "design", "designer", "mathematician", "actor", "actress", "politician", "painter",
            "author", "writer", "journalist", "athlete", "footballer", "soccer", "model",
            "photographer", "architect", "scientist", "professor", "lawyer", "doctor"
        };

        private static readonly TimeSpan ArtistCacheLifetime = TimeSpan.FromDays(30);
        private static readonly TimeSpan NegativeCacheLifetime = TimeSpan.FromDays(7);
        private static readonly TimeSpan AreaCacheLifetime = TimeSpan.FromDays(90);
        /// <summary>
        /// Short cooldown so a single soft UI retry can re-hit MusicBrainz after shedding
        /// (Retry-After is often 1s). Avoids the old 45s window that looked like a permanent miss.
        /// </summary>
        private static readonly TimeSpan TransientCooldown = TimeSpan.FromSeconds(8);
        private static readonly TimeSpan MinRequestSpacing = TimeSpan.FromMilliseconds(1100);
        private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromSeconds(5);
        /// <summary>Keep metadata delivery inside the WebView's artist-info timeout budget.</summary>
        private static TimeSpan imageResolutionBudget = TimeSpan.FromSeconds(7);

        private static readonly HashSet<string> GenericGenres = new(StringComparer.OrdinalIgnoreCase)
        {
            "music", "rock music", "popular music", "contemporary music"
        };

        private static readonly HashSet<string> AllowedLicenseTokens = new(StringComparer.OrdinalIgnoreCase)
        {
            "cc0", "cc-zero", "public domain", "pd", "pdm",
            "cc by", "cc-by", "cc by-sa", "cc-by-sa",
            "creative commons attribution",
            "creative commons attribution-sharealike",
            "creative commons attribution sharealike"
        };

        private static readonly Regex WikidataIdPattern = new(
            @"^Q\d+$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static HttpClient Http = CreateHttpClient();
        private static readonly SemaphoreSlim RequestGate = new(1, 1);
        private static readonly ConcurrentDictionary<string, Task<ArtistLookupResult>> InFlight = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, ArtistProfile> ArtistMemory = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, DateTimeOffset> TransientFailures = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, int> LookupGeneration = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, AreaRecord> AreaMemory = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>Name-key → MusicBrainz ID. Survives ForceRefresh so we can skip the flaky search API.</summary>
        private static readonly ConcurrentDictionary<string, string> KnownMusicBrainzIds = new(StringComparer.OrdinalIgnoreCase);
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        private static DateTimeOffset nextRequestAt = DateTimeOffset.MinValue;
        private static string? cacheRootOverride;

        public static string CacheRoot => cacheRootOverride ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "MusicBrainz");

        public static string ArtistMetadataRoot => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "ArtistMetadata");

        internal static void ConfigureForTests(HttpMessageHandler handler, string cacheRoot, string? imageRoot = null)
        {
            Http?.Dispose();
            // Tests own the handler lifetime so ResetTestState + reconfigure can reuse stubs.
            Http = new HttpClient(handler, disposeHandler: false)
            {
                Timeout = TimeSpan.FromSeconds(20)
            };
            string agent = $"EMP/{ApplicationVersion()} ({ProjectUrl})";
            Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", agent);
            Http.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");
            cacheRootOverride = cacheRoot;
            ArtistImageCache.Root = imageRoot ?? Path.Combine(cacheRoot, "images");
            ArtistMemory.Clear();
            TransientFailures.Clear();
            LookupGeneration.Clear();
            AreaMemory.Clear();
            KnownMusicBrainzIds.Clear();
            InFlight.Clear();
            imageResolutionBudget = TimeSpan.FromSeconds(7);
            nextRequestAt = DateTimeOffset.MinValue;
        }

        internal static void ResetTestState()
        {
            cacheRootOverride = null;
            ArtistImageCache.Root = ArtistImageCache.DefaultRoot;
            ArtistMemory.Clear();
            TransientFailures.Clear();
            LookupGeneration.Clear();
            AreaMemory.Clear();
            KnownMusicBrainzIds.Clear();
            InFlight.Clear();
            imageResolutionBudget = TimeSpan.FromSeconds(7);
            nextRequestAt = DateTimeOffset.MinValue;
            Http?.Dispose();
            Http = CreateHttpClient();
        }

        /// <summary>Test helper: seed a known MusicBrainz ID without a full profile cache.</summary>
        internal static void RememberMusicBrainzIdForTests(string name, string mbid) =>
            RememberMusicBrainzId(Normalize(name), mbid);

        internal static void SetImageResolutionBudgetForTests(TimeSpan budget) =>
            imageResolutionBudget = budget;

        public static async Task<ArtistProfile> GetArtistProfileAsync(string name)
        {
            ArtistLookupResult result = await GetArtistLookupAsync(name);
            return result.Profile;
        }

        /// <summary>
        /// Lookup with explicit status so hosts can avoid treating MusicBrainz 503/timeouts
        /// as confirmed-empty (which the WebView session used to cache forever).
        /// </summary>
        public static Task<ArtistLookupResult> GetArtistLookupAsync(string name)
        {
            string key = Normalize(name);
            if (ArtistMemory.TryGetValue(key, out ArtistProfile? cached) && HasProfileData(cached))
            {
                LogDiag(name, "memory-hit", ArtistLookupStatus.Found, cached);
                return Task.FromResult(ArtistLookupResult.Found(ApplyCustomImage(cached)));
            }

            // Cooldown: prefer stale disk profile; otherwise return Transient quickly so the
            // host can clear the WebView skeleton without waiting out a silent timeout.
            if (TransientFailures.TryGetValue(key, out DateTimeOffset failedAt) &&
                DateTimeOffset.UtcNow - failedAt < TransientCooldown)
            {
                if (TryReadArtistCache(key, out CachedArtist? stale, ignoreExpiry: true) &&
                    stale?.Profile is not null &&
                    HasProfileData(stale.Profile))
                {
                    ArtistProfile ready = ApplyCustomImage(WithLocalImageUrl(stale.Profile));
                    LogDiag(name, "stale-after-transient", ArtistLookupStatus.Found, ready);
                    return Task.FromResult(ArtistLookupResult.Found(ready));
                }

                LogDiag(name, "transient-cooldown", ArtistLookupStatus.Transient, Empty(name));
                return Task.FromResult(ArtistLookupResult.Transient(Empty(name)));
            }

            return InFlight.GetOrAdd(key, static (_, requestedName) => LoadArtistAsync(requestedName), name);
        }

        /// <summary>
        /// Drops memory + disk cache for one artist so the next lookup refetches metadata/images.
        /// Does not touch other artists or the music library.
        /// </summary>
        public static void ForceRefreshArtist(string name)
        {
            string key = Normalize(name);
            // Keep MusicBrainz ID across refresh so we can re-fetch via /artist/{mbid}
            // instead of the search endpoint (often shed with HTTP 503).
            if (ArtistMemory.TryGetValue(key, out ArtistProfile? remembered)
                && !string.IsNullOrWhiteSpace(remembered.MusicBrainzId))
            {
                RememberMusicBrainzId(key, remembered.MusicBrainzId);
            }
            else if (TryReadArtistCache(key, out CachedArtist? cached, ignoreExpiry: true)
                && !string.IsNullOrWhiteSpace(cached?.Profile?.MusicBrainzId))
            {
                RememberMusicBrainzId(key, cached!.Profile!.MusicBrainzId!);
            }

            TryReadIdentityCache(key);

            ArtistMemory.TryRemove(key, out _);
            TransientFailures.TryRemove(key, out _);
            InFlight.TryRemove(key, out _);
            LookupGeneration.AddOrUpdate(key, 1, static (_, generation) => generation + 1);
            try
            {
                string path = ArtistCachePath(key);
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception)
            {
                // Best-effort.
            }

            Log(
                $"refresh name='{name}' generation={LookupGeneration.GetValueOrDefault(key)} "
                + $"mbid={KnownMusicBrainzIds.GetValueOrDefault(key) ?? "-"}");
        }

        internal static int GetLookupGeneration(string name) =>
            LookupGeneration.GetValueOrDefault(Normalize(name));

        private static async Task<ArtistLookupResult> LoadArtistAsync(string name)
        {
            string key = Normalize(name);
            int generation = LookupGeneration.GetOrAdd(key, 0);
            var timer = Stopwatch.StartNew();
            try
            {
                if (TryReadArtistCache(key, out CachedArtist? cached) && cached is not null)
                {
                    if (cached.ConfirmedEmpty)
                    {
                        ArtistLookupResult empty = ArtistLookupResult.ConfirmedEmpty(ApplyCustomImage(Empty(name)));
                        LogDiag(name, "disk-confirmed-empty", empty.Status, empty.Profile, timer.ElapsedMilliseconds);
                        return empty;
                    }

                    if (cached.Profile is not null && HasProfileData(cached.Profile))
                    {
                        ArtistProfile profile = WithLocalImageUrl(cached.Profile);
                        // Targeted image retry: only when photo is missing and image-resolution
                        // version advanced. Successful images and metadata stay untouched.
                        if (profile.Image is null
                            && cached.ImageResolutionVersion < ImageResolutionVersion
                            && !string.IsNullOrWhiteSpace(profile.WikidataId))
                        {
                            ArtistImageInfo? image = await RetryResolveArtistImageAsync(profile);
                            profile = profile with { Image = image };
                            if (IsCurrentGeneration(key, generation))
                            {
                                WriteArtistCache(
                                    key,
                                    profile,
                                    confirmedEmpty: false,
                                    imageResolutionVersion: ImageResolutionVersion);
                            }
                            Log($"image retry name='{name}' qid={profile.WikidataId} result={(image is null ? "miss" : "hit")}");
                        }

                        ArtistProfile ready = ApplyCustomImage(profile);
                        if (IsCurrentGeneration(key, generation))
                        {
                            ArtistMemory[key] = ready;
                        }
                        LogDiag(name, "disk-hit", ArtistLookupStatus.Found, ready, timer.ElapsedMilliseconds);
                        return ArtistLookupResult.Found(ready);
                    }
                }

                FetchOutcome outcome = await FetchArtistProfileAsync(name);
                if (outcome.Kind == FetchKind.Found && outcome.Profile is not null)
                {
                    ArtistProfile ready = ApplyCustomImage(WithLocalImageUrl(outcome.Profile));
                    if (IsCurrentGeneration(key, generation))
                    {
                        ArtistMemory[key] = ready;
                        // Never persist custom overlays into the online cache.
                    ArtistProfile toStore = ready with
                    {
                        Image = ready.Image is { IsCustom: true } ? null : ready.Image
                    };
                    int imageVersion = toStore.ImageResolutionIncomplete
                        ? 0
                        : ImageResolutionVersion;
                    WriteArtistCache(
                        key,
                        toStore with { ImageResolutionIncomplete = false },
                        confirmedEmpty: false,
                        imageResolutionVersion: imageVersion);
                        if (!string.IsNullOrWhiteSpace(ready.MusicBrainzId))
                        {
                            RememberMusicBrainzId(key, ready.MusicBrainzId);
                        }

                        TransientFailures.TryRemove(key, out _);
                    }
                    else
                    {
                        Log($"stale-discard name='{name}' generation={generation} current={GetLookupGeneration(name)}");
                    }

                    LogDiag(name, "fetch-found", ArtistLookupStatus.Found, ready, timer.ElapsedMilliseconds);
                    return ArtistLookupResult.Found(ready);
                }

                if (outcome.Kind == FetchKind.ConfirmedEmpty)
                {
                    if (IsCurrentGeneration(key, generation))
                    {
                        WriteArtistCache(key, Empty(name), confirmedEmpty: true, imageResolutionVersion: ImageResolutionVersion);
                        TransientFailures.TryRemove(key, out _);
                    }

                    ArtistLookupResult empty = ArtistLookupResult.ConfirmedEmpty(ApplyCustomImage(Empty(name)));
                    LogDiag(name, "fetch-empty", empty.Status, empty.Profile, timer.ElapsedMilliseconds);
                    return empty;
                }

                // Transient failure: never negative-cache; prefer stale positive profile.
                TransientFailures[key] = DateTimeOffset.UtcNow;
                if (TryReadArtistCache(key, out CachedArtist? stale, ignoreExpiry: true) &&
                    stale?.Profile is not null &&
                    HasProfileData(stale.Profile) &&
                    !stale.ConfirmedEmpty)
                {
                    ArtistProfile ready = ApplyCustomImage(WithLocalImageUrl(stale.Profile));
                    if (IsCurrentGeneration(key, generation))
                    {
                        ArtistMemory[key] = ready;
                    }

                    LogDiag(name, "transient-stale", ArtistLookupStatus.Found, ready, timer.ElapsedMilliseconds);
                    return ArtistLookupResult.Found(ready);
                }

                ArtistLookupResult transient = ArtistLookupResult.Transient(ApplyCustomImage(Empty(name)));
                LogDiag(name, "fetch-transient", transient.Status, transient.Profile, timer.ElapsedMilliseconds);
                return transient;
            }
            catch (Exception ex)
            {
                TransientFailures[key] = DateTimeOffset.UtcNow;
                Log($"lookup exception name='{name}' err={ex.GetType().Name}");
                if (TryReadArtistCache(key, out CachedArtist? stale, ignoreExpiry: true) &&
                    stale?.Profile is not null &&
                    HasProfileData(stale.Profile) &&
                    !stale.ConfirmedEmpty)
                {
                    ArtistProfile ready = ApplyCustomImage(WithLocalImageUrl(stale.Profile));
                    if (IsCurrentGeneration(key, generation))
                    {
                        ArtistMemory[key] = ready;
                    }

                    LogDiag(name, "exception-stale", ArtistLookupStatus.Found, ready, timer.ElapsedMilliseconds);
                    return ArtistLookupResult.Found(ready);
                }

                ArtistLookupResult transient = ArtistLookupResult.Transient(ApplyCustomImage(Empty(name)));
                LogDiag(name, "exception-transient", transient.Status, transient.Profile, timer.ElapsedMilliseconds);
                return transient;
            }
            finally
            {
                InFlight.TryRemove(key, out _);
            }
        }

        private static bool IsCurrentGeneration(string key, int generation) =>
            LookupGeneration.GetOrAdd(key, 0) == generation;

        private static void LogDiag(
            string name,
            string stage,
            ArtistLookupStatus status,
            ArtistProfile profile,
            long elapsedMs = -1)
        {
            string ms = elapsedMs >= 0 ? $" ms={elapsedMs}" : "";
            Log(
                $"diag stage={stage} name='{name}' status={status} mbid={profile.MusicBrainzId ?? "-"} "
                + $"qid={profile.WikidataId ?? "-"} genres={profile.Genres.Count} "
                + $"bio={(string.IsNullOrWhiteSpace(profile.Biography) ? "no" : "yes")} "
                + $"image={(profile.Image is null ? "no" : "yes")}{ms}");
        }

        private static async Task<FetchOutcome> FetchArtistProfileAsync(string name)
        {
            string key = Normalize(name);
            string? knownMbid = ResolveKnownMusicBrainzId(key);

            if (!string.IsNullOrWhiteSpace(knownMbid))
            {
                Log($"diag stage=mbid-direct name='{name}' mbid={knownMbid}");
                FetchOutcome direct = await FetchArtistByMbidAsync(name, knownMbid);
                if (direct.Kind == FetchKind.Found)
                {
                    return direct;
                }

                // Stale identity: fall through to search / Wikipedia fallback.
                if (direct.Kind == FetchKind.ConfirmedEmpty)
                {
                    KnownMusicBrainzIds.TryRemove(key, out _);
                    TryDeleteIdentityCache(key);
                }
            }

            SearchOutcome search = await SearchArtistAsync(name);
            if (search.Kind == FetchKind.TransientFailure)
            {
                // Search is frequently shed (HTTP 503) while lookup/Wikipedia still work.
                FetchOutcome wikiFallback = await TryWikipediaIdentityFallbackAsync(name);
                if (wikiFallback.Kind == FetchKind.Found)
                {
                    return wikiFallback;
                }

                LogDiag(name, "search-transient", ArtistLookupStatus.Transient, Empty(name));
                return FetchOutcome.Transient();
            }

            if (search.Kind == FetchKind.ConfirmedEmpty || search.Artist is null)
            {
                return FetchOutcome.Empty();
            }

            string? mbid = ReadString(search.Artist.Value, "id");
            if (string.IsNullOrWhiteSpace(mbid))
            {
                return FetchOutcome.Empty();
            }

            RememberMusicBrainzId(key, mbid);
            return await FetchArtistByMbidAsync(name, mbid);
        }

        private static async Task<FetchOutcome> FetchArtistByMbidAsync(string name, string mbid)
        {
            JsonDocument? lookupDocument = await GetJsonDocumentAsync(
                $"https://musicbrainz.org/ws/2/artist/{Uri.EscapeDataString(mbid)}?inc=url-rels+genres+tags&fmt=json",
                rateLimit: true);
            if (lookupDocument is null)
            {
                // Ambiguous network vs 404: treat as transient so we do not poison identity.
                return FetchOutcome.Transient();
            }

            using (lookupDocument)
            {
                JsonElement artist = lookupDocument.RootElement;
                // Defensive: MB can return an error document without a usable id.
                if (string.IsNullOrWhiteSpace(ReadString(artist, "id")))
                {
                    return FetchOutcome.Empty();
                }

                ArtistProfile profile = await BuildFromMusicBrainzAsync(name, artist, mbid);
                RememberMusicBrainzId(Normalize(name), mbid);

                string? wikidataId = ReadWikidataId(artist);
                if (!string.IsNullOrWhiteSpace(wikidataId))
                {
                    profile = await EnrichFromWikidataAsync(profile, wikidataId);
                }
                else
                {
                    Log($"wikidata omit name='{name}' mbid={mbid} reason=no-url-rel");
                }

                Log(
                    $"profile ready name='{name}' mbid={profile.MusicBrainzId} wikidata={profile.WikidataId ?? "-"} "
                    + $"genres={profile.Genres.Count} bio={(string.IsNullOrWhiteSpace(profile.Biography) ? "no" : "yes")} "
                    + $"image={(profile.Image is null ? "no" : "yes")}");
                return FetchOutcome.Found(profile);
            }
        }

        /// <summary>
        /// When MusicBrainz search is shed, recover via Wikipedia summary → Wikidata (P434 → MBID).
        /// Only used for Transient search failures — never overrides ConfirmedEmpty.
        /// </summary>
        private static async Task<FetchOutcome> TryWikipediaIdentityFallbackAsync(string name)
        {
            WikipediaSummary summary = await FetchWikipediaSummaryDetailsAsync(name);
            if (string.IsNullOrWhiteSpace(summary.Extract)
                || string.IsNullOrWhiteSpace(summary.WikibaseItem)
                || !WikidataIdPattern.IsMatch(summary.WikibaseItem))
            {
                Log($"diag stage=wiki-fallback-miss name='{name}' reason=no-summary-or-qid");
                return FetchOutcome.Transient();
            }

            // Reject obvious title mismatches (disambiguation / wrong person).
            string pageTitle = summary.Title ?? "";
            if (!string.IsNullOrWhiteSpace(pageTitle)
                && !pageTitle.Equals(name, StringComparison.OrdinalIgnoreCase)
                && !pageTitle.StartsWith(name + " (", StringComparison.OrdinalIgnoreCase))
            {
                Log($"diag stage=wiki-fallback-miss name='{name}' title='{pageTitle}' reason=title-mismatch");
                return FetchOutcome.Transient();
            }

            Log($"diag stage=wiki-fallback name='{name}' qid={summary.WikibaseItem}");
            ArtistProfile seed = new()
            {
                Name = name,
                WikidataId = summary.WikibaseItem,
                Biography = summary.Extract,
                WikipediaUrl = summary.Url,
                WikipediaTitle = summary.Title ?? name
            };

            ArtistProfile enriched = await EnrichFromWikidataAsync(seed, summary.WikibaseItem);
            if (!string.IsNullOrWhiteSpace(enriched.MusicBrainzId))
            {
                RememberMusicBrainzId(Normalize(name), enriched.MusicBrainzId);
                // Prefer MB genres/type/area when lookup is healthy (search may still be shed).
                FetchOutcome mb = await FetchArtistByMbidAsync(name, enriched.MusicBrainzId);
                if (mb.Kind == FetchKind.Found && mb.Profile is not null)
                {
                    return mb;
                }
            }

            if (!HasProfileData(enriched))
            {
                return FetchOutcome.Transient();
            }

            Log(
                $"profile ready name='{name}' mbid={enriched.MusicBrainzId ?? "-"} wikidata={enriched.WikidataId ?? "-"} "
                + $"genres={enriched.Genres.Count} bio={(string.IsNullOrWhiteSpace(enriched.Biography) ? "no" : "yes")} "
                + $"image={(enriched.Image is null ? "no" : "yes")} via=wiki-fallback");
            return FetchOutcome.Found(enriched);
        }

        private static async Task<ArtistProfile> BuildFromMusicBrainzAsync(string name, JsonElement artist, string mbid)
        {
            IReadOnlyList<string> genres = ReadGenres(artist, "genres");
            if (genres.Count == 0)
            {
                genres = ReadGenres(artist, "tags");
            }

            string? type = ReadString(artist, "type");
            string? beginAreaId = ReadNestedId(artist, "begin-area");
            string? beginAreaName = ReadNestedName(artist, "begin-area");
            string? countryName = ReadNestedName(artist, "area");
            string? area = await FormatAreaAsync(beginAreaId, beginAreaName, countryName);

            return new ArtistProfile
            {
                Name = name,
                MusicBrainzId = mbid,
                Type = type,
                Genres = genres,
                OriginLabel = OriginLabel(type),
                BeginYear = ReadLifeSpanYear(artist, "begin"),
                EndYear = ReadLifeSpanYear(artist, "end"),
                Area = area
            };
        }

        private static async Task<ArtistProfile> EnrichFromWikidataAsync(ArtistProfile profile, string wikidataId)
        {
            string url =
                $"https://www.wikidata.org/wiki/Special:EntityData/{Uri.EscapeDataString(wikidataId)}.json";
            using JsonDocument? document = await GetJsonDocumentAsync(url, rateLimit: false);
            if (document is null
                || !document.RootElement.TryGetProperty("entities", out JsonElement entities)
                || !entities.TryGetProperty(wikidataId, out JsonElement entity))
            {
                return profile with { WikidataId = wikidataId };
            }

            List<string> genres = profile.Genres.ToList();
            foreach (string genre in ReadWikidataGenres(entity))
            {
                if (genres.Count >= MaxGenres)
                {
                    break;
                }

                if (!genres.Contains(genre, StringComparer.OrdinalIgnoreCase))
                {
                    genres.Add(genre);
                }
            }

            string? beginYear = profile.BeginYear
                ?? YearFromDate(ReadWikidataTime(entity, "P571"))
                ?? YearFromDate(ReadWikidataTime(entity, "P569"));
            string? endYear = profile.EndYear
                ?? YearFromDate(ReadWikidataTime(entity, "P576"))
                ?? YearFromDate(ReadWikidataTime(entity, "P570"));
            string? area = profile.Area ?? ReadWikidataArea(entity);
            string? type = profile.Type ?? ReadWikidataArtistType(entity);

            string? wikipediaTitle = profile.WikipediaTitle ?? ReadWikipediaTitle(entity);
            string? biography = profile.Biography;
            string? wikipediaUrl = profile.WikipediaUrl;
            if (string.IsNullOrWhiteSpace(biography) && !string.IsNullOrWhiteSpace(wikipediaTitle))
            {
                WikipediaSummary summary = await FetchWikipediaSummaryDetailsAsync(wikipediaTitle);
                biography = summary.Extract;
                wikipediaUrl = summary.Url ?? wikipediaUrl;
                if (string.IsNullOrWhiteSpace(biography))
                {
                    Log($"wikipedia omit qid={wikidataId} title='{wikipediaTitle}' reason=empty-extract");
                }
            }
            else if (string.IsNullOrWhiteSpace(wikipediaTitle))
            {
                Log($"wikipedia omit qid={wikidataId} reason=no-enwiki-sitelink");
            }

            string? musicBrainzId = profile.MusicBrainzId ?? ReadWikidataExternalId(entity, "P434");

            // Resolve images under a hard budget so MB/Wikipedia metadata still reaches the UI
            // inside the WebView artist-info timeout (image retry can fill photos later).
            ImageResolveResult imageResult = await ResolveArtistImageWithBudgetAsync(
                entity,
                profile.Name,
                wikidataId,
                type ?? profile.Type,
                wikipediaTitle);
            if (imageResult.Image is null)
            {
                Log(
                    $"image omit qid={wikidataId} reason={(imageResult.Exhausted ? "no-usable-commons-image" : "deadline")}");
            }

            ArtistProfile enriched = profile with
            {
                MusicBrainzId = musicBrainzId,
                WikidataId = wikidataId,
                Type = type,
                Genres = genres.Count > 0 ? genres : profile.Genres,
                OriginLabel = profile.OriginLabel ?? OriginLabel(type),
                BeginYear = beginYear,
                EndYear = endYear,
                Area = area,
                Biography = biography,
                WikipediaUrl = wikipediaUrl,
                WikipediaTitle = wikipediaTitle,
                Image = imageResult.Image ?? profile.Image
            };
            // If the budget expired mid-search, leave ImageResolutionVersion unset on write
            // via this marker so the next open retries image discovery.
            if (!imageResult.Exhausted && imageResult.Image is null)
            {
                enriched = enriched with { ImageResolutionIncomplete = true };
            }

            return enriched;
        }

        private static async Task<ArtistImageInfo?> RetryResolveArtistImageAsync(ArtistProfile profile)
        {
            if (string.IsNullOrWhiteSpace(profile.WikidataId))
            {
                return null;
            }

            string url =
                $"https://www.wikidata.org/wiki/Special:EntityData/{Uri.EscapeDataString(profile.WikidataId)}.json";
            using JsonDocument? document = await GetJsonDocumentAsync(url, rateLimit: false);
            if (document is null
                || !document.RootElement.TryGetProperty("entities", out JsonElement entities)
                || !entities.TryGetProperty(profile.WikidataId, out JsonElement entity))
            {
                return await FetchArtistImageFromCommonsSearchAsync(
                    profile.Name,
                    profile.WikidataId,
                    profile.Type,
                    profile.WikipediaTitle);
            }

            return await ResolveArtistImageAsync(
                entity,
                profile.Name,
                profile.WikidataId,
                profile.Type,
                profile.WikipediaTitle);
        }

        private static async Task<ImageResolveResult> ResolveArtistImageWithBudgetAsync(
            JsonElement entity,
            string artistName,
            string wikidataId,
            string? artistType,
            string? wikipediaTitle)
        {
            Task<ArtistImageInfo?> imageTask = ResolveArtistImageAsync(
                entity,
                artistName,
                wikidataId,
                artistType,
                wikipediaTitle);
            Task winner = await Task.WhenAny(imageTask, Task.Delay(imageResolutionBudget));
            if (winner == imageTask)
            {
                return new ImageResolveResult(await imageTask, Exhausted: true);
            }

            Log($"image deadline qid={wikidataId} budgetMs={(int)imageResolutionBudget.TotalMilliseconds}");
            // Let the abandoned task finish in the background without blocking metadata delivery.
            _ = imageTask.ContinueWith(
                static t => _ = t.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);
            return new ImageResolveResult(null, Exhausted: false);
        }

        private static async Task<ArtistImageInfo?> ResolveArtistImageAsync(
            JsonElement entity,
            string artistName,
            string wikidataId,
            string? artistType,
            string? wikipediaTitle)
        {
            ArtistImageInfo? fromP18 = await FetchArtistImageFromP18Async(entity);
            if (fromP18 is not null)
            {
                Log($"image source=commons-p18 qid={wikidataId}");
                return fromP18;
            }

            ArtistImageInfo? fromSearch = await FetchArtistImageFromCommonsSearchAsync(
                artistName,
                wikidataId,
                artistType,
                wikipediaTitle);
            if (fromSearch is not null)
            {
                return fromSearch;
            }

            return null;
        }

        internal static string WireStatus(ArtistLookupStatus status) => status switch
        {
            ArtistLookupStatus.ConfirmedEmpty => "empty",
            ArtistLookupStatus.Transient => "transient",
            _ => "ok"
        };

        private static async Task<(string? Extract, string? Url)> FetchWikipediaSummaryAsync(string title)
        {
            WikipediaSummary summary = await FetchWikipediaSummaryDetailsAsync(title);
            return (summary.Extract, summary.Url);
        }

        private static async Task<WikipediaSummary> FetchWikipediaSummaryDetailsAsync(string title)
        {
            string url =
                $"https://en.wikipedia.org/api/rest_v1/page/summary/{Uri.EscapeDataString(title.Replace(' ', '_'))}";
            using JsonDocument? document = await GetJsonDocumentAsync(url, rateLimit: false);
            if (document is null)
            {
                return default;
            }

            JsonElement root = document.RootElement;
            string? extract = ReadString(root, "extract");
            string? pageTitle = ReadString(root, "title");
            string? wikibaseItem = ReadString(root, "wikibase_item");
            string? pageUrl = null;
            if (root.TryGetProperty("content_urls", out JsonElement contentUrls)
                && contentUrls.TryGetProperty("desktop", out JsonElement desktop))
            {
                pageUrl = ReadString(desktop, "page");
            }

            pageUrl ??= $"https://en.wikipedia.org/wiki/{Uri.EscapeDataString(title.Replace(' ', '_'))}";
            return new WikipediaSummary(
                string.IsNullOrWhiteSpace(extract) ? null : extract.Trim(),
                pageUrl,
                pageTitle,
                wikibaseItem);
        }

        private static async Task<ArtistImageInfo?> FetchArtistImageFromP18Async(JsonElement entity)
        {
            foreach (string fileName in ReadWikidataCommonsFileNames(entity))
            {
                ArtistImageInfo? image = await LoadCommonsImageFromFileNameAsync(fileName);
                if (image is not null)
                {
                    return image;
                }
            }

            return null;
        }

        private static async Task<ArtistImageInfo?> FetchArtistImageFromCommonsSearchAsync(
            string artistName,
            string wikidataId,
            string? artistType,
            string? wikipediaTitle)
        {
            // Identity-first: files that depict this Wikidata entity.
            ArtistImageInfo? depicts = await TryCommonsDepictsSearchAsync(wikidataId);
            if (depicts is not null)
            {
                Log($"image source=commons-search-depicts qid={wikidataId}");
                return depicts;
            }

            // Verified Commons category for this artist (and a few immediate subcats).
            ArtistImageInfo? fromCategory = await TryCommonsCategorySearchAsync(artistName, wikipediaTitle);
            if (fromCategory is not null)
            {
                Log($"image source=commons-search-category qid={wikidataId}");
                return fromCategory;
            }

            // Title search only when exactly one strong name match survives filters.
            string? title = SelectConfidentCommonsSearchTitle(
                await SearchCommonsFileTitlesAsync(BuildCommonsTitleSearchQuery(artistName, artistType, wikipediaTitle)),
                artistName);
            if (string.IsNullOrWhiteSpace(title))
            {
                Log($"image omit qid={wikidataId} reason=commons-search-no-confident-title");
                return null;
            }

            ArtistImageInfo? fromTitle = await LoadCommonsImageFromFileNameAsync(StripFileNamespace(title));
            if (fromTitle is not null)
            {
                Log($"image source=commons-search-title qid={wikidataId} file='{title}'");
            }

            return fromTitle;
        }

        private static async Task<ArtistImageInfo?> TryCommonsCategorySearchAsync(string artistName, string? wikipediaTitle)
        {
            string? categoryTitle = ResolveCommonsArtistCategoryTitle(artistName, wikipediaTitle);
            if (string.IsNullOrWhiteSpace(categoryTitle))
            {
                return null;
            }

            List<string> categories = [categoryTitle];
            IReadOnlyList<string> subcats = await ListCommonsCategoryMembersAsync(categoryTitle, files: false, subcats: true);
            foreach (string subcat in subcats.Take(MaxCommonsCategorySubcats))
            {
                // Only traverse photograph/member/people style subcategories — not album art dumps.
                if (IsUsefulArtistPhotoSubcategory(subcat, artistName, wikipediaTitle))
                {
                    categories.Add(subcat);
                }
            }

            List<string> files = [];
            foreach (string category in categories)
            {
                foreach (string file in await ListCommonsCategoryMembersAsync(category, files: true, subcats: false))
                {
                    if (IsUnsuitableCommonsTitle(file))
                    {
                        continue;
                    }

                    files.Add(StripFileNamespace(file));
                    if (files.Count >= MaxCommonsCategoryFileAttempts)
                    {
                        break;
                    }
                }

                if (files.Count >= MaxCommonsCategoryFileAttempts)
                {
                    break;
                }
            }

            foreach (string fileName in files.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                ArtistImageInfo? image = await LoadCommonsImageFromFileNameAsync(fileName);
                if (image is not null)
                {
                    return image;
                }
            }

            return null;
        }

        /// <summary>
        /// Commons category keyed to the verified Wikipedia title when present, else artist name.
        /// </summary>
        internal static string? ResolveCommonsArtistCategoryTitle(string artistName, string? wikipediaTitle)
        {
            string primary = !string.IsNullOrWhiteSpace(wikipediaTitle) ? wikipediaTitle.Trim() : artistName.Trim();
            return string.IsNullOrWhiteSpace(primary) ? null : "Category:" + primary;
        }

        internal static bool IsUsefulArtistPhotoSubcategory(string categoryTitle, string artistName, string? wikipediaTitle)
        {
            string name = StripCategoryNamespace(categoryTitle);
            string identity = !string.IsNullOrWhiteSpace(wikipediaTitle) ? wikipediaTitle! : artistName;
            if (name.Contains("album", StringComparison.OrdinalIgnoreCase)
                || name.Contains("cover", StringComparison.OrdinalIgnoreCase)
                || name.Contains("logo", StringComparison.OrdinalIgnoreCase)
                || name.Contains("single", StringComparison.OrdinalIgnoreCase)
                || name.Contains("discograph", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            return name.Contains(identity, StringComparison.OrdinalIgnoreCase)
                || name.Contains("member", StringComparison.OrdinalIgnoreCase)
                || name.Contains("photograph", StringComparison.OrdinalIgnoreCase)
                || name.Contains("concert", StringComparison.OrdinalIgnoreCase)
                || name.Contains("live", StringComparison.OrdinalIgnoreCase);
        }

        private static async Task<IReadOnlyList<string>> ListCommonsCategoryMembersAsync(
            string categoryTitle,
            bool files,
            bool subcats)
        {
            if (string.IsNullOrWhiteSpace(categoryTitle))
            {
                return [];
            }

            string cmtype = files && subcats ? "file|subcat"
                : files ? "file"
                : "subcat";
            string url =
                "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=categorymembers"
                + "&cmtype=" + cmtype
                + "&cmlimit=" + MaxCommonsCategoryFileAttempts
                + "&cmtitle=" + Uri.EscapeDataString(categoryTitle);

            using JsonDocument? document = await GetJsonDocumentAsync(url, rateLimit: false);
            if (document is null
                || !document.RootElement.TryGetProperty("query", out JsonElement query)
                || !query.TryGetProperty("categorymembers", out JsonElement members)
                || members.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            List<string> titles = [];
            foreach (JsonElement member in members.EnumerateArray())
            {
                string? title = ReadString(member, "title");
                int ns = member.TryGetProperty("ns", out JsonElement nsEl) && nsEl.TryGetInt32(out int nsv) ? nsv : -1;
                if (string.IsNullOrWhiteSpace(title))
                {
                    continue;
                }

                if (files && ns == 6)
                {
                    titles.Add(title);
                }
                else if (subcats && ns == 14)
                {
                    titles.Add(title);
                }
            }

            return titles;
        }

        private static string StripCategoryNamespace(string title)
        {
            const string prefix = "Category:";
            return title.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? title[prefix.Length..].Trim()
                : title.Trim();
        }

        private static async Task<ArtistImageInfo?> TryCommonsDepictsSearchAsync(string wikidataId)
        {
            if (!WikidataIdPattern.IsMatch(wikidataId))
            {
                return null;
            }

            IReadOnlyList<string> titles = await SearchCommonsFileTitlesAsync(
                $"haswbstatement:P180={wikidataId}",
                MaxCommonsDepictAttempts);
            List<string> suitable = titles
                .Where(static title => !IsUnsuitableCommonsTitle(title))
                .Select(StripFileNamespace)
                .Where(static name => !string.IsNullOrWhiteSpace(name))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(MaxCommonsDepictAttempts)
                .ToList();

            foreach (string fileName in suitable)
            {
                ArtistImageInfo? image = await LoadCommonsImageFromFileNameAsync(fileName);
                if (image is not null)
                {
                    return image;
                }
            }

            return null;
        }

        private static string BuildCommonsTitleSearchQuery(string artistName, string? artistType, string? wikipediaTitle)
        {
            string primary = string.IsNullOrWhiteSpace(wikipediaTitle) ? artistName.Trim() : wikipediaTitle.Trim();
            string quoted = $"\"{primary.Replace("\"", "", StringComparison.Ordinal)}\"";
            bool group = string.Equals(artistType, "Group", StringComparison.OrdinalIgnoreCase)
                || string.Equals(artistType, "Orchestra", StringComparison.OrdinalIgnoreCase)
                || string.Equals(artistType, "Choir", StringComparison.OrdinalIgnoreCase);
            string hint = group ? "(band OR group OR musician)" : "(musician OR singer OR band OR rapper OR performer)";
            return $"{quoted} {hint}";
        }

        private static async Task<IReadOnlyList<string>> SearchCommonsFileTitlesAsync(string search, int limit = MaxCommonsSearchCandidates)
        {
            if (string.IsNullOrWhiteSpace(search))
            {
                return [];
            }

            string url =
                "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search"
                + "&srnamespace=6"
                + "&srlimit=" + Math.Clamp(limit, 1, MaxCommonsSearchCandidates)
                + "&srsearch=" + Uri.EscapeDataString(search);

            using JsonDocument? document = await GetJsonDocumentAsync(url, rateLimit: false);
            if (document is null
                || !document.RootElement.TryGetProperty("query", out JsonElement query)
                || !query.TryGetProperty("search", out JsonElement results)
                || results.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            List<string> titles = [];
            foreach (JsonElement hit in results.EnumerateArray())
            {
                string? title = ReadString(hit, "title");
                if (!string.IsNullOrWhiteSpace(title))
                {
                    titles.Add(title);
                }
            }

            return titles;
        }

        /// <summary>
        /// Picks a Commons File: title only when identity is unambiguous: unsuitable
        /// titles are dropped, and exactly one strong artist-name match must remain.
        /// </summary>
        internal static string? SelectConfidentCommonsSearchTitle(IEnumerable<string> titles, string artistName)
        {
            List<string> strong = [];
            foreach (string title in titles)
            {
                if (IsUnsuitableCommonsTitle(title))
                {
                    continue;
                }

                if (CommonsTitleHasStrongArtistName(title, artistName))
                {
                    strong.Add(title);
                }
            }

            if (strong.Count == 1)
            {
                return strong[0];
            }

            if (strong.Count > 1)
            {
                Log($"image omit name='{artistName}' reason=commons-search-ambiguous count={strong.Count}");
            }

            return null;
        }

        internal static bool IsUnsuitableCommonsTitle(string? title)
        {
            if (string.IsNullOrWhiteSpace(title))
            {
                return true;
            }

            string normalized = StripFileNamespace(title);
            return UnsuitableCommonsTitle.IsMatch(normalized);
        }

        internal static bool CommonsTitleHasStrongArtistName(string title, string artistName)
        {
            string haystack = NormalizeCommonsTitle(StripFileNamespace(title));
            string needle = NormalizeCommonsTitle(artistName);
            if (string.IsNullOrWhiteSpace(haystack) || string.IsNullOrWhiteSpace(needle))
            {
                return false;
            }

            // Contiguous full-name match after normalizing punctuation/spaces.
            if (haystack.Contains(needle, StringComparison.Ordinal))
            {
                return true;
            }

            // Multi-token names: every token length>1 must appear (order preserved weakly).
            string[] tokens = needle.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .Where(static t => t.Length > 1)
                .ToArray();
            if (tokens.Length < 2)
            {
                return false;
            }

            int index = 0;
            foreach (string token in tokens)
            {
                int found = haystack.IndexOf(token, index, StringComparison.Ordinal);
                if (found < 0)
                {
                    return false;
                }

                index = found + token.Length;
            }

            return true;
        }

        private static string NormalizeCommonsTitle(string value)
        {
            string lower = value.Trim().ToLowerInvariant();
            lower = lower.Replace('_', ' ');
            lower = Regex.Replace(lower, @"[^a-z0-9\s]+", " ");
            return Regex.Replace(lower, @"\s+", " ").Trim();
        }

        private static string StripFileNamespace(string title)
        {
            const string prefix = "File:";
            return title.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? title[prefix.Length..].Trim()
                : title.Trim();
        }

        private static async Task<ArtistImageInfo?> LoadCommonsImageFromFileNameAsync(string fileName)
        {
            if (string.IsNullOrWhiteSpace(fileName) || IsUnsuitableCommonsTitle(fileName))
            {
                return null;
            }

            string metaUrl =
                "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo"
                + "&iiprop=url|size|extmetadata|mime"
                + "&iiurlwidth=1600"
                + "&titles=" + Uri.EscapeDataString("File:" + fileName);

            using JsonDocument? document = await GetJsonDocumentAsync(metaUrl, rateLimit: false);
            if (document is null
                || !document.RootElement.TryGetProperty("query", out JsonElement query)
                || !query.TryGetProperty("pages", out JsonElement pages))
            {
                return null;
            }

            foreach (JsonProperty page in pages.EnumerateObject())
            {
                if (page.Value.TryGetProperty("missing", out _))
                {
                    continue;
                }

                if (!page.Value.TryGetProperty("imageinfo", out JsonElement infos)
                    || infos.ValueKind != JsonValueKind.Array
                    || infos.GetArrayLength() == 0)
                {
                    continue;
                }

                JsonElement info = infos[0];
                int width = info.TryGetProperty("thumbwidth", out JsonElement tw) && tw.TryGetInt32(out int twv)
                    ? twv
                    : info.TryGetProperty("width", out JsonElement w) && w.TryGetInt32(out int wv) ? wv : 0;
                int height = info.TryGetProperty("thumbheight", out JsonElement th) && th.TryGetInt32(out int thv)
                    ? thv
                    : info.TryGetProperty("height", out JsonElement h) && h.TryGetInt32(out int hv) ? hv : 0;

                if (width <= 0 || height <= 0)
                {
                    return null;
                }

                string? thumbUrl = ReadString(info, "thumburl") ?? ReadString(info, "url");
                string? sourceUrl = ReadString(info, "descriptionurl")
                    ?? $"https://commons.wikimedia.org/wiki/File:{Uri.EscapeDataString(fileName.Replace(' ', '_'))}";
                string? mime = ReadString(info, "mime");

                if (!TryReadLicense(info, out string? license, out string? licenseUrl, out string? author, out string? credit)
                    || string.IsNullOrWhiteSpace(license)
                    || string.IsNullOrWhiteSpace(thumbUrl))
                {
                    return null;
                }

                byte[]? bytes = await DownloadBytesAsync(thumbUrl, ArtistImageCache.MaxDownloadBytes);
                if (bytes is null)
                {
                    return null;
                }

                ArtistCachedImage? stored = ArtistImageCache.Store(bytes, mime);
                if (stored is null)
                {
                    return null;
                }

                string attribution = BuildAttribution(author, credit, license, sourceUrl);
                return new ArtistImageInfo
                {
                    Url = stored.Url,
                    FileName = stored.FileName,
                    Attribution = attribution,
                    Author = author,
                    Credit = credit,
                    License = license,
                    LicenseUrl = licenseUrl,
                    SourceUrl = sourceUrl,
                    Presentation = stored.Presentation,
                    Width = stored.Width,
                    Height = stored.Height
                };
            }

            return null;
        }

        internal static bool TryReadLicense(
            JsonElement imageInfo,
            out string? license,
            out string? licenseUrl,
            out string? author,
            out string? credit)
        {
            license = null;
            licenseUrl = null;
            author = null;
            credit = null;

            if (!imageInfo.TryGetProperty("extmetadata", out JsonElement meta)
                || meta.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            license = StripHtml(MetaValue(meta, "LicenseShortName") ?? MetaValue(meta, "License"));
            licenseUrl = MetaValue(meta, "LicenseUrl");
            author = StripHtml(MetaValue(meta, "Artist") ?? MetaValue(meta, "Attribution"));
            credit = StripHtml(MetaValue(meta, "Credit") ?? MetaValue(meta, "Attribution"));

            if (string.IsNullOrWhiteSpace(license) || !IsAllowedLicense(license))
            {
                license = null;
                return false;
            }

            // Require a license URL except for clear public-domain / CC0 markers.
            if (string.IsNullOrWhiteSpace(licenseUrl) && !IsPublicDomainOrCc0(license))
            {
                license = null;
                return false;
            }

            if (string.IsNullOrWhiteSpace(author) && string.IsNullOrWhiteSpace(credit) && !IsPublicDomainOrCc0(license))
            {
                // Attribution licenses require identifiable author/credit text.
                license = null;
                return false;
            }

            return true;
        }

        internal static bool IsAllowedLicense(string? license)
        {
            if (string.IsNullOrWhiteSpace(license))
            {
                return false;
            }

            string normalized = Regex.Replace(license.Trim(), @"\s+", " ");
            if (AllowedLicenseTokens.Contains(normalized))
            {
                return true;
            }

            string compact = normalized.Replace(" ", "", StringComparison.Ordinal).ToLowerInvariant();
            return compact.StartsWith("cc0", StringComparison.Ordinal)
                || compact.StartsWith("cc-by", StringComparison.Ordinal)
                || compact.StartsWith("ccby", StringComparison.Ordinal)
                || compact.Contains("publicdomain", StringComparison.Ordinal)
                || normalized.Contains("CC BY", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("CC-BY", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsPublicDomainOrCc0(string license)
        {
            string compact = Regex.Replace(license, @"\s+", "").ToLowerInvariant();
            return compact.Contains("cc0", StringComparison.Ordinal)
                || compact.Contains("publicdomain", StringComparison.Ordinal)
                || compact is "pd" or "pdm";
        }

        private static string BuildAttribution(string? author, string? credit, string license, string? sourceUrl)
        {
            string who = !string.IsNullOrWhiteSpace(author) ? author!
                : !string.IsNullOrWhiteSpace(credit) ? credit!
                : "Unknown author";
            string source = string.IsNullOrWhiteSpace(sourceUrl) ? "Wikimedia Commons" : sourceUrl!;
            return $"{who} / {license} / {source}";
        }

        private static string? MetaValue(JsonElement meta, string name)
        {
            if (!meta.TryGetProperty(name, out JsonElement node)
                || !node.TryGetProperty("value", out JsonElement value)
                || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            string? text = value.GetString();
            return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
        }

        private static string? StripHtml(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }

            string text = Regex.Replace(value, "<[^>]+>", " ");
            text = WebUtility.HtmlDecode(text);
            text = Regex.Replace(text, @"\s+", " ").Trim();
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }

        private static async Task<byte[]?> DownloadBytesAsync(string url, int maxBytes)
        {
            try
            {
                using HttpRequestMessage request = new(HttpMethod.Get, url);
                using HttpResponseMessage response = await Http.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead);
                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                if (response.Content.Headers.ContentLength is long length && length > maxBytes)
                {
                    return null;
                }

                await using Stream stream = await response.Content.ReadAsStreamAsync();
                using MemoryStream buffer = new();
                byte[] chunk = new byte[8192];
                int read;
                while ((read = await stream.ReadAsync(chunk)) > 0)
                {
                    if (buffer.Length + read > maxBytes)
                    {
                        return null;
                    }

                    buffer.Write(chunk, 0, read);
                }

                return buffer.ToArray();
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Selects a MusicBrainz artist only when identity is unambiguous.
        /// A high score alone is insufficient when multiple plausible artists share the name.
        /// When several exact-name hits exist, prefer a single candidate with clear music evidence
        /// (tags/genres, music disambiguation, IPIs) over clearly non-musical peers.
        /// </summary>
        internal static JsonElement? SelectConfidentArtist(JsonElement artists, string name)
        {
            if (artists.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            List<ArtistCandidate> exact = [];
            foreach (JsonElement candidate in artists.EnumerateArray())
            {
                string? candidateName = ReadString(candidate, "name");
                if (!string.Equals(candidateName, name, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                int score = candidate.TryGetProperty("score", out JsonElement scoreElement) &&
                    scoreElement.TryGetInt32(out int value)
                    ? value
                    : 0;
                exact.Add(CreateCandidate(candidate.Clone(), score));
            }

            if (exact.Count == 0)
            {
                Log($"identity omit name='{name}' reason=no-exact-match");
                return null;
            }

            exact.Sort(static (left, right) => right.Score.CompareTo(left.Score));
            ArtistCandidate top = exact[0];
            if (top.Score < MinExactScore)
            {
                Log($"identity omit name='{name}' reason=low-score score={top.Score}");
                return null;
            }

            if (exact.Count == 1)
            {
                Log($"identity accept name='{name}' mbid={top.Id} reason=single-exact score={top.Score}");
                return top.Artist;
            }

            int secondScore = exact[1].Score;
            if (top.Score >= DominantExactScore && top.Score - secondScore >= DominantScoreGap)
            {
                Log($"identity accept name='{name}' mbid={top.Id} reason=dominant-score score={top.Score} gap={top.Score - secondScore}");
                return top.Artist;
            }

            List<ArtistCandidate> musical = exact.Where(static c => c.HasMusicEvidence).ToList();
            List<ArtistCandidate> nonMusical = exact.Where(static c => c.HasNonMusicEvidence && !c.HasMusicEvidence).ToList();
            if (musical.Count == 1 && (nonMusical.Count == exact.Count - 1 || exact.Count(static c => !c.HasMusicEvidence) == exact.Count - 1))
            {
                ArtistCandidate chosen = musical[0];
                if (chosen.Score >= MinExactScore)
                {
                    Log($"identity accept name='{name}' mbid={chosen.Id} reason=unique-music-evidence score={chosen.Score} disambiguation='{chosen.Disambiguation}'");
                    return chosen.Artist;
                }
            }

            Log($"identity omit name='{name}' reason=ambiguous-exact-matches count={exact.Count} topScore={top.Score} secondScore={secondScore} musical={musical.Count}");
            return null;
        }

        private static ArtistCandidate CreateCandidate(JsonElement artist, int score)
        {
            string? disambiguation = ReadString(artist, "disambiguation");
            bool hasTags = HasNamedCounts(artist, "tags") || HasNamedCounts(artist, "genres");
            bool hasIpi = artist.TryGetProperty("ipis", out JsonElement ipis)
                && ipis.ValueKind == JsonValueKind.Array
                && ipis.GetArrayLength() > 0;
            bool musicHint = HasHint(disambiguation, MusicDisambiguationHints);
            bool nonMusicHint = HasHint(disambiguation, NonMusicDisambiguationHints);
            return new ArtistCandidate(
                Artist: artist,
                Id: ReadString(artist, "id"),
                Score: score,
                Disambiguation: disambiguation,
                HasMusicEvidence: hasTags || hasIpi || musicHint,
                HasNonMusicEvidence: nonMusicHint);
        }

        private static bool HasNamedCounts(JsonElement artist, string propertyName)
        {
            if (!artist.TryGetProperty(propertyName, out JsonElement items) || items.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            foreach (JsonElement item in items.EnumerateArray())
            {
                if (!string.IsNullOrWhiteSpace(ReadString(item, "name")))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool HasHint(string? disambiguation, HashSet<string> hints)
        {
            if (string.IsNullOrWhiteSpace(disambiguation))
            {
                return false;
            }

            foreach (string hint in hints)
            {
                if (disambiguation.Contains(hint, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static void Log(string message)
        {
            Debug.WriteLine($"{LogPrefix} {message}");
        }

        private readonly record struct ArtistCandidate(
            JsonElement Artist,
            string? Id,
            int Score,
            string? Disambiguation,
            bool HasMusicEvidence,
            bool HasNonMusicEvidence);

        private static async Task<SearchOutcome> SearchArtistAsync(string name)
        {
            string query = $"artist:\"{EscapeLucene(name)}\"";
            string url = $"https://musicbrainz.org/ws/2/artist/?query={Uri.EscapeDataString(query)}&fmt=json&limit=8";
            JsonDocument? document = await GetJsonDocumentAsync(url, rateLimit: true);
            if (document is null)
            {
                return SearchOutcome.Transient();
            }

            using (document)
            {
                if (!document.RootElement.TryGetProperty("artists", out JsonElement artists)
                    || artists.ValueKind != JsonValueKind.Array)
                {
                    return SearchOutcome.Empty();
                }

                JsonElement? selected = SelectConfidentArtist(artists, name);
                return selected is null
                    ? SearchOutcome.Empty()
                    : SearchOutcome.Found(selected.Value);
            }
        }

        private static string? ReadWikidataId(JsonElement artist)
        {
            if (!artist.TryGetProperty("relations", out JsonElement relations)
                || relations.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            foreach (JsonElement relation in relations.EnumerateArray())
            {
                string? type = ReadString(relation, "type");
                if (!string.Equals(type, "wikidata", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string? url = null;
                if (relation.TryGetProperty("url", out JsonElement urlNode))
                {
                    url = ReadString(urlNode, "resource") ?? ReadString(urlNode, "id");
                }

                url ??= ReadString(relation, "target");
                if (string.IsNullOrWhiteSpace(url))
                {
                    continue;
                }

                int index = url.LastIndexOf('/');
                string id = index >= 0 ? url[(index + 1)..] : url;
                if (WikidataIdPattern.IsMatch(id))
                {
                    return id.ToUpperInvariant();
                }
            }

            return null;
        }

        private static IReadOnlyList<string> ReadWikidataGenres(JsonElement entity)
        {
            List<string> genres = [];
            foreach (string? id in ReadClaimItemIds(entity, "P136"))
            {
                // Prefer labels from entity sitelinks are not available here; use id labels via entity terms if present.
                _ = id;
            }

            // Labels for referenced genres are not expanded without another round-trip; keep MB genres primary.
            return genres;
        }

        private static string? ReadWikidataArtistType(JsonElement entity)
        {
            foreach (string id in ReadClaimItemIds(entity, "P31"))
            {
                if (id is "Q5")
                {
                    return "Person";
                }

                if (id is "Q215380" or "Q5741069" or "Q1458061" or "Q32178211")
                {
                    return "Group";
                }
            }

            return null;
        }

        private static string? ReadWikidataArea(JsonElement entity)
        {
            // Formation location / place of birth labels require entity labels; skip unlabeled QIDs.
            return null;
        }

        /// <summary>External-id claims such as MusicBrainz artist ID (P434).</summary>
        private static string? ReadWikidataExternalId(JsonElement entity, string property)
        {
            if (!TryGetClaims(entity, property, out JsonElement claims))
            {
                return null;
            }

            foreach (JsonElement claim in claims.EnumerateArray())
            {
                if (!claim.TryGetProperty("mainsnak", out JsonElement snak)
                    || !snak.TryGetProperty("datavalue", out JsonElement dataValue)
                    || !dataValue.TryGetProperty("value", out JsonElement value)
                    || value.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                string? id = value.GetString();
                if (!string.IsNullOrWhiteSpace(id))
                {
                    return id.Trim();
                }
            }

            return null;
        }

        private static string? ReadWikidataTime(JsonElement entity, string property)
        {
            if (!TryGetClaims(entity, property, out JsonElement claims))
            {
                return null;
            }

            foreach (JsonElement claim in claims.EnumerateArray())
            {
                if (!claim.TryGetProperty("mainsnak", out JsonElement snak)
                    || !snak.TryGetProperty("datavalue", out JsonElement dataValue)
                    || !dataValue.TryGetProperty("value", out JsonElement value))
                {
                    continue;
                }

                string? time = ReadString(value, "time");
                if (!string.IsNullOrWhiteSpace(time))
                {
                    // Wikidata times look like +2001-01-01T00:00:00Z
                    string trimmed = time.TrimStart('+');
                    return trimmed.Length >= 4 ? trimmed[..4] : null;
                }
            }

            return null;
        }

        private static string? ReadWikipediaTitle(JsonElement entity)
        {
            if (!entity.TryGetProperty("sitelinks", out JsonElement sitelinks)
                || !sitelinks.TryGetProperty("enwiki", out JsonElement enwiki))
            {
                return null;
            }

            return ReadString(enwiki, "title");
        }

        private static string? ReadWikidataCommonsFileName(JsonElement entity)
        {
            foreach (string fileName in ReadWikidataCommonsFileNames(entity))
            {
                return fileName;
            }

            return null;
        }

        private static IEnumerable<string> ReadWikidataCommonsFileNames(JsonElement entity)
        {
            if (!TryGetClaims(entity, "P18", out JsonElement claims))
            {
                yield break;
            }

            foreach (JsonElement claim in claims.EnumerateArray())
            {
                if (!claim.TryGetProperty("mainsnak", out JsonElement snak)
                    || !snak.TryGetProperty("datavalue", out JsonElement dataValue)
                    || !dataValue.TryGetProperty("value", out JsonElement value)
                    || value.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                string? fileName = value.GetString();
                if (!string.IsNullOrWhiteSpace(fileName))
                {
                    yield return fileName.Trim();
                }
            }
        }

        private static IEnumerable<string> ReadClaimItemIds(JsonElement entity, string property)
        {
            if (!TryGetClaims(entity, property, out JsonElement claims))
            {
                yield break;
            }

            foreach (JsonElement claim in claims.EnumerateArray())
            {
                if (!claim.TryGetProperty("mainsnak", out JsonElement snak)
                    || !snak.TryGetProperty("datavalue", out JsonElement dataValue)
                    || !dataValue.TryGetProperty("value", out JsonElement value)
                    || !value.TryGetProperty("id", out JsonElement idNode)
                    || idNode.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                string? id = idNode.GetString();
                if (!string.IsNullOrWhiteSpace(id))
                {
                    yield return id;
                }
            }
        }

        private static bool TryGetClaims(JsonElement entity, string property, out JsonElement claims)
        {
            claims = default;
            return entity.TryGetProperty("claims", out JsonElement all)
                && all.TryGetProperty(property, out claims)
                && claims.ValueKind == JsonValueKind.Array;
        }

        private static async Task<string?> FormatAreaAsync(string? beginAreaId, string? beginAreaName, string? countryName)
        {
            List<string> parts = [];
            HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);

            if (!string.IsNullOrWhiteSpace(beginAreaName) && seen.Add(beginAreaName))
            {
                parts.Add(beginAreaName);
            }

            string? id = beginAreaId;
            for (int hop = 0; hop < 8 && !string.IsNullOrWhiteSpace(id); hop++)
            {
                AreaRecord? area = await GetAreaAsync(id);
                if (area is null)
                {
                    break;
                }

                bool include = hop == 0
                    || string.Equals(area.Type, "City", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(area.Type, "District", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(area.Type, "Municipality", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(area.Type, "Subdivision", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(area.Type, "Country", StringComparison.OrdinalIgnoreCase);

                if (string.Equals(area.Type, "County", StringComparison.OrdinalIgnoreCase) ||
                    IsCountyName(area.Name))
                {
                    include = false;
                }

                if (include && !string.IsNullOrWhiteSpace(area.Name) && seen.Add(area.Name))
                {
                    parts.Add(area.Name);
                }

                if (string.Equals(area.Type, "Country", StringComparison.OrdinalIgnoreCase) ||
                    (string.Equals(area.Type, "Subdivision", StringComparison.OrdinalIgnoreCase) &&
                     !string.IsNullOrWhiteSpace(countryName)))
                {
                    break;
                }

                id = area.ParentId;
            }

            if (!string.IsNullOrWhiteSpace(countryName) && seen.Add(countryName))
            {
                parts.Add(countryName);
            }

            return parts.Count == 0 ? null : string.Join(", ", parts);
        }

        private static async Task<AreaRecord?> GetAreaAsync(string mbid)
        {
            if (AreaMemory.TryGetValue(mbid, out AreaRecord? cached))
            {
                return cached;
            }

            if (TryReadAreaCache(mbid, out AreaRecord? fromDisk) && fromDisk is not null)
            {
                AreaMemory[mbid] = fromDisk;
                return fromDisk;
            }

            using JsonDocument? document = await GetJsonDocumentAsync(
                $"https://musicbrainz.org/ws/2/area/{Uri.EscapeDataString(mbid)}?inc=area-rels&fmt=json",
                rateLimit: true);
            if (document is null)
            {
                return null;
            }

            JsonElement root = document.RootElement;
            AreaRecord record = new()
            {
                Id = mbid,
                Name = ReadString(root, "name") ?? "",
                Type = ReadString(root, "type"),
                ParentId = ReadParentAreaId(root)
            };

            AreaMemory[mbid] = record;
            WriteAreaCache(mbid, record);
            return record;
        }

        private static string? ReadParentAreaId(JsonElement area)
        {
            if (!area.TryGetProperty("relations", out JsonElement relations) ||
                relations.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            foreach (JsonElement relation in relations.EnumerateArray())
            {
                if (!string.Equals(ReadString(relation, "type"), "part of", StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(ReadString(relation, "direction"), "backward", StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(ReadString(relation, "target-type"), "area", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (relation.TryGetProperty("area", out JsonElement parent))
                {
                    return ReadString(parent, "id");
                }
            }

            return null;
        }

        private static IReadOnlyList<string> ReadGenres(JsonElement artist, string propertyName)
        {
            if (!artist.TryGetProperty(propertyName, out JsonElement items) ||
                items.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            return items.EnumerateArray()
                .Select(item => new
                {
                    Name = ReadString(item, "name"),
                    Count = item.TryGetProperty("count", out JsonElement countElement) &&
                        countElement.TryGetInt32(out int count)
                        ? count
                        : 0
                })
                .Where(item => !string.IsNullOrWhiteSpace(item.Name) &&
                    item.Count > 0 &&
                    !GenericGenres.Contains(item.Name))
                .OrderByDescending(item => item.Count)
                .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
                .Select(item => TitleCaseGenre(item.Name!))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(MaxGenres)
                .ToList();
        }

        private static string? ReadLifeSpanYear(JsonElement artist, string field)
        {
            if (!artist.TryGetProperty("life-span", out JsonElement lifeSpan))
            {
                return null;
            }

            return YearFromDate(ReadString(lifeSpan, field));
        }

        private static string? YearFromDate(string? value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length < 4)
            {
                return null;
            }

            string year = value[..4];
            return year.All(char.IsDigit) ? year : null;
        }

        private static string OriginLabel(string? type)
        {
            return string.Equals(type, "Person", StringComparison.OrdinalIgnoreCase)
                ? "Born"
                : "Formed";
        }

        private static string TitleCaseGenre(string value)
        {
            return string.Join(' ', value.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .Select(static word => string.Join('-', word.Split('-')
                    .Select(static part => part.Length switch
                    {
                        0 => part,
                        1 => part.ToUpperInvariant(),
                        _ => char.ToUpperInvariant(part[0]) + part[1..].ToLowerInvariant()
                    }))));
        }

        internal static bool HasProfileData(ArtistProfile profile)
        {
            return profile.Genres.Count > 0
                || !string.IsNullOrWhiteSpace(profile.BeginYear)
                || !string.IsNullOrWhiteSpace(profile.Area)
                || !string.IsNullOrWhiteSpace(profile.Type)
                || !string.IsNullOrWhiteSpace(profile.Biography)
                || !string.IsNullOrWhiteSpace(profile.MusicBrainzId)
                || profile.Image is not null;
        }

        private static bool IsCountyName(string value) =>
            value.Contains("County", StringComparison.OrdinalIgnoreCase);

        private static string? ReadString(JsonElement element, string name)
        {
            return element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }

        private static string? ReadNestedId(JsonElement element, string name)
        {
            return element.TryGetProperty(name, out JsonElement nested) && nested.ValueKind == JsonValueKind.Object
                ? ReadString(nested, "id")
                : null;
        }

        private static string? ReadNestedName(JsonElement element, string name)
        {
            return element.TryGetProperty(name, out JsonElement nested) && nested.ValueKind == JsonValueKind.Object
                ? ReadString(nested, "name")
                : null;
        }

        private static async Task<JsonDocument?> GetJsonDocumentAsync(string url, bool rateLimit)
        {
            if (!rateLimit)
            {
                return await SendJsonAsync(url);
            }

            TimeSpan backoff = TimeSpan.FromSeconds(2);
            for (int attempt = 0; attempt < 2; attempt++)
            {
                JsonDocument? document = null;
                bool retry = false;
                bool transient = false;
                await RequestGate.WaitAsync();
                try
                {
                    TimeSpan wait = nextRequestAt - DateTimeOffset.UtcNow;
                    if (wait > TimeSpan.Zero)
                    {
                        await Task.Delay(wait);
                    }

                    using HttpRequestMessage request = new(HttpMethod.Get, url);
                    using HttpResponseMessage response = await Http.SendAsync(request);
                    nextRequestAt = DateTimeOffset.UtcNow + MinRequestSpacing;
                    int status = (int)response.StatusCode;

                    if (response.IsSuccessStatusCode)
                    {
                        string json = await response.Content.ReadAsStringAsync();
                        document = JsonDocument.Parse(json);
                        Log($"http ok status={status} url={TruncateUrl(url)}");
                    }
                    else if (response.StatusCode is HttpStatusCode.ServiceUnavailable or HttpStatusCode.TooManyRequests)
                    {
                        retry = attempt == 0;
                        transient = true;
                        backoff = ReadRetryAfter(response) ?? backoff;
                        Log($"http throttle status={status} retryAfterMs={(int)backoff.TotalMilliseconds} url={TruncateUrl(url)}");
                    }
                    else if (status >= 500)
                    {
                        transient = true;
                        Log($"http error status={status} url={TruncateUrl(url)}");
                    }
                    else
                    {
                        Log($"http reject status={status} url={TruncateUrl(url)}");
                    }
                }
                catch (Exception ex)
                {
                    nextRequestAt = DateTimeOffset.UtcNow + MinRequestSpacing;
                    retry = attempt == 0;
                    transient = true;
                    Log($"http exception err={ex.GetType().Name} url={TruncateUrl(url)}");
                }
                finally
                {
                    RequestGate.Release();
                }

                if (document is not null)
                {
                    return document;
                }

                if (!retry)
                {
                    // Propagate transient vs confirmed via null; callers treat MB search null as transient.
                    // Non-retryable 4xx (except handled above) also yield null — search treats as transient
                    // to avoid negative-caching ambiguous transport failures. Confirmed empty comes from
                    // successful JSON with no confident match.
                    _ = transient;
                    return null;
                }

                // Bounded single retry; prefer Retry-After when present (capped).
                await Task.Delay(backoff);
            }

            return null;
        }

        private static TimeSpan? ReadRetryAfter(HttpResponseMessage response)
        {
            try
            {
                if (response.Headers.RetryAfter?.Delta is TimeSpan delta && delta > TimeSpan.Zero)
                {
                    return delta <= MaxRetryAfter ? delta : MaxRetryAfter;
                }

                if (response.Headers.RetryAfter?.Date is DateTimeOffset date)
                {
                    TimeSpan until = date - DateTimeOffset.UtcNow;
                    if (until <= TimeSpan.Zero)
                    {
                        return null;
                    }

                    return until <= MaxRetryAfter ? until : MaxRetryAfter;
                }
            }
            catch (Exception)
            {
                // Ignore malformed Retry-After.
            }

            return null;
        }

        private static string TruncateUrl(string url) =>
            url.Length <= 120 ? url : url[..117] + "...";

        private static async Task<JsonDocument?> SendJsonAsync(string url)
        {
            try
            {
                using HttpRequestMessage request = new(HttpMethod.Get, url);
                using HttpResponseMessage response = await Http.SendAsync(request);
                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                string json = await response.Content.ReadAsStringAsync();
                return JsonDocument.Parse(json);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static ArtistProfile WithLocalImageUrl(ArtistProfile profile)
        {
            if (profile.Image is null || string.IsNullOrWhiteSpace(profile.Image.FileName))
            {
                return profile;
            }

            if (!ArtistImageCache.TryResolveExistingFile(profile.Image.FileName, out _))
            {
                // Cached metadata remains; drop broken image reference for the UI.
                return profile with { Image = null };
            }

            string version = Path.GetFileNameWithoutExtension(profile.Image.FileName);
            if (version.Length > 16)
            {
                version = version[..16];
            }

            string url = ArtistImageCache.BuildUrl(profile.Image.FileName, version);
            return profile.Image.Url == url
                ? profile
                : profile with { Image = profile.Image with { Url = url } };
        }

        private static bool TryReadArtistCache(string key, out CachedArtist? cached, bool ignoreExpiry = false)
        {
            cached = null;
            string path = ArtistCachePath(key);
            if (!File.Exists(path))
            {
                return false;
            }

            try
            {
                CachedArtist? entry = JsonSerializer.Deserialize<CachedArtist>(File.ReadAllText(path), JsonOptions);
                if (entry is null || entry.SchemaVersion != SchemaVersion)
                {
                    return false;
                }

                TimeSpan age = DateTimeOffset.UtcNow - entry.CachedAt;
                if (!ignoreExpiry)
                {
                    if (entry.ConfirmedEmpty && age > NegativeCacheLifetime)
                    {
                        return false;
                    }

                    if (!entry.ConfirmedEmpty && age > ArtistCacheLifetime)
                    {
                        return false;
                    }
                }

                if (!entry.ConfirmedEmpty && (entry.Profile is null || !HasProfileData(entry.Profile)))
                {
                    return false;
                }

                cached = entry;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void WriteArtistCache(
            string key,
            ArtistProfile profile,
            bool confirmedEmpty,
            int imageResolutionVersion = ImageResolutionVersion)
        {
            try
            {
                string path = ArtistCachePath(key);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                CachedArtist cached = new()
                {
                    SchemaVersion = SchemaVersion,
                    ImageResolutionVersion = imageResolutionVersion,
                    Profile = confirmedEmpty ? null : profile,
                    ConfirmedEmpty = confirmedEmpty,
                    CachedAt = DateTimeOffset.UtcNow
                };
                AtomicWriteText(path, JsonSerializer.Serialize(cached, JsonOptions));
            }
            catch (Exception)
            {
                // Cache writes are best-effort.
            }
        }

        private static bool TryReadAreaCache(string mbid, out AreaRecord? area)
        {
            area = null;
            string path = AreaCachePath(mbid);
            if (!File.Exists(path))
            {
                return false;
            }

            try
            {
                CachedArea? cached = JsonSerializer.Deserialize<CachedArea>(File.ReadAllText(path), JsonOptions);
                if (cached?.Area is null || DateTimeOffset.UtcNow - cached.CachedAt > AreaCacheLifetime)
                {
                    return false;
                }

                area = cached.Area;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void WriteAreaCache(string mbid, AreaRecord area)
        {
            try
            {
                string path = AreaCachePath(mbid);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                CachedArea cached = new() { Area = area, CachedAt = DateTimeOffset.UtcNow };
                AtomicWriteText(path, JsonSerializer.Serialize(cached, JsonOptions));
            }
            catch (Exception)
            {
                // Cache writes are best-effort.
            }
        }

        private static void AtomicWriteText(string path, string contents)
        {
            string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temp, contents);
                File.Move(temp, path, overwrite: true);
            }
            catch
            {
                try
                {
                    if (File.Exists(temp))
                    {
                        File.Delete(temp);
                    }
                }
                catch (Exception)
                {
                    // Best-effort.
                }

                throw;
            }
        }

        private static string ArtistCachePath(string key) => Path.Combine(CacheRoot, "artists", $"{key}.json");

        private static string IdentityCachePath(string key) => Path.Combine(CacheRoot, "identities", $"{key}.json");

        private static string AreaCachePath(string mbid) => Path.Combine(CacheRoot, "areas", $"{mbid}.json");

        private static string Normalize(string name) =>
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(name.Trim().ToLowerInvariant())))[..16];

        private static void RememberMusicBrainzId(string key, string mbid)
        {
            if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(mbid))
            {
                return;
            }

            KnownMusicBrainzIds[key] = mbid.Trim();
            try
            {
                string path = IdentityCachePath(key);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                AtomicWriteText(
                    path,
                    JsonSerializer.Serialize(new CachedIdentity { MusicBrainzId = mbid.Trim() }, JsonOptions));
            }
            catch (Exception)
            {
                // Best-effort.
            }
        }

        private static string? ResolveKnownMusicBrainzId(string key)
        {
            if (KnownMusicBrainzIds.TryGetValue(key, out string? memory)
                && !string.IsNullOrWhiteSpace(memory))
            {
                return memory;
            }

            return TryReadIdentityCache(key);
        }

        private static string? TryReadIdentityCache(string key)
        {
            string path = IdentityCachePath(key);
            if (!File.Exists(path))
            {
                return null;
            }

            try
            {
                CachedIdentity? cached = JsonSerializer.Deserialize<CachedIdentity>(File.ReadAllText(path), JsonOptions);
                if (string.IsNullOrWhiteSpace(cached?.MusicBrainzId))
                {
                    return null;
                }

                KnownMusicBrainzIds[key] = cached.MusicBrainzId;
                return cached.MusicBrainzId;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void TryDeleteIdentityCache(string key)
        {
            KnownMusicBrainzIds.TryRemove(key, out _);
            try
            {
                string path = IdentityCachePath(key);
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception)
            {
                // Best-effort.
            }
        }

        private static string EscapeLucene(string value)
        {
            StringBuilder builder = new(value.Length);
            foreach (char character in value)
            {
                if (character is '+' or '-' or '!' or '(' or ')' or '{' or '}' or '[' or ']'
                    or '^' or '"' or '~' or '*' or '?' or ':' or '\\' or '/')
                {
                    builder.Append('\\');
                }

                builder.Append(character);
            }

            return builder.ToString();
        }

        private static ArtistProfile Empty(string name) => new() { Name = name };

        private static HttpClient CreateHttpClient()
        {
            HttpClient client = new(new SocketsHttpHandler
            {
                PooledConnectionLifetime = TimeSpan.FromMinutes(10),
                AutomaticDecompression = DecompressionMethods.All
            })
            {
                Timeout = TimeSpan.FromSeconds(20)
            };
            string agent = $"EMP/{ApplicationVersion()} ({ProjectUrl})";
            client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", agent);
            client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");
            return client;
        }

        private static string ApplicationVersion()
        {
            return Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";
        }

        internal sealed record ArtistProfile
        {
            public required string Name { get; init; }

            public string? MusicBrainzId { get; init; }

            public string? WikidataId { get; init; }

            public string? Type { get; init; }

            public IReadOnlyList<string> Genres { get; init; } = [];

            public string? OriginLabel { get; init; }

            public string? BeginYear { get; init; }

            public string? EndYear { get; init; }

            public string? Area { get; init; }

            public string? Biography { get; init; }

            public string? WikipediaUrl { get; init; }

            public string? WikipediaTitle { get; init; }

            public ArtistImageInfo? Image { get; init; }

            /// <summary>
            /// True when image search was cut short by the delivery budget. Not serialized to disk;
            /// used only to leave ImageResolutionVersion at 0 so the next open retries photos.
            /// </summary>
            [JsonIgnore]
            public bool ImageResolutionIncomplete { get; init; }
        }

        private readonly record struct ImageResolveResult(ArtistImageInfo? Image, bool Exhausted);

        internal sealed record ArtistImageInfo
        {
            public string? Url { get; init; }

            public string? FileName { get; init; }

            public string? Attribution { get; init; }

            public string? Author { get; init; }

            public string? Credit { get; init; }

            public string? License { get; init; }

            public string? LicenseUrl { get; init; }

            public string? SourceUrl { get; init; }

            public string? Presentation { get; init; }

            public int Width { get; init; }

            public int Height { get; init; }

            public bool IsCustom { get; init; }
        }

        /// <summary>Overlays a user-selected artist photo when one is configured.</summary>
        internal static ArtistProfile ApplyCustomImage(ArtistProfile profile)
        {
            if (ArtistCustomImageStore.TryGet(profile.Name, out ArtistImageInfo custom))
            {
                return profile with { Image = custom };
            }

            return profile;
        }

        /// <summary>Drops in-memory profile so the next request re-applies custom image state.</summary>
        internal static void InvalidateMemory(string name)
        {
            ArtistMemory.TryRemove(Normalize(name), out _);
        }

        private sealed class AreaRecord
        {
            public required string Id { get; init; }

            public required string Name { get; init; }

            public string? Type { get; init; }

            public string? ParentId { get; init; }
        }

        private sealed class CachedArtist
        {
            public int SchemaVersion { get; init; }

            /// <summary>0 when absent in older cache files — triggers image-only retry when below current.</summary>
            public int ImageResolutionVersion { get; init; }

            public ArtistProfile? Profile { get; init; }

            public bool ConfirmedEmpty { get; init; }

            public DateTimeOffset CachedAt { get; init; }
        }

        private sealed class CachedArea
        {
            public required AreaRecord Area { get; init; }

            public DateTimeOffset CachedAt { get; init; }
        }

        private sealed class CachedIdentity
        {
            public string? MusicBrainzId { get; init; }
        }

        private readonly record struct WikipediaSummary(
            string? Extract,
            string? Url,
            string? Title,
            string? WikibaseItem);

        private enum FetchKind
        {
            Found,
            ConfirmedEmpty,
            TransientFailure
        }

        internal enum ArtistLookupStatus
        {
            Found,
            ConfirmedEmpty,
            Transient
        }

        internal readonly record struct ArtistLookupResult(ArtistLookupStatus Status, ArtistProfile Profile)
        {
            public static ArtistLookupResult Found(ArtistProfile profile) =>
                new(ArtistLookupStatus.Found, profile);

            public static ArtistLookupResult ConfirmedEmpty(ArtistProfile profile) =>
                new(ArtistLookupStatus.ConfirmedEmpty, profile);

            public static ArtistLookupResult Transient(ArtistProfile profile) =>
                new(ArtistLookupStatus.Transient, profile);
        }

        private readonly record struct FetchOutcome(FetchKind Kind, ArtistProfile? Profile)
        {
            public static FetchOutcome Found(ArtistProfile profile) => new(FetchKind.Found, profile);

            public static FetchOutcome Empty() => new(FetchKind.ConfirmedEmpty, null);

            public static FetchOutcome Transient() => new(FetchKind.TransientFailure, null);
        }

        private readonly record struct SearchOutcome(FetchKind Kind, JsonElement? Artist)
        {
            public static SearchOutcome Found(JsonElement artist) => new(FetchKind.Found, artist);

            public static SearchOutcome Empty() => new(FetchKind.ConfirmedEmpty, null);

            public static SearchOutcome Transient() => new(FetchKind.TransientFailure, null);
        }
    }
}
