using System.Security.Cryptography;
using System.Text.RegularExpressions;
using EMP.Library.Metadata;

namespace EMP.Library
{
    /// <summary>
    /// Stores artist hero photographs under a dedicated AppData folder exposed to WebView2
    /// only via the <c>artist-art.emp</c> virtual host. Filenames are content hashes so the
    /// UI never supplies filesystem paths.
    /// </summary>
    internal static class ArtistImageCache
    {
        public const string HostName = "artist-art.emp";
        public const int MaxDownloadBytes = 4 * 1024 * 1024;
        public const int MaxLongestEdge = 2400;
        public const int MinShortestEdge = 600;
        public const int MinWideWidth = 800;

        private static readonly Regex SafeFileName = new(
            @"^[a-f0-9]{16,64}\.(jpg|jpeg|png)$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static string? rootOverride;

        public static string DefaultRoot => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "ArtistMetadata",
            "images");

        public static string Root
        {
            get => rootOverride ?? DefaultRoot;
            internal set => rootOverride = value;
        }

        public static void EnsureRoot()
        {
            Directory.CreateDirectory(Root);
        }

        /// <summary>
        /// Writes validated online-hero image bytes and returns a WebView URL under <see cref="HostName"/>.
        /// </summary>
        public static ArtistCachedImage? Store(byte[] data, string? mimeHint)
        {
            if (!TryValidateHeroImage(data, mimeHint, out string mime, out int width, out int height, out string? _))
            {
                return null;
            }

            return StoreValidated(data, mime, width, height, enforceOnlineHeroMinimums: true);
        }

        /// <summary>
        /// Stores already-validated image bytes. When <paramref name="enforceOnlineHeroMinimums"/> is false,
        /// custom user photos may use the looser custom-image size rules already applied by the caller.
        /// </summary>
        public static ArtistCachedImage? StoreValidated(
            byte[] data,
            string mime,
            int width,
            int height,
            bool enforceOnlineHeroMinimums)
        {
            if (data.Length == 0 || width <= 0 || height <= 0)
            {
                return null;
            }

            if (enforceOnlineHeroMinimums
                && (Math.Min(width, height) < MinShortestEdge
                    || (width >= height && width < MinWideWidth)
                    || Math.Max(width, height) > MaxLongestEdge))
            {
                return null;
            }

            string extension = mime.Contains("png", StringComparison.OrdinalIgnoreCase) ? ".png" : ".jpg";
            string hash = Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
            string fileName = hash[..32] + extension;
            string path = Path.Combine(Root, fileName);

            EnsureRoot();
            if (!File.Exists(path))
            {
                AtomicWrite(path, data);
            }

            string version = hash[..16];
            return new ArtistCachedImage(
                FileName: fileName,
                LocalPath: path,
                Url: BuildUrl(fileName, version),
                Width: width,
                Height: height,
                Presentation: width >= height * 1.15 ? "wide" : "portrait");
        }

        public static bool TryGetDimensions(byte[] data, string mime, out int width, out int height) =>
            TryGetDimensionsPublic(data, mime, out width, out height);

        public static string BuildUrl(string fileName, string version)
        {
            if (!IsSafeFileName(fileName))
            {
                throw new ArgumentException("Unsafe artist image file name.", nameof(fileName));
            }

            return $"https://{HostName}/{fileName}?v={Uri.EscapeDataString(version)}";
        }

        public static bool IsSafeFileName(string? fileName)
        {
            return !string.IsNullOrWhiteSpace(fileName)
                && fileName.IndexOfAny(Path.GetInvalidFileNameChars()) < 0
                && !fileName.Contains('/', StringComparison.Ordinal)
                && !fileName.Contains('\\', StringComparison.Ordinal)
                && !fileName.Contains("..", StringComparison.Ordinal)
                && SafeFileName.IsMatch(fileName);
        }

