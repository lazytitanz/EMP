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
            return HasParseableSyncedLyrics(record.SyncedLyrics)
                || !string.IsNullOrWhiteSpace(record.PlainLyrics)
                || record.Instrumental;
        }

        /// <summary>
        /// True when <paramref name="text"/> contains at least one LRC timestamp with lyric text,
        /// matching the frontend parser's minimum useful synchronized payload.
        /// </summary>
        public static bool HasParseableSyncedLyrics(string? text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return false;
            }

            foreach (string raw in text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
            {
                string rest = raw.Trim();
                if (!rest.StartsWith('[') || !TryConsumeTimeTags(ref rest, out bool anyTime) || !anyTime)
                {
                    continue;
                }

                string lyric = StripWordTimestamps(rest).Trim();
                if (lyric.Length > 0)
                {
                    return true;
                }
            }

            return false;
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

        public static LrclibRecord? SelectBestMatch(
            LyricsLookup lookup,
            IEnumerable<LrclibRecord> records,
            bool requireSynced = false)
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
                bool synced = HasParseableSyncedLyrics(record.SyncedLyrics);
                if (requireSynced)
                {
                    if (!synced)
                    {
                        continue;
                    }
                }
                else if (!IsUsable(record))
                {
                    continue;
                }

                if (!ArtistNames(record.ArtistName).Overlaps(localArtists))
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

        private static bool TryConsumeTimeTags(ref string rest, out bool anyTime)
        {
            anyTime = false;
            while (rest.Length > 0 && rest[0] == '[')
            {
                int close = rest.IndexOf(']');
                if (close <= 1)
                {
                    return anyTime;
                }

                string tag = rest[1..close];
                rest = rest[(close + 1)..].TrimStart();
                if (!IsLrcTimeTag(tag))
                {
                    // Metadata such as [ar:] / [offset:] — not a lyric time tag.
                    return anyTime;
                }

                anyTime = true;
            }

            return true;
        }

        private static bool IsLrcTimeTag(string tag)
        {
            // mm:ss, mm:ss.xx, or mm:ss:xx
            int colon = tag.IndexOf(':');
            if (colon <= 0 || colon >= tag.Length - 1)
            {
                return false;
            }

            if (!int.TryParse(tag[..colon], NumberStyles.None, CultureInfo.InvariantCulture, out int minutes)
                || minutes < 0
                || minutes > 999)
            {
                return false;
            }

            string secondsPart = tag[(colon + 1)..];
            int separator = secondsPart.IndexOfAny(['.', ':']);
            string whole = separator < 0 ? secondsPart : secondsPart[..separator];
            if (!int.TryParse(whole, NumberStyles.None, CultureInfo.InvariantCulture, out int seconds)
                || seconds is < 0 or >= 60)
            {
                return false;
            }

            if (separator < 0)
            {
                return true;
            }

            string fraction = secondsPart[(separator + 1)..];
            return fraction.Length is >= 1 and <= 3
                && int.TryParse(fraction, NumberStyles.None, CultureInfo.InvariantCulture, out _);
        }

        private static string StripWordTimestamps(string text)
        {
            // Enhanced LRC word timestamps like <00:01.00>
            Span<char> buffer = text.Length <= 512 ? stackalloc char[text.Length] : new char[text.Length];
            int length = 0;
            for (int i = 0; i < text.Length; i++)
            {
                if (text[i] == '<')
                {
                    int close = text.IndexOf('>', i + 1);
                    if (close > i)
                    {
                        string inner = text[(i + 1)..close];
                        if (IsLrcTimeTag(inner))
                        {
                            i = close;
                            continue;
                        }
                    }
                }

                buffer[length++] = text[i];
            }

            return new string(buffer[..length]).Replace("  ", " ", StringComparison.Ordinal);
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
