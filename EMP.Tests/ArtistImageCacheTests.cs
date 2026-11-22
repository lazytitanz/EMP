using System.Text;
using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    [Collection(ArtistMetadataTestCollection.Name)]
    public sealed class ArtistImageCacheTests : IDisposable
    {
        private readonly string root;

        public ArtistImageCacheTests()
        {
            root = Path.Combine(Path.GetTempPath(), "EMP-ArtistImageTests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            ArtistImageCache.Root = root;
        }

        public void Dispose()
        {
            ArtistImageCache.Root = ArtistImageCache.DefaultRoot;
            try
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, recursive: true);
                }
            }
            catch (Exception)
            {
                // Best-effort cleanup.
            }
        }

        [Fact]
        public void IsSafeFileName_RejectsTraversalAndOddNames()
        {
            Assert.False(ArtistImageCache.IsSafeFileName("../secret.png"));
            Assert.False(ArtistImageCache.IsSafeFileName("..\\secret.png"));
            Assert.False(ArtistImageCache.IsSafeFileName("folder/a.png"));
            Assert.False(ArtistImageCache.IsSafeFileName("notahex.jpg"));
            Assert.True(ArtistImageCache.IsSafeFileName("0123456789abcdef0123456789abcdef.jpg"));
        }

        [Fact]
        public void TryGetSafeRelativeFileName_AcceptsHostUrlAndRejectsTraversal()
        {
            Assert.True(ArtistImageCache.TryGetSafeRelativeFileName(
                "https://artist-art.emp/0123456789abcdef0123456789abcdef.jpg?v=abc",
                out string fileName));
            Assert.Equal("0123456789abcdef0123456789abcdef.jpg", fileName);

            Assert.False(ArtistImageCache.TryGetSafeRelativeFileName(
                "https://artist-art.emp/../Windows/win.ini",
                out _));
            Assert.False(ArtistImageCache.TryGetSafeRelativeFileName(
                "https://evil.example/0123456789abcdef0123456789abcdef.jpg",
                out _));
            Assert.False(ArtistImageCache.TryGetSafeRelativeFileName(
                "C:\\Windows\\win.ini",
                out _));
        }

        [Fact]
        public void TryResolveExistingFile_RequiresFileUnderRoot()
        {
            byte[] png = PngWithDimensions(1000, 700);
            ArtistCachedImage? stored = ArtistImageCache.Store(png, "image/png");
            Assert.NotNull(stored);

            Assert.True(ArtistImageCache.TryResolveExistingFile(stored!.Url, out string path));
            Assert.True(File.Exists(path));
            Assert.StartsWith(Path.GetFullPath(root), Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase);

            Assert.False(ArtistImageCache.TryResolveExistingFile(
                "https://artist-art.emp/0123456789abcdef0123456789abcdef.jpg",
                out _));
            Assert.False(ArtistImageCache.TryResolveExistingFile("../" + stored.FileName, out _));
        }

        [Fact]
        public void Store_RejectsTinyImages()
        {
            Assert.Null(ArtistImageCache.Store(MetadataTestFixtures.TinyPng(), "image/png"));
        }

        [Fact]
        public void Store_AcceptsWideHeroCandidate()
        {
            ArtistCachedImage? stored = ArtistImageCache.Store(PngWithDimensions(1200, 700), "image/png");
            Assert.NotNull(stored);
            Assert.Equal("wide", stored!.Presentation);
            Assert.StartsWith("https://artist-art.emp/", stored.Url);
            Assert.True(File.Exists(stored.LocalPath));
        }

        [Fact]
        public void Store_MarksPortraitPresentation()
        {
            ArtistCachedImage? stored = ArtistImageCache.Store(PngWithDimensions(700, 1100), "image/png");
            Assert.NotNull(stored);
            Assert.Equal("portrait", stored!.Presentation);
        }

        /// <summary>
        /// Minimal PNG whose IHDR reports the requested dimensions (enough for EMP validators).
        /// </summary>
        internal static byte[] PngWithDimensions(int width, int height)
        {
            static void WriteInt(Stream stream, int value)
            {
                stream.WriteByte((byte)((value >> 24) & 0xFF));
                stream.WriteByte((byte)((value >> 16) & 0xFF));
                stream.WriteByte((byte)((value >> 8) & 0xFF));
                stream.WriteByte((byte)(value & 0xFF));
            }

            using MemoryStream stream = new();
            stream.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

            byte[] ihdrData = new byte[13];
            using (MemoryStream ihdr = new(ihdrData))
            {
                WriteInt(ihdr, width);
                WriteInt(ihdr, height);
                ihdr.WriteByte(8); // bit depth
                ihdr.WriteByte(2); // RGB
                ihdr.WriteByte(0);
                ihdr.WriteByte(0);
                ihdr.WriteByte(0);
            }

            WriteChunk(stream, "IHDR", ihdrData);
            WriteChunk(stream, "IDAT", [0x08, 0x1D, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
            WriteChunk(stream, "IEND", []);
            return stream.ToArray();
        }

        private static void WriteChunk(Stream stream, string type, byte[] data)
        {
            Span<byte> typeBytes = stackalloc byte[4];
            Encoding.ASCII.GetBytes(type.AsSpan(), typeBytes);
            int length = data.Length;
            stream.WriteByte((byte)((length >> 24) & 0xFF));
            stream.WriteByte((byte)((length >> 16) & 0xFF));
            stream.WriteByte((byte)((length >> 8) & 0xFF));
            stream.WriteByte((byte)(length & 0xFF));
            stream.Write(typeBytes);
            stream.Write(data);

            byte[] crcInput = new byte[4 + data.Length];
            typeBytes.CopyTo(crcInput);
            data.CopyTo(crcInput, 4);
            uint crc = Crc32(crcInput);
            stream.WriteByte((byte)((crc >> 24) & 0xFF));
            stream.WriteByte((byte)((crc >> 16) & 0xFF));
            stream.WriteByte((byte)((crc >> 8) & 0xFF));
            stream.WriteByte((byte)(crc & 0xFF));
        }

        private static uint Crc32(byte[] data)
        {
            uint crc = 0xFFFFFFFF;
            foreach (byte value in data)
            {
                crc ^= value;
                for (int i = 0; i < 8; i++)
                {
                    uint mask = (uint)-(crc & 1);
                    crc = (crc >> 1) ^ (0xEDB88320 & mask);
                }
            }

            return ~crc;
        }
    }
}
