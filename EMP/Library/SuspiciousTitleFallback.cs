using System.Text.RegularExpressions;

namespace EMP.Library
{
    /// <summary>
    /// Conservative display-title correction when embedded titles look like artist/album
    /// placeholders shared across a logical album, while numbered filenames carry real titles.
    /// Does not rewrite files; title-only; path-based track IDs are unaffected.
    /// </summary>
    internal static class SuspiciousTitleFallback
    {
        private static readonly Regex GenericFilenameTitle = new(
            @"^(track|audio|song|untitled|unknown)([\s_\-]*\d+)?$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

        internal readonly record struct Candidate(
            string? EmbeddedTitle,
            string FilenameTitle,
            int FilenameTrackNumber,
            string Artist,
            string Album);

        public static string Normalize(string? value)
        {
            return string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        }

        public static bool EqualsNormalized(string? left, string? right)
        {
            return string.Equals(Normalize(left), Normalize(right), StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsMeaningfulFilenameTitle(string filenameTitle, int filenameTrackNumber)
        {
            if (filenameTrackNumber <= 0)
            {
                return false;
            }

            string title = Normalize(filenameTitle);
            if (title.Length == 0)
            {
                return false;
            }

            if (title.All(char.IsDigit))
            {
                return false;
            }

            return !GenericFilenameTitle.IsMatch(title);
        }

        public static bool ShouldPreferFilenameTitle(
            Candidate track,
            IReadOnlyList<Candidate> albumDirectoryTracks)
        {
            ArgumentNullException.ThrowIfNull(albumDirectoryTracks);

            string embedded = Normalize(track.EmbeddedTitle);
            if (embedded.Length == 0)
            {
                return false;
            }

            if (!EqualsNormalized(embedded, track.Artist)
                && !EqualsNormalized(embedded, track.Album))
            {
                return false;
            }

            if (!IsMeaningfulFilenameTitle(track.FilenameTitle, track.FilenameTrackNumber))
            {
                return false;
            }

            if (EqualsNormalized(track.FilenameTitle, embedded))
            {
                return false;
            }

            // Same directory group is supplied by the caller; further scope to the same
            // album tag so unrelated dumps in one folder do not share a cluster.
            int clusterCount = 0;
            HashSet<string> distinctMeaningfulFilenames = new(StringComparer.OrdinalIgnoreCase);

            foreach (Candidate peer in albumDirectoryTracks)
            {
                if (!EqualsNormalized(peer.Album, track.Album))
                {
                    continue;
                }

                if (!EqualsNormalized(peer.EmbeddedTitle, embedded))
                {
                    continue;
                }

                clusterCount++;
                if (IsMeaningfulFilenameTitle(peer.FilenameTitle, peer.FilenameTrackNumber))
                {
                    distinctMeaningfulFilenames.Add(Normalize(peer.FilenameTitle));
                }
            }

            return clusterCount >= 2 && distinctMeaningfulFilenames.Count >= 2;
        }

        /// <summary>
        /// Resolves display titles for one album-directory group. Cluster statistics use only
        /// the original embedded titles; decisions are computed before any title is assigned.
        /// </summary>
        public static IReadOnlyList<string> ResolveTitles(IReadOnlyList<Candidate> albumDirectoryTracks)
        {
            ArgumentNullException.ThrowIfNull(albumDirectoryTracks);

            int count = albumDirectoryTracks.Count;
            bool[] preferFilename = new bool[count];
            for (int i = 0; i < count; i++)
            {
                preferFilename[i] = ShouldPreferFilenameTitle(
                    albumDirectoryTracks[i],
                    albumDirectoryTracks);
            }

            string[] resolved = new string[count];
            for (int i = 0; i < count; i++)
            {
                Candidate track = albumDirectoryTracks[i];
                if (preferFilename[i])
                {
                    resolved[i] = Normalize(track.FilenameTitle);
                    continue;
                }

                string embedded = Normalize(track.EmbeddedTitle);
                resolved[i] = embedded.Length > 0
                    ? embedded
                    : Normalize(track.FilenameTitle);
            }

            return resolved;
        }
    }
}
