using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.Library
{
    internal static class MusicBrainzClient
    {
        private const int MaxGenres = 2;
        private static readonly TimeSpan ArtistCacheLifetime = TimeSpan.FromDays(30);
        private static readonly TimeSpan AreaCacheLifetime = TimeSpan.FromDays(90);
        private static readonly TimeSpan FailureCooldown = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan MinRequestSpacing = TimeSpan.FromMilliseconds(1100);
        private static readonly HashSet<string> GenericGenres = new(StringComparer.OrdinalIgnoreCase)
        {
            "music", "rock music", "popular music", "contemporary music"
        };

        private static readonly HttpClient Http = CreateHttpClient();
        private static readonly SemaphoreSlim RequestGate = new(1, 1);
        private static readonly ConcurrentDictionary<string, Task<ArtistProfile>> InFlight = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, ArtistProfile> ArtistMemory = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, DateTimeOffset> RecentFailures = new(StringComparer.OrdinalIgnoreCase);
        private static readonly ConcurrentDictionary<string, AreaRecord> AreaMemory = new(StringComparer.OrdinalIgnoreCase);
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        private static DateTimeOffset nextRequestAt = DateTimeOffset.MinValue;

        public static Task<ArtistProfile> GetArtistProfileAsync(string name)
        {
            string key = Normalize(name);
            if (ArtistMemory.TryGetValue(key, out ArtistProfile? cached) && HasProfileData(cached))
            {
                return Task.FromResult(cached);
            }

            if (RecentFailures.TryGetValue(key, out DateTimeOffset failedAt) &&
                DateTimeOffset.UtcNow - failedAt < FailureCooldown)
            {
                return Task.FromResult(Empty(name));
            }

            return InFlight.GetOrAdd(key, static (_, requestedName) => LoadArtistAsync(requestedName), name);
        }

        private static async Task<ArtistProfile> LoadArtistAsync(string name)
        {
            string key = Normalize(name);
            try
            {
                if (TryReadArtistCache(key, out ArtistProfile? cached) && cached is not null)
                {
                    ArtistMemory[key] = cached;
                    return cached;
                }

                ArtistProfile profile = await FetchArtistProfileAsync(name);
                if (HasProfileData(profile))
                {
                    ArtistMemory[key] = profile;
                    WriteArtistCache(key, profile);
                    RecentFailures.TryRemove(key, out _);
                    return profile;
                }

                RecentFailures[key] = DateTimeOffset.UtcNow;
                return profile;
            }
            catch (Exception)
            {
                if (TryReadArtistCache(key, out ArtistProfile? stale, ignoreExpiry: true) &&
                    stale is not null &&
                    HasProfileData(stale))
                {
                    ArtistMemory[key] = stale;
                    return stale;
                }

                RecentFailures[key] = DateTimeOffset.UtcNow;
                return Empty(name);
            }
            finally
            {
                InFlight.TryRemove(key, out _);
            }
        }

        private static async Task<ArtistProfile> FetchArtistProfileAsync(string name)
        {
            Task<ArtistProfile?> musicBrainzTask = FetchFromMusicBrainzAsync(name);
            Task<ArtistProfile?> wikidataTask = FetchFromWikidataAsync(name);

            ArtistProfile? musicBrainz = await musicBrainzTask;
            if (musicBrainz is not null && HasProfileData(musicBrainz))
            {
                return musicBrainz;
            }

            ArtistProfile? wikidata = await wikidataTask;
            if (wikidata is not null && HasProfileData(wikidata))
            {
                return wikidata;
            }

            return musicBrainz ?? Empty(name);
        }

        private static async Task<ArtistProfile?> FetchFromMusicBrainzAsync(string name)
        {
            JsonElement? match = await SearchArtistAsync(name);
            if (match is null)
            {
                return null;
            }

            JsonElement artist = match.Value;
            IReadOnlyList<string> genres = ReadGenres(artist, "tags");

            string? mbid = ReadString(artist, "id");
            if (genres.Count == 0 && !string.IsNullOrWhiteSpace(mbid))
            {
                JsonElement? lookup = await LookupArtistAsync(mbid);
                if (lookup is not null)
                {
                    artist = lookup.Value;
                    genres = ReadGenres(artist, "genres");
                    if (genres.Count == 0)
                    {
                        genres = ReadGenres(artist, "tags");
                    }
                }
            }

            string? beginAreaId = ReadNestedId(artist, "begin-area");
            string? beginAreaName = ReadNestedName(artist, "begin-area");
            string? countryName = ReadNestedName(artist, "area");
            string? area = await FormatAreaAsync(beginAreaId, beginAreaName, countryName);

            return new ArtistProfile
            {
                Name = name,
                Genres = genres,
                OriginLabel = OriginLabel(ReadString(artist, "type")),
                BeginYear = ReadBeginYear(artist),
                Area = area
            };
        }

        private static async Task<ArtistProfile?> FetchFromWikidataAsync(string name)
        {
            string escaped = EscapeSparql(name.Trim());
            string sparql = $$"""
                SELECT ?instance ?genreLabel ?formed ?born ?placeLabel ?adminLabel ?stateLabel ?countryLabel WHERE {
                  ?item rdfs:label ?label.
                  FILTER(LANG(?label) = "en")
                  FILTER(LCASE(?label) = LCASE("{{escaped}}"))
                  OPTIONAL { ?item wdt:P31 ?instance. }
                  OPTIONAL { ?item wdt:P136 ?genre. }
                  OPTIONAL { ?item wdt:P571 ?formed. }
                  OPTIONAL { ?item wdt:P569 ?born. }
                  OPTIONAL { ?item wdt:P740 ?formedPlace. }
                  OPTIONAL { ?item wdt:P19 ?bornPlace. }
                  BIND(COALESCE(?formedPlace, ?bornPlace) AS ?place)
                  OPTIONAL { ?place wdt:P131 ?admin. }
                  OPTIONAL { ?admin wdt:P131 ?state. }
                  OPTIONAL { ?place wdt:P17 ?country. }
                  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
                }
                LIMIT 30
                """;

            string url = "https://query.wikidata.org/sparql?format=json&query=" + Uri.EscapeDataString(sparql);
            using JsonDocument? document = await GetJsonAsync(url, rateLimit: false);
            if (document is null ||
                !document.RootElement.TryGetProperty("results", out JsonElement results) ||
                !results.TryGetProperty("bindings", out JsonElement bindings) ||
                bindings.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            List<string> genres = [];
            bool person = false;
            string? formed = null;
            string? born = null;
            string? place = null;
            string? admin = null;
            string? state = null;
            string? country = null;

            foreach (JsonElement row in bindings.EnumerateArray())
            {
                string? instance = SparqlValue(row, "instance");
                if (instance is not null && instance.EndsWith("/Q5", StringComparison.Ordinal))
                {
                    person = true;
                }

                string? genre = SparqlValue(row, "genreLabel");
                if (!string.IsNullOrWhiteSpace(genre) &&
                    !GenericGenres.Contains(genre) &&
                    !genres.Contains(genre, StringComparer.OrdinalIgnoreCase))
                {
                    genres.Add(genre);
                }

                formed ??= SparqlValue(row, "formed");
                born ??= SparqlValue(row, "born");
                place ??= SparqlValue(row, "placeLabel");
                admin ??= SparqlValue(row, "adminLabel");
                state ??= SparqlValue(row, "stateLabel");
                country ??= SparqlValue(row, "countryLabel");
            }

            if (genres.Count == 0 && formed is null && born is null && place is null)
            {
                return null;
            }

            List<string> areaParts = [];
            HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);
            foreach (string? part in new[] { place, admin, state, country })
            {
                if (string.IsNullOrWhiteSpace(part) || IsCountyName(part) || !seen.Add(part))
                {
                    continue;
                }

                areaParts.Add(part);
            }

            return new ArtistProfile
            {
                Name = name,
                Genres = genres.Take(MaxGenres).Select(TitleCaseGenre).ToList(),
                OriginLabel = person || (formed is null && born is not null) ? "Born" : "Formed",
                BeginYear = YearFromDate(formed) ?? YearFromDate(born),
                Area = areaParts.Count == 0 ? null : string.Join(", ", areaParts)
            };
        }

        private static async Task<JsonElement?> SearchArtistAsync(string name)
        {
            string query = $"artist:\"{EscapeLucene(name)}\"";
            string url = $"https://musicbrainz.org/ws/2/artist/?query={Uri.EscapeDataString(query)}&fmt=json&limit=5";
            using JsonDocument? document = await GetJsonAsync(url);
            if (document is null ||
                !document.RootElement.TryGetProperty("artists", out JsonElement artists) ||
                artists.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            JsonElement? exact = null;
            int exactScore = int.MinValue;
            JsonElement? best = null;
            int bestScore = int.MinValue;

            foreach (JsonElement candidate in artists.EnumerateArray())
            {
                int score = candidate.TryGetProperty("score", out JsonElement scoreElement) &&
                    scoreElement.TryGetInt32(out int value)
                    ? value
                    : 0;
                string? candidateName = ReadString(candidate, "name");
                if (string.Equals(candidateName, name, StringComparison.OrdinalIgnoreCase) && score >= exactScore)
                {
                    exact = candidate.Clone();
                    exactScore = score;
                }

                if (score >= bestScore)
                {
                    best = candidate.Clone();
                    bestScore = score;
                }
            }

            return exact ?? best;
        }

        private static async Task<JsonElement?> LookupArtistAsync(string mbid)
        {
            string url = $"https://musicbrainz.org/ws/2/artist/{Uri.EscapeDataString(mbid)}?inc=genres+tags&fmt=json";
            using JsonDocument? document = await GetJsonAsync(url);
            return document?.RootElement.Clone();
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

            string url = $"https://musicbrainz.org/ws/2/area/{Uri.EscapeDataString(mbid)}?inc=area-rels&fmt=json";
            using JsonDocument? document = await GetJsonAsync(url);
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

        private static string? ReadBeginYear(JsonElement artist)
        {
            if (!artist.TryGetProperty("life-span", out JsonElement lifeSpan))
            {
                return null;
            }

            return YearFromDate(ReadString(lifeSpan, "begin"));
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

        private static bool HasProfileData(ArtistProfile profile)
        {
            return profile.Genres.Count > 0 ||
                !string.IsNullOrWhiteSpace(profile.BeginYear) ||
                !string.IsNullOrWhiteSpace(profile.Area);
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

        private static string? SparqlValue(JsonElement row, string name)
        {
            if (!row.TryGetProperty(name, out JsonElement binding) ||
                !binding.TryGetProperty("value", out JsonElement value) ||
                value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            string? text = value.GetString();
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }

        private static async Task<JsonDocument?> GetJsonAsync(string url, bool rateLimit = true)
        {
            if (!rateLimit)
            {
                return await SendJsonAsync(url);
            }

            for (int attempt = 0; attempt < 2; attempt++)
            {
                JsonDocument? document = null;
                bool retry = false;
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

                    if (response.IsSuccessStatusCode)
                    {
                        string json = await response.Content.ReadAsStringAsync();
                        document = JsonDocument.Parse(json);
                    }
                    else if (response.StatusCode is HttpStatusCode.ServiceUnavailable or HttpStatusCode.TooManyRequests)
                    {
                        retry = attempt == 0;
                    }
                }
                catch (Exception)
                {
                    nextRequestAt = DateTimeOffset.UtcNow + MinRequestSpacing;
                    retry = attempt == 0;
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
                    return null;
                }

                await Task.Delay(TimeSpan.FromSeconds(2));
            }

            return null;
        }

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

        private static bool TryReadArtistCache(string key, out ArtistProfile? profile, bool ignoreExpiry = false)
        {
            profile = null;
            string path = ArtistCachePath(key);
            if (!File.Exists(path))
            {
                return false;
            }

            try
            {
                CachedArtist? cached = JsonSerializer.Deserialize<CachedArtist>(File.ReadAllText(path), JsonOptions);
                if (cached?.Profile is null || !HasProfileData(cached.Profile))
                {
                    return false;
                }

                if (!ignoreExpiry && DateTimeOffset.UtcNow - cached.CachedAt > ArtistCacheLifetime)
                {
                    return false;
                }

                profile = cached.Profile;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void WriteArtistCache(string key, ArtistProfile profile)
        {
            try
            {
                string path = ArtistCachePath(key);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                CachedArtist cached = new() { Profile = profile, CachedAt = DateTimeOffset.UtcNow };
                File.WriteAllText(path, JsonSerializer.Serialize(cached, JsonOptions));
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
                File.WriteAllText(path, JsonSerializer.Serialize(cached, JsonOptions));
            }
            catch (Exception)
            {
                // Cache writes are best-effort.
            }
        }

        private static string ArtistCachePath(string key) => Path.Combine(CacheRoot, "artists", $"{key}.json");

        private static string AreaCachePath(string mbid) => Path.Combine(CacheRoot, "areas", $"{mbid}.json");

        private static string CacheRoot => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "MusicBrainz");

        private static string Normalize(string name) =>
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(name.Trim().ToLowerInvariant())))[..16];

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

        private static string EscapeSparql(string value) =>
            value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);

        private static ArtistProfile Empty(string name) => new() { Name = name };

        private static HttpClient CreateHttpClient()
        {
            HttpClient client = new()
            {
                Timeout = TimeSpan.FromSeconds(20)
            };
            client.DefaultRequestHeaders.TryAddWithoutValidation(
                "User-Agent",
                "EMP-MusicPlayer/1.0.0 ( https://musicbrainz.org/doc/MusicBrainz_API )");
            client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");
            return client;
        }

        internal sealed record ArtistProfile
        {
            public required string Name { get; init; }

            public IReadOnlyList<string> Genres { get; init; } = [];

            public string? OriginLabel { get; init; }

            public string? BeginYear { get; init; }

            public string? Area { get; init; }
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
            public required ArtistProfile Profile { get; init; }

            public DateTimeOffset CachedAt { get; init; }
        }

        private sealed class CachedArea
        {
            public required AreaRecord Area { get; init; }

            public DateTimeOffset CachedAt { get; init; }
        }
    }
}
