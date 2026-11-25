namespace EMP.Library
{
    /// <summary>A release's primary type (album, single, ep, broadcast, other) plus secondary types.</summary>
    internal readonly record struct ReleaseClassification(string? Primary, IReadOnlyList<string> Secondary)
    {
        public static ReleaseClassification Unknown { get; } = new(null, []);
    }

    /// <summary>
    /// Reads MusicBrainz release-type tags (as written by Picard and similar taggers) and normalizes them.
    /// Never infers a type from track counts: missing, unsupported or conflicting values mean unknown.
    /// </summary>
    internal static class ReleaseTypeTags
    {
        /// <summary>MusicBrainz primary release-group types.</summary>
        internal static readonly IReadOnlyList<string> PrimaryTypes = ["album", "single", "ep", "broadcast", "other"];

        /// <summary>MusicBrainz secondary release-group types, keyed by their normalized tag spelling.</summary>
        private static readonly Dictionary<string, string> SecondaryTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            ["compilation"] = "compilation",
            ["soundtrack"] = "soundtrack",
            ["spokenword"] = "spokenword",
            ["spoken word"] = "spokenword",
            ["interview"] = "interview",
            ["audiobook"] = "audiobook",
            ["audio drama"] = "audio-drama",
            ["audio-drama"] = "audio-drama",
            ["live"] = "live",
            ["remix"] = "remix",
            ["dj-mix"] = "dj-mix",
            ["mixtape/street"] = "mixtape",
            ["mixtape"] = "mixtape",
            ["demo"] = "demo",
            ["field recording"] = "field-recording"
        };

        // Vorbis/FLAC/Opus (Picard: RELEASETYPE; older taggers: MUSICBRAINZ_ALBUMTYPE) and APEv2.
        private static readonly string[] FieldNames = ["RELEASETYPE", "MUSICBRAINZ_ALBUMTYPE"];

        /// <summary>
        /// Raw release-type values from every tag format the file carries. TagLib's generic
        /// <c>MusicBrainzReleaseType</c> covers ID3v2 TXXX "MusicBrainz Album Type" and the MP4
        /// iTunes atom; Xiph and APE fields are read directly because taggers use two field names.
        /// </summary>
        public static IReadOnlyList<string> Read(TagLib.File file)
        {
            List<string> values = [];
            try
            {
                AddValue(values, file.Tag.MusicBrainzReleaseType);

                if (file.GetTag(TagLib.TagTypes.Xiph) is TagLib.Ogg.XiphComment xiph)
                {
                    foreach (string field in FieldNames)
                    {
                        foreach (string value in xiph.GetField(field) ?? [])
                        {
                            AddValue(values, value);
                        }
                    }
                }

                if (file.GetTag(TagLib.TagTypes.Ape) is TagLib.Ape.Tag ape)
                {
                    foreach (string field in FieldNames)
                    {
                        foreach (string value in ape.GetItem(field)?.ToStringArray() ?? [])
                        {
                            AddValue(values, value);
                        }
                    }
                }

                if (file.GetTag(TagLib.TagTypes.Id3v2) is TagLib.Id3v2.Tag id3)
                {
                    TagLib.Id3v2.UserTextInformationFrame? frame =
                        TagLib.Id3v2.UserTextInformationFrame.Get(id3, "MusicBrainz Album Type", false);
                    foreach (string value in frame?.Text ?? [])
                    {
                        AddValue(values, value);
                    }
                }
            }
            catch (Exception)
            {
                // Release type is optional metadata; unreadable tags mean unknown.
            }

            return values;
        }

        private static void AddValue(List<string> values, string? value)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                values.Add(value);
            }
        }

        /// <summary>
        /// Normalizes one file's raw values. Values may be multi-valued in one string
        /// ("album; compilation", null-separated, comma-separated). Exactly one primary type is
        /// required; two different primaries conflict and yield an unknown primary.
        /// </summary>
        public static ReleaseClassification Normalize(IEnumerable<string?> rawValues)
        {
            HashSet<string> primaries = new(StringComparer.Ordinal);
            List<string> secondary = [];
            foreach (string? raw in rawValues ?? [])
            {
                if (string.IsNullOrWhiteSpace(raw))
                {
                    continue;
                }

                // "/" is not a separator: MusicBrainz's own "mixtape/street" contains it.
                foreach (string part in raw.Split([';', ',', '\0'], StringSplitOptions.RemoveEmptyEntries))
                {
                    string token = part.Trim().ToLowerInvariant();
                    if (token.Length == 0)
                    {
                        continue;
                    }

                    if (PrimaryTypes.Contains(token))
                    {
                        primaries.Add(token);
                    }
                    else if (SecondaryTypes.TryGetValue(token, out string? normalized) && !secondary.Contains(normalized))
                    {
                        secondary.Add(normalized);
                    }
                }
            }

            string? primary = primaries.Count == 1 ? primaries.First() : null;
            return new ReleaseClassification(primary, secondary);
        }

        /// <summary>
        /// Album-level classification from its tracks. Tracks without a primary type are ignored;
        /// the remaining tracks must agree, otherwise the release is unknown. Secondary types are
        /// kept only from agreeing tracks.
        /// </summary>
        public static ReleaseClassification Combine(IEnumerable<ReleaseClassification> tracks)
        {
            List<ReleaseClassification> typed = (tracks ?? []).Where(item => item.Primary is not null).ToList();
            if (typed.Count == 0)
            {
                return ReleaseClassification.Unknown;
            }

            string primary = typed[0].Primary!;
            if (typed.Any(item => !string.Equals(item.Primary, primary, StringComparison.Ordinal)))
            {
                return ReleaseClassification.Unknown;
            }

            List<string> secondary = [];
            foreach (string type in typed.SelectMany(item => item.Secondary))
            {
                if (!secondary.Contains(type))
                {
                    secondary.Add(type);
                }
            }

            return new ReleaseClassification(primary, secondary);
        }
    }
}
