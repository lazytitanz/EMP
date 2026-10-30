namespace EMP.Hosting
{
    /// <summary>
    /// Local calendar date keys (YYYY-MM-DD) for historical listening attribution.
    /// </summary>
    internal static class ListenLocalDates
    {
        public static string FromUnixMilliseconds(long unixMs)
        {
            if (unixMs <= 0)
            {
                return FromDateTime(DateTime.Now);
            }

            DateTimeOffset dto = DateTimeOffset.FromUnixTimeMilliseconds(unixMs).ToLocalTime();
            return FromDateTime(dto.DateTime);
        }

        public static string FromDateTime(DateTime value)
        {
            DateTime local = value.Kind switch
            {
                DateTimeKind.Utc => value.ToLocalTime(),
                DateTimeKind.Unspecified => DateTime.SpecifyKind(value, DateTimeKind.Local),
                _ => value
            };

            return $"{local.Year:D4}-{local.Month:D2}-{local.Day:D2}";
        }

        public static bool TryParse(string? key, out DateOnly date)
        {
            return DateOnly.TryParseExact(
                key,
                "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None,
                out date);
        }
    }
}
