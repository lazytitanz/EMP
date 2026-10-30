namespace EMP.Library.Metadata
{
    internal static class ArtworkImageValidator
    {
        public const int MaxBytes = 10 * 1024 * 1024;
        public const int MaxLongestEdge = 3000;

        public static bool TryValidate(byte[]? data, string? mimeHint, out string mime, out string? error)
        {
            mime = string.Empty;
            error = null;

            if (data is null || data.Length == 0)
            {
                error = MetadataErrorMessages.For(MetadataErrorCode.InvalidImage);
                return false;
            }

            if (data.Length > MaxBytes)
            {
                error = MetadataErrorMessages.For(MetadataErrorCode.InvalidImage);
                return false;
            }

            if (IsJpeg(data))
            {
                mime = "image/jpeg";
            }
            else if (IsPng(data))
            {
                mime = "image/png";
            }
            else
            {
                error = MetadataErrorMessages.For(MetadataErrorCode.InvalidImage);
                return false;
            }

            if (!string.IsNullOrWhiteSpace(mimeHint)
                && !mimeHint.Contains("jpeg", StringComparison.OrdinalIgnoreCase)
                && !mimeHint.Contains("jpg", StringComparison.OrdinalIgnoreCase)
                && !mimeHint.Contains("png", StringComparison.OrdinalIgnoreCase))
            {
                error = MetadataErrorMessages.For(MetadataErrorCode.InvalidImage);
                return false;
            }

            if (!TryGetDimensions(data, mime, out int width, out int height)
                || width <= 0
                || height <= 0
                || Math.Max(width, height) > MaxLongestEdge)
            {
                error = MetadataErrorMessages.For(MetadataErrorCode.InvalidImage);
                return false;
            }

            return true;
        }

        public static bool IsJpeg(ReadOnlySpan<byte> data)
        {
            return data.Length > 3
                && data[0] == 0xFF
                && data[1] == 0xD8
                && data[2] == 0xFF;
        }

        public static bool IsPng(ReadOnlySpan<byte> data)
        {
            return data.Length > 8
                && data[0] == 0x89
                && data[1] == 0x50
                && data[2] == 0x4E
                && data[3] == 0x47
                && data[4] == 0x0D
                && data[5] == 0x0A
                && data[6] == 0x1A
                && data[7] == 0x0A;
        }

        private static bool TryGetDimensions(byte[] data, string mime, out int width, out int height)
        {
            width = 0;
            height = 0;
            try
            {
                if (mime == "image/png" && data.Length >= 24)
                {
                    width = ReadInt32BigEndian(data, 16);
                    height = ReadInt32BigEndian(data, 20);
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
                if (marker == 0xD8 || marker == 0x01)
                {
                    i += 2;
                    continue;
                }

                if (marker == 0xD9 || marker == 0xDA)
                {
                    break;
                }

                int segmentLength = (data[i + 2] << 8) | data[i + 3];
                if (segmentLength < 2 || i + 2 + segmentLength > data.Length)
                {
                    return false;
                }

                // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
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

        private static int ReadInt32BigEndian(byte[] data, int offset)
        {
            return (data[offset] << 24)
                | (data[offset + 1] << 16)
                | (data[offset + 2] << 8)
                | data[offset + 3];
        }
    }
}
