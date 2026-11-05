using System.Text.RegularExpressions;

namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Classifies Sonora command failures for UI policy (transport vs non-transport) and
    /// strips local filesystem paths from messages shown in the WebView.
    /// </summary>
    internal static partial class SonoraPlaybackError
    {
        public const string OperationLoad = "load";
        public const string OperationPreload = "preload";
        public const string OperationSeek = "seek";
        public const string OperationOutputDevice = "outputDevice";
        public const string OperationPlay = "play";
        public const string OperationUnknown = "unknown";

        /// <summary>
        /// True when the UI should clear optimistic playing / treat the session as failed.
        /// Preload and output-device failures must not stop the current track.
        /// </summary>
        public static bool AffectsTransport(string? operation) =>
            operation is OperationLoad or OperationPlay or OperationSeek or OperationUnknown
                || string.IsNullOrWhiteSpace(operation);

        /// <summary>
        /// Stale async errors (generation behind the latest accepted command) must be ignored
        /// for transport. Preload errors may still toast when current, but never stop playback.
        /// </summary>
        public static bool IsStale(long errorGeneration, long currentGeneration) =>
            errorGeneration > 0 && errorGeneration < currentGeneration;

        public static string UserMessage(string? operation, Exception? exception)
        {
            string? raw = exception?.Message;
            string sanitized = SanitizeMessage(raw);

            if (ContainsIgnoreCase(raw, "could not be opened")
                || ContainsIgnoreCase(raw, "InvalidAudio")
                || exception is global::Sonora.Audio.InvalidAudioException)
            {
                return "This track could not be opened.";
            }

            if (ContainsIgnoreCase(raw, "not supported")
                || exception is global::Sonora.Audio.UnsupportedFormatException)
            {
                return "This track's audio format is not supported.";
            }

            if (exception is FileNotFoundException
                || ContainsIgnoreCase(raw, "was not found")
                || ContainsIgnoreCase(raw, "is missing")
                || ContainsIgnoreCase(raw, "No library media path"))
            {
                return "This track's file could not be found.";
            }

            if (ContainsIgnoreCase(raw, "No audio source is loaded"))
            {
                return "The track is still loading. Try play again in a moment.";
            }

            if (string.Equals(operation, OperationPreload, StringComparison.Ordinal))
            {
                return string.IsNullOrWhiteSpace(sanitized)
                    ? "The next track could not be prepared."
                    : sanitized;
            }

            if (string.Equals(operation, OperationOutputDevice, StringComparison.Ordinal))
            {
                return string.IsNullOrWhiteSpace(sanitized)
                    ? "The audio output device could not be changed."
                    : sanitized;
            }

            if (string.Equals(operation, OperationSeek, StringComparison.Ordinal))
            {
                return string.IsNullOrWhiteSpace(sanitized)
                    ? "Seek failed for this track."
                    : sanitized;
            }

            if (string.IsNullOrWhiteSpace(sanitized)
                || LooksLikeRawPath(sanitized)
                || sanitized.Length > 160)
            {
                return "This track could not be played.";
            }

            return sanitized;
        }

        public static string SanitizeMessage(string? message)
        {
            if (string.IsNullOrWhiteSpace(message))
            {
                return string.Empty;
            }

            string text = message.Trim();

            // Prefer extension-anchored paths so apostrophes in file names (I'm.m4a) do not truncate.
            text = AudioFilePathRegex().Replace(text, "this file");
            text = WindowsPathRegex().Replace(text, "this file");
            text = UncPathRegex().Replace(text, "this file");

            // Collapse awkward grammar after replacements.
            text = text.Replace("source 'this file'", "source", StringComparison.OrdinalIgnoreCase);
            text = text.Replace("source this file", "source", StringComparison.OrdinalIgnoreCase);
            text = text.Replace("of 'this file'", string.Empty, StringComparison.OrdinalIgnoreCase);
            text = MultiSpaceRegex().Replace(text, " ").Trim().Trim(' ', '.', '\'', '"');

            return text;
        }

        public static string TitleFor(string? operation) =>
            string.Equals(operation, OperationPreload, StringComparison.Ordinal)
                ? "Couldn't prepare next track"
                : string.Equals(operation, OperationOutputDevice, StringComparison.Ordinal)
                    ? "Audio output"
                    : "Couldn't play track";

        private static bool ContainsIgnoreCase(string? haystack, string needle) =>
            !string.IsNullOrEmpty(haystack)
            && haystack.Contains(needle, StringComparison.OrdinalIgnoreCase);

        private static bool LooksLikeRawPath(string text) =>
            text.Contains(":\\", StringComparison.Ordinal)
            || text.StartsWith("\\\\", StringComparison.Ordinal);

        [GeneratedRegex(
            @"['""]?[A-Za-z]:\\.+?\.(?:mp3|m4a|flac|wav|ogg|oga|opus|wma|aiff|aif|alac|webm|aac)['""]?",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
        private static partial Regex AudioFilePathRegex();

        [GeneratedRegex(@"\b[A-Za-z]:\\[^\r\n]*", RegexOptions.CultureInvariant)]
        private static partial Regex WindowsPathRegex();

        [GeneratedRegex(@"\\\\[^\s""']+", RegexOptions.CultureInvariant)]
        private static partial Regex UncPathRegex();

        [GeneratedRegex(@"\s{2,}", RegexOptions.CultureInvariant)]
        private static partial Regex MultiSpaceRegex();
    }

    /// <summary>
    /// Wraps a Sonora command failure with the generation that started the command so the UI
    /// can ignore stale errors after a newer load/play succeeds.
    /// </summary>
    internal sealed class SonoraCommandException : Exception
    {
        public SonoraCommandException(
            long generation,
            string operation,
            string? trackId,
            Exception innerException)
            : base(innerException.Message, innerException)
        {
            Generation = generation;
            Operation = operation;
            TrackId = trackId;
        }

        public long Generation { get; }

        public string Operation { get; }

        public string? TrackId { get; }
    }
}
