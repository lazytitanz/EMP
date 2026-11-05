using Sonora.Audio.Output;

namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Pure mapping between EMP UI mode strings and Sonora output configuration enums.
    /// </summary>
    internal static class SonoraOutputModeMapping
    {
        public static AudioOutputConfiguration FromUi(
            string? mode,
            string? exclusiveFallback = "shared")
        {
            AudioOutputMode outputMode = ParseMode(mode);
            ExclusiveModeFallback fallback = outputMode == AudioOutputMode.Exclusive
                ? ParseFallback(exclusiveFallback)
                : ExclusiveModeFallback.None;

            return new AudioOutputConfiguration
            {
                Mode = outputMode,
                ExclusiveFallback = fallback
            };
        }

        public static string ToUiMode(AudioOutputMode? mode) =>
            mode == AudioOutputMode.Exclusive ? "exclusive" : "shared";

        public static string ToUiFallbackReason(ExclusiveFallbackReason reason) =>
            reason switch
            {
                ExclusiveFallbackReason.DeviceBusy => "deviceBusy",
                ExclusiveFallbackReason.ExclusiveModeRestricted => "exclusiveModeRestricted",
                ExclusiveFallbackReason.UnsupportedFormat => "unsupportedFormat",
                ExclusiveFallbackReason.InitializationFailed => "initializationFailed",
                _ => "none"
            };

        private static AudioOutputMode ParseMode(string? mode) =>
            string.Equals(mode, "exclusive", StringComparison.OrdinalIgnoreCase)
                ? AudioOutputMode.Exclusive
                : AudioOutputMode.Shared;

        private static ExclusiveModeFallback ParseFallback(string? fallback) =>
            string.Equals(fallback, "none", StringComparison.OrdinalIgnoreCase)
                ? ExclusiveModeFallback.None
                : ExclusiveModeFallback.Shared;
    }
}
