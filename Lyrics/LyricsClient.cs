using System.Globalization;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace EMP.Lyrics
{
    internal sealed class LyricsClient : IDisposable
    {
        private const string BaseUrl = "https://lrclib.net/api/";
        private const string ProjectUrl = "https://github.com/lazytitanz/EMP";
        private const double MaxDurationDifferenceSeconds = 8;

        private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

        // Words that mark a different recording of the same song.
        private static readonly HashSet<string> VersionWords = new(StringComparer.Ordinal)
        {
            "live", "acoustic", "remix", "instrumental", "karaoke", "demo", "edit"
        };

        // Words that mark a bracketed or dashed suffix as release metadata rather than part of the name.
        private static readonly HashSet<string> QualifierWords = new(StringComparer.Ordinal)
        {
            "live", "acoustic", "remix", "instrumental", "karaoke", "demo", "edit", "remaster", "remastered",
            "version", "mix", "mono", "stereo", "single", "radio", "deluxe", "bonus", "edition", "expanded",
            "anniversary", "feat", "ft", "featuring", "explicit", "clean", "unplugged", "session", "take"
        };

        private static readonly string[] ArtistSeparators =
        [
            ",", ";", "/", "&", " x ", " feat. ", " feat ", " ft. ", " ft ", " featuring ", " with ", " and "
        ];

        private readonly HttpClient http;

        public LyricsClient()
        {
            http = new HttpClient(new SocketsHttpHandler
            {
                PooledConnectionLifetime = TimeSpan.FromMinutes(10),
                AutomaticDecompression = DecompressionMethods.All
            })
            {
                Timeout = TimeSpan.FromSeconds(15)
            };

            string agent = $"EMP/{ApplicationVersion()} ({ProjectUrl})";
            http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", agent);
            http.DefaultRequestHeaders.TryAddWithoutValidation("Lrclib-Client", agent);
            http.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");
        }

        public static bool CanUseExactLookup(LyricsLookup lookup)
        {
            return lookup.Duration > 0
                && !string.IsNullOrWhiteSpace(lookup.Album)
                && !string.Equals(lookup.Album.Trim(), "Unknown Album", StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsUsable(LrclibRecord record)
        {
            return !string.IsNullOrWhiteSpace(record.SyncedLyrics)
                || !string.IsNullOrWhiteSpace(record.PlainLyrics)
                || record.Instrumental;
        }

        /// <summary>
        /// Returns null when LRCLIB has no record for the exact signature. Throws on network or server failures.
        /// </summary>
        public async Task<LrclibRecord?> GetAsync(LyricsLookup lookup, CancellationToken cancellationToken)
        {
            string url = BaseUrl + "get" + Query(
                ("track_name", lookup.Title),
                ("artist_name", lookup.Artist),
                ("album_name", lookup.Album),
                ("duration", Math.Round(lookup.Duration).ToString(CultureInfo.InvariantCulture)));

            using HttpResponseMessage response = await http
                .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                return null;
            }

            response.EnsureSuccessStatusCode();
            await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            return await JsonSerializer
                .DeserializeAsync<LrclibRecord>(stream, JsonOptions, cancellationToken)
                .ConfigureAwait(false);
        }

        /// <summary>
        /// Throws on network or server failures.
        /// </summary>
        public async Task<IReadOnlyList<LrclibRecord>> SearchAsync(LyricsLookup lookup, CancellationToken cancellationToken)
        {
            string url = BaseUrl + "search" + Query(
                ("track_name", lookup.Title),
                ("artist_name", lookup.Artist));

            using HttpResponseMessage response = await http
                .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            List<LrclibRecord>? records = await JsonSerializer
                .DeserializeAsync<List<LrclibRecord>>(stream, JsonOptions, cancellationToken)
                .ConfigureAwait(false);
            return records ?? [];
        }

        public static LrclibRecord? SelectBestMatch(LyricsLookup lookup, IEnumerable<LrclibRecord> records)
        {
            (string localTitle, HashSet<string> localVersion) = SplitTitle(lookup.Title);
            if (localTitle.Length == 0)
            {
                return null;
            }

            HashSet<string> localArtists = ArtistNames(lookup.Artist);
            string localAlbum = SplitTitle(lookup.Album).Core;
            bool knownDuration = lookup.Duration > 0;

            LrclibRecord? best = null;
            int bestAlbumScore = -1;
            double bestDifference = double.MaxValue;
            bool bestSynced = false;

            foreach (LrclibRecord record in records)
            {
                if (!IsUsable(record) || !ArtistNames(record.ArtistName).Overlaps(localArtists))
                {
                    continue;
                }

                (string title, HashSet<string> version) = SplitTitle(record.TrackName);
                if (!string.Equals(title, localTitle, StringComparison.Ordinal) || !version.SetEquals(localVersion))
                {
                    continue;
                }

                double difference = 0;
                if (knownDuration)
                {
                    if (record.Duration is not double duration || duration <= 0)
                    {
                        continue;
                    }

                    difference = Math.Abs(duration - lookup.Duration);
                    if (difference > MaxDurationDifferenceSeconds)
                    {
                        continue;
                    }
                }
                else if (!string.Equals(record.TrackName?.Trim(), lookup.Title.Trim(), StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(record.ArtistName?.Trim(), lookup.Artist.Trim(), StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                int albumScore = AlbumScore(localAlbum, SplitTitle(record.AlbumName).Core);
                bool synced = !string.IsNullOrWhiteSpace(record.SyncedLyrics);
                bool better = best is null
                    || albumScore > bestAlbumScore
                    || (albumScore == bestAlbumScore && difference < bestDifference)
                    || (albumScore == bestAlbumScore && difference == bestDifference && synced && !bestSynced);
                if (better)
                {
                    best = record;
                    bestAlbumScore = albumScore;
                    bestDifference = difference;
                    bestSynced = synced;
                }
            }

            return best;
        }

        public void Dispose()
        {
            http.Dispose();
        }

        private static int AlbumScore(string local, string candidate)
        {
            if (local.Length == 0 || candidate.Length == 0)
            {
                return 0;
            }

            if (string.Equals(local, candidate, StringComparison.Ordinal))
            {
                return 2;
            }

            return local.Contains(candidate, StringComparison.Ordinal) || candidate.Contains(local, StringComparison.Ordinal)
                ? 1
                : 0;
        }

        /// <summary>
        /// Splits a title into its normalized core name and the version words found in
        /// bracketed or dashed qualifiers, so "Song (Live)" and "Live Forever" are told apart.
        /// </summary>
        private static (string Core, HashSet<string> Version) SplitTitle(string? value)
        {
            HashSet<string> version = new(StringComparer.Ordinal);
            if (string.IsNullOrWhiteSpace(value))
            {
                return (string.Empty, version);
            }

            StringBuilder core = new(value.Length);
            int depth = 0;
            StringBuilder segment = new();
            foreach (char character in value)
            {
                if (character is '(' or '[' or '{')
                {
                    if (depth == 0)
                    {
                        segment.Clear();
                    }
                    else
                    {
                        segment.Append(character);
                    }

                    depth++;
                    continue;
                }

                if (character is ')' or ']' or '}' && depth > 0)
                {
                    depth--;
                    if (depth == 0)
                    {
                        AbsorbSegment(segment.ToString(), core, version);
                    }
                    else
                    {
                        segment.Append(character);
                    }

                    continue;
                }

                if (depth > 0)
                {
                    segment.Append(character);
                }
                else
                {
                    core.Append(character);
                }
            }

            if (depth > 0)
            {
                core.Append(' ').Append(segment);
            }

            string text = core.ToString();
            int dash = text.IndexOf(" - ", StringComparison.Ordinal);
            if (dash > 0)
            {
                string suffix = text[(dash + 3)..];
                if (Words(suffix).Any(QualifierWords.Contains))
                {
                    CollectVersionWords(suffix, version);
                    text = text[..dash];
                }
            }

            text = StripFeaturing(text);
            return (Normalize(text), version);
        }

        private static void AbsorbSegment(string segment, StringBuilder core, HashSet<string> version)
        {
            if (Words(segment).Any(QualifierWords.Contains))
            {
                CollectVersionWords(segment, version);
                return;
            }

            // Bracketed text that isn't release metadata is part of the name, e.g. "(Don't Fear) The Reaper".
            core.Append(' ').Append(segment).Append(' ');
        }

        private static void CollectVersionWords(string text, HashSet<string> version)
        {
            foreach (string word in Words(text))
            {
                if (VersionWords.Contains(word))
                {
                    version.Add(word);
                }
            }
        }

        private static string StripFeaturing(string text)
        {
            string lower = text.ToLowerInvariant();
            foreach (string marker in new[] { " feat. ", " feat ", " ft. ", " ft ", " featuring " })
            {
                int index = lower.IndexOf(marker, StringComparison.Ordinal);
                if (index > 0)
                {
                    return text[..index];
                }
            }

            return text;
        }

        private static HashSet<string> ArtistNames(string? value)
        {
            HashSet<string> names = new(StringComparer.Ordinal);
            if (string.IsNullOrWhiteSpace(value))
            {
                return names;
            }

            string whole = Normalize(value);
            if (whole.Length > 0)
            {
                names.Add(StripLeadingThe(whole));
            }

            string[] parts = [value.ToLowerInvariant()];
            foreach (string separator in ArtistSeparators)
            {
                parts = parts
                    .SelectMany(part => part.Split(separator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    .ToArray();
            }

            foreach (string part in parts)
            {
                string name = Normalize(part);
                if (name.Length > 0)
                {
                    names.Add(StripLeadingThe(name));
                }
            }

            return names;
        }

        private static string StripLeadingThe(string value) =>
            value.StartsWith("the ", StringComparison.Ordinal) && value.Length > 4 ? value[4..] : value;

        private static IEnumerable<string> Words(string text) =>
            Normalize(text).Split(' ', StringSplitOptions.RemoveEmptyEntries);

        private static string Normalize(string value)
        {
            string decomposed = value.Replace("&", " and ", StringComparison.Ordinal).Normalize(NormalizationForm.FormD);
            StringBuilder builder = new(decomposed.Length);
            bool space = false;
            foreach (char character in decomposed)
            {
                UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(character);
                if (category == UnicodeCategory.NonSpacingMark)
                {
                    continue;
                }

                if (char.IsLetterOrDigit(character))
                {
                    builder.Append(char.ToLowerInvariant(character));
                    space = false;
                }
                else if (character is '\'' or '\u2019')
                {
                    // Drop apostrophes so "Don't" and "Dont" compare equal.
                }
                else if (!space && builder.Length > 0)
                {
                    builder.Append(' ');
                    space = true;
                }
            }

            return builder.ToString().Trim();
        }

        private static string Query(params (string Name, string Value)[] parts)
        {
            return "?" + string.Join("&", parts.Select(part => $"{part.Name}={Uri.EscapeDataString(part.Value)}"));
        }

        private static string ApplicationVersion()
        {
            Assembly assembly = Assembly.GetEntryAssembly() ?? typeof(LyricsClient).Assembly;
            string? informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            if (!string.IsNullOrWhiteSpace(informational))
            {
                int metadata = informational.IndexOf('+', StringComparison.Ordinal);
                return metadata > 0 ? informational[..metadata] : informational;
            }

            return assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        }
    }
}
