namespace EMP.Cast
{
    internal static class MediaTypes
    {
        public static string FromPath(string path)
        {
            return FromExtension(Path.GetExtension(path));
        }

        public static string FromExtension(string? extension)
        {
            return extension?.ToLowerInvariant() switch
            {
                ".mp3" => "audio/mpeg",
                ".m4a" => "audio/mp4",
                ".aac" => "audio/mp4",
                ".flac" => "audio/flac",
                ".wav" => "audio/wav",
                ".ogg" => "audio/ogg",
                ".opus" => "audio/ogg",
                ".wma" => "audio/x-ms-wma",
                ".aiff" => "audio/aiff",
                ".alac" => "audio/mp4",
                ".jpg" or ".jpeg" => "image/jpeg",
                ".png" => "image/png",
                ".webp" => "image/webp",
                _ => "application/octet-stream"
            };
        }

        public static bool IsCastAudio(string? extension)
        {
            return extension?.ToLowerInvariant() is ".mp3" or ".m4a" or ".aac" or ".flac" or ".wav" or ".ogg" or ".opus";
        }
    }
}
