namespace EMP.Library
{
    /// <summary>
    /// Validates TagLib ReplayGain doubles into nullable values EMP can cache and send to the UI.
    /// Rejects nonfinite or unreasonable values rather than applying dangerous gain.
    /// </summary>
    internal static class ReplayGainParser
    {
        public const double MinGainDb = -24.0;

        public const double MaxGainDb = 24.0;

        public const double MinPeak = 1e-6;

        public const double MaxPeak = 8.0;

        public static double? TryParseGainDb(double value)
        {
            if (!IsFinite(value) || value < MinGainDb || value > MaxGainDb)
            {
                return null;
            }

            return value;
        }

        public static double? TryParsePeak(double value)
        {
            if (!IsFinite(value) || value <= 0 || value < MinPeak || value > MaxPeak)
            {
                return null;
            }

            return value;
        }

        public static ReplayGainInfo FromTagLib(
            double trackGain,
            double trackPeak,
            double albumGain,
            double albumPeak)
        {
            return new ReplayGainInfo(
                TryParseGainDb(trackGain),
                TryParsePeak(trackPeak),
                TryParseGainDb(albumGain),
                TryParsePeak(albumPeak));
        }

        private static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }
    }

    internal readonly record struct ReplayGainInfo(
        double? TrackGainDb,
        double? TrackPeak,
        double? AlbumGainDb,
        double? AlbumPeak);
}