        /// <summary>
        /// Resolves a public artist-art URL or bare file name to a path under <see cref="Root"/>.
        /// Rejects traversal, absolute paths, and anything outside the cache root.
        /// Returns false when the name is unsafe or the file is missing.
        /// </summary>
        public static bool TryResolveExistingFile(string? urlOrFileName, out string fullPath)
        {
            fullPath = string.Empty;
            if (!TryGetSafeRelativeFileName(urlOrFileName, out string fileName))
            {
                return false;
            }

            string rootFull = Path.GetFullPath(Root);
            string candidate = Path.GetFullPath(Path.Combine(rootFull, fileName));
            if (!candidate.StartsWith(rootFull.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase)
                && !string.Equals(candidate, rootFull, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!File.Exists(candidate))
            {
                return false;
            }

            fullPath = candidate;
            return true;
        }

        public static bool TryGetSafeRelativeFileName(string? urlOrFileName, out string fileName)
        {
            fileName = string.Empty;
            if (string.IsNullOrWhiteSpace(urlOrFileName))
            {
                return false;
            }

            string value = urlOrFileName.Trim();
            if (Uri.TryCreate(value, UriKind.Absolute, out Uri? uri))
            {
                if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(uri.Host, HostName, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }

                value = uri.AbsolutePath.TrimStart('/');
            }

            value = Uri.UnescapeDataString(value.Split('?', 2)[0].Split('#', 2)[0]);
            if (value.Contains("..", StringComparison.Ordinal)
                || value.Contains('/')
                || value.Contains('\\')
                || Path.IsPathRooted(value))
            {
                return false;
            }

            if (!IsSafeFileName(value))
            {
                return false;
            }

            fileName = value;
            return true;
        }

        public static bool TryValidateHeroImage(
            byte[]? data,
            string? mimeHint,
            out string mime,
            out int width,
            out int height,
            out string? error)
        {
            mime = string.Empty;
            width = 0;
            height = 0;
            error = null;

            if (data is null || data.Length == 0 || data.Length > MaxDownloadBytes)
            {
                error = "Image missing or too large.";
                return false;
            }

            // Prefer the shared validator, then fall back to header dimension reads so
            // hero-specific size rules can still run when the shared longest-edge cap differs.
            if (!ArtworkImageValidator.TryValidate(data, mimeHint, out mime, out error)
                && !TryReadDimensionsLoose(data, out mime, out width, out height))
            {
                return false;
            }

            if ((width <= 0 || height <= 0)
                && !TryReadDimensionsLoose(data, out mime, out width, out height))
            {
                error = "Unable to read image dimensions.";
                return false;
            }

            if (Math.Max(width, height) > MaxLongestEdge)
            {
                error = "Image edge too large.";
                return false;
            }

            int shortest = Math.Min(width, height);
            if (shortest < MinShortestEdge)
            {
                error = "Image too small for hero use.";
                return false;
            }

            // Portrait images may be narrower than MinWideWidth; wide heroes need breadth.
            if (width >= height && width < MinWideWidth)
            {
                error = "Wide image too narrow for hero use.";
                return false;
            }

            return true;
        }

        private static bool TryReadDimensionsLoose(byte[] data, out string mime, out int width, out int height)
        {
            mime = string.Empty;
            width = 0;
            height = 0;
            if (ArtworkImageValidator.IsPng(data))
            {
                mime = "image/png";
            }
            else if (ArtworkImageValidator.IsJpeg(data))
            {
                mime = "image/jpeg";
            }
            else
            {
                return false;
            }

            // Reuse validator's private path via a temporary oversized-allowing call is unavailable;
            // Store already called TryValidate — for loose read use a tiny probe through Store's sister.
            return TryGetDimensionsPublic(data, mime, out width, out height);
        }

        private static bool TryGetDimensionsPublic(byte[] data, string mime, out int width, out int height)
        {
            width = 0;
            height = 0;
            try
            {
                if (mime == "image/png" && data.Length >= 24)
                {
                    width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
                    height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
                    return width > 0 && height > 0;
                }

                if (mime == "image/jpeg")
                {
                    return TryReadJpegDimensions(data, out width, out height);
                }
            }
            catch (Exception)
            {
                return false;
            }

            return false;
        }

        private static bool TryReadJpegDimensions(byte[] data, out int width, out int height)
        {
            width = 0;
            height = 0;
            int i = 2;
            while (i + 9 < data.Length)
            {
                if (data[i] != 0xFF)
                {
                    i++;
                    continue;
                }

                byte marker = data[i + 1];
                if (marker is 0xD8 or 0x01)
                {
                    i += 2;
                    continue;
                }

                if (marker is 0xD9 or 0xDA)
                {
                    break;
                }

                int segmentLength = (data[i + 2] << 8) | data[i + 3];
                if (segmentLength < 2 || i + 2 + segmentLength > data.Length)
                {
                    return false;
                }

                bool isSof = marker is (>= 0xC0 and <= 0xC3)
                    or (>= 0xC5 and <= 0xC7)
                    or (>= 0xC9 and <= 0xCB)
                    or (>= 0xCD and <= 0xCF);
                if (isSof && segmentLength >= 7)
                {
                    height = (data[i + 5] << 8) | data[i + 6];
                    width = (data[i + 7] << 8) | data[i + 8];
                    return width > 0 && height > 0;
                }

                i += 2 + segmentLength;
            }

            return false;
        }

        private static void AtomicWrite(string outputPath, byte[] data)
        {
            string? directory = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            string temp = outputPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllBytes(temp, data);
                File.Move(temp, outputPath, overwrite: true);
            }
            catch
            {
                try
                {
                    if (File.Exists(temp))
                    {
                        File.Delete(temp);
                    }
                }
                catch (Exception)
                {
                    // Best-effort temp cleanup.
                }

                throw;
            }
        }
    }

    internal sealed record ArtistCachedImage(
        string FileName,
        string LocalPath,
        string Url,
        int Width,
        int Height,
        string Presentation);
}
