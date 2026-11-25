namespace EMP.Lyrics
{
    /// <summary>
    /// Lyrics the user already has on disk, preferred over LRCLIB: a sidecar <c>.lrc</c> next to the
    /// song (same base name), then lyrics embedded in the file's tags. Read-only; never throws.
    /// Not cached: both reads are local and cheap, and edits to the files should show immediately.
    /// </summary>
    internal static class LocalLyricsReader
    {
        /// <summary>Sidecar files larger than this are not lyrics; skip them rather than read them.</summary>
        internal const long MaxSidecarBytes = 512 * 1024;

        public static LyricsResult? TryRead(string? audioPath)
        {
            if (string.IsNullOrWhiteSpace(audioPath))
            {
                return null;
            }

            LyricsResult? sidecar = TryReadSidecar(audioPath);
            if (sidecar is not null)
            {
                return sidecar;
            }

            return TryReadEmbedded(audioPath);
        }

        internal static LyricsResult? TryReadSidecar(string audioPath)
        {
            try
            {
                string? path = FindSidecar(audioPath);
                if (path is null)
                {
                    return null;
                }

                FileInfo info = new(path);
                if (info.Length <= 0 || info.Length > MaxSidecarBytes)
                {
                    return null;
                }

                return FromText(File.ReadAllText(path), LyricsSource.LocalFile, Path.GetFileName(path));
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static LyricsResult? TryReadEmbedded(string audioPath)
        {
            try
            {
                if (!File.Exists(audioPath))
                {
                    return null;
                }

                using TagLib.File file = TagLib.File.Create(audioPath);
                return FromText(file.Tag?.Lyrics, LyricsSource.Embedded, sourceName: null);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary><c>Song.flac</c> → <c>Song.lrc</c> in the same folder (Windows paths are case-insensitive).</summary>
        internal static string? FindSidecar(string audioPath)
        {
            string? directory = Path.GetDirectoryName(audioPath);
            string name = Path.GetFileNameWithoutExtension(audioPath);
            if (string.IsNullOrEmpty(directory) || string.IsNullOrEmpty(name))
            {
                return null;
            }

            string candidate = Path.Combine(directory, name + ".lrc");
            return File.Exists(candidate) ? candidate : null;
        }

        /// <summary>Synced when the text holds parseable LRC timestamps; otherwise plain lyrics.</summary>
        internal static LyricsResult? FromText(string? text, LyricsSource source, string? sourceName)
        {
            string trimmed = (text ?? string.Empty).Trim('﻿', ' ', '\t', '\r', '\n');
            if (trimmed.Length == 0)
            {
                return null;
            }

            bool synced = LyricsClient.HasParseableSyncedLyrics(trimmed);
            return new LyricsResult
            {
                Status = LyricsStatus.Found,
                SyncedLyrics = synced ? trimmed : null,
                PlainLyrics = synced ? null : trimmed,
                Source = source,
                SourceName = sourceName
            };
        }
    }
}
