using EMP.Library;
using EMP.Library.Metadata;
using Xunit;

namespace EMP.Tests
{
    public sealed class AlbumArtworkCacheTests : IDisposable
    {
        private readonly string root;
        private readonly string artworkRoot;

        public AlbumArtworkCacheTests()
        {
            root = MetadataTestFixtures.CreateTempMusicRoot();
            artworkRoot = Path.Combine(root, "artwork");
            Directory.CreateDirectory(artworkRoot);
        }

        public void Dispose()
        {
            try
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, recursive: true);
                }
            }
            catch (Exception)
            {
                // Temp cleanup is best-effort.
            }
        }

        [Fact]
        public void StripCoverUrlQuery_RemovesVersion()
        {
            Assert.Equal("artwork/abc.jpg", AlbumArtworkCache.StripCoverUrlQuery("artwork/abc.jpg?v=deadbeefcafe"));
            Assert.Equal("artwork/abc.jpg", AlbumArtworkCache.StripCoverUrlQuery("artwork/abc.jpg"));
            Assert.Null(AlbumArtworkCache.StripCoverUrlQuery(null));
            Assert.Null(AlbumArtworkCache.StripCoverUrlQuery("  "));
        }

        [Fact]
        public void EnsureAlbumCover_WritesVersionedUrlAndSkipsIdenticalRewrite()
        {
            byte[] png = MetadataTestFixtures.TinyPng();
            string? first = AlbumArtworkCache.EnsureAlbumCover(artworkRoot, "album1", png, "image/png");
            Assert.NotNull(first);
            Assert.StartsWith("artwork/album1.png?v=", first);
            string path = Path.Combine(artworkRoot, "album1.png");
            Assert.True(File.Exists(path));
            DateTime firstWrite = File.GetLastWriteTimeUtc(path);

            Thread.Sleep(20);
            string? second = AlbumArtworkCache.EnsureAlbumCover(
                artworkRoot,
                "album1",
                png,
                "image/png",
                previousCoverUrl: first);
            Assert.Equal(first, second);
            Assert.Equal(firstWrite, File.GetLastWriteTimeUtc(path));
        }

        [Fact]
        public void EnsureAlbumCover_ByteCompareFallback_WhenPriorUrlMissing()
        {
            byte[] png = MetadataTestFixtures.TinyPng();
            string? first = AlbumArtworkCache.EnsureAlbumCover(artworkRoot, "album2", png, "image/png");
            Assert.NotNull(first);
            string path = Path.Combine(artworkRoot, "album2.png");
            DateTime firstWrite = File.GetLastWriteTimeUtc(path);

            Thread.Sleep(20);
            string? second = AlbumArtworkCache.EnsureAlbumCover(
                artworkRoot,
                "album2",
                png,
                "image/png",
                previousCoverUrl: null);
            Assert.Equal(first, second);
            Assert.Equal(firstWrite, File.GetLastWriteTimeUtc(path));
        }

        [Fact]
        public void EnsureAlbumCover_RewritesWhenContentChangesAndCleansOrphanExtension()
        {
            byte[] png = MetadataTestFixtures.TinyPng();
            string? first = AlbumArtworkCache.EnsureAlbumCover(artworkRoot, "album3", png, "image/png");
            Assert.NotNull(first);
            Assert.True(File.Exists(Path.Combine(artworkRoot, "album3.png")));

            byte[] jpegish = [0xFF, 0xD8, 0xFF, 0xD9, 0x00, 0x01, 0x02, 0x03];
            // Not a valid JPEG for the validator, but EnsureAlbumCover does not validate mime payload.
            string? second = AlbumArtworkCache.EnsureAlbumCover(
                artworkRoot,
                "album3",
                jpegish,
                "image/jpeg",
                previousCoverUrl: first);
            Assert.NotNull(second);
            Assert.StartsWith("artwork/album3.jpg?v=", second);
            Assert.NotEqual(first, second);
            Assert.True(File.Exists(Path.Combine(artworkRoot, "album3.jpg")));
            Assert.False(File.Exists(Path.Combine(artworkRoot, "album3.png")));
        }

        [Fact]
        public void EnsureAlbumCover_RegeneratesMissingOrCorruptFile()
        {
            byte[] png = MetadataTestFixtures.TinyPng();
            string? url = AlbumArtworkCache.EnsureAlbumCover(artworkRoot, "album4", png, "image/png");
            Assert.NotNull(url);
            string path = Path.Combine(artworkRoot, "album4.png");
            File.WriteAllBytes(path, [1, 2, 3]);

            string? restored = AlbumArtworkCache.EnsureAlbumCover(
                artworkRoot,
                "album4",
                png,
                "image/png",
                previousCoverUrl: url);
            Assert.Equal(url, restored);
            Assert.Equal(png, File.ReadAllBytes(path));
        }

        [Fact]
        public void ResolveArtworkPath_StripsQueryAndFindsFile()
        {
            byte[] png = MetadataTestFixtures.TinyPng();
            string albumDir = Path.Combine(root, "Album");
            Directory.CreateDirectory(albumDir);
            string path = MetadataTestFixtures.WriteSilentWav(albumDir, "01 - One.wav", "One");
            EmbedPng(path, png);

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);
            AlbumInfo album = Assert.Single(library.Albums.Concat(library.Singles));
            Assert.NotNull(album.CoverUrl);
            Assert.Contains("?v=", album.CoverUrl);

            LibraryMediaLocation location = library.Locations[album.TrackIds[0]];
            Assert.NotNull(location.ArtworkPath);
            Assert.True(File.Exists(location.ArtworkPath));
            Assert.DoesNotContain('?', location.ArtworkPath);
        }

        [Fact]
        public void Scan_MultiCoverAlbum_SelectsFirstTrackArtDeterministically()
        {
            byte[] firstArt = MetadataTestFixtures.TinyPng();
            // Distinct 1x1 PNG (different bytes / hash) — black pixel variant via padding in tEXt is hard;
            // use jpeg-ish second payload written as image/jpeg through TagLib as PNG clone with flipped byte.
            byte[] secondArt = MetadataTestFixtures.TinyPng().ToArray();
            secondArt[^5] ^= 0xFF;

            string albumDir = Path.Combine(root, "MultiCover");
            Directory.CreateDirectory(albumDir);
            string track1 = MetadataTestFixtures.WriteSilentWav(albumDir, "01 - First.wav", "First");
            string track2 = MetadataTestFixtures.WriteSilentWav(albumDir, "02 - Second.wav", "Second");
            SetTrackNumber(track1, 1);
            SetTrackNumber(track2, 2);
            EmbedPng(track1, firstArt);
            EmbedPng(track2, secondArt);

            MusicLibrary firstScan = MusicLibraryScanner.Scan(root, artworkRoot);
            AlbumInfo album = Assert.Single(firstScan.Albums.Concat(firstScan.Singles));
            Assert.NotNull(album.CoverUrl);
            string expectedVersion = AlbumArtworkCache.ContentVersion(firstArt);
            Assert.Contains("?v=" + expectedVersion, album.CoverUrl, StringComparison.OrdinalIgnoreCase);

            Dictionary<string, string?> previous = new(StringComparer.OrdinalIgnoreCase)
            {
                [album.Id] = album.CoverUrl
            };
            string coverPath = Path.Combine(artworkRoot, album.Id + ".png");
            DateTime writeBefore = File.GetLastWriteTimeUtc(coverPath);

            Thread.Sleep(20);
            MusicLibrary secondScan = MusicLibraryScanner.Scan(root, artworkRoot, previous);
            AlbumInfo album2 = Assert.Single(secondScan.Albums.Concat(secondScan.Singles));
            Assert.Equal(album.CoverUrl, album2.CoverUrl);
            Assert.Equal(writeBefore, File.GetLastWriteTimeUtc(coverPath));
        }

        private static void EmbedPng(string path, byte[] png)
        {
            using TagLib.File file = TagLib.File.Create(path);
            file.Tag.Pictures =
            [
                new TagLib.Picture(new TagLib.ByteVector(png))
                {
                    MimeType = "image/png",
                    Type = TagLib.PictureType.FrontCover
                }
            ];
            file.Save();
        }

        private static void SetTrackNumber(string path, uint number)
        {
            using TagLib.File file = TagLib.File.Create(path);
            file.Tag.Track = number;
            file.Save();
        }
    }
}
