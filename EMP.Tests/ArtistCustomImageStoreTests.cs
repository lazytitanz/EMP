using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    [Collection(ArtistMetadataTestCollection.Name)]
    public sealed class ArtistCustomImageStoreTests : IDisposable
    {
        private readonly string root;

        public ArtistCustomImageStoreTests()
        {
            root = Path.Combine(Path.GetTempPath(), "EMP-ArtistCustomImageTests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            ArtistCustomImageStore.ConfigureForTests(root);
        }

        public void Dispose()
        {
            ArtistCustomImageStore.ResetTestState();
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
        public void SetFromFile_CopiesValidatedImageAndPrefersCustomLookup()
        {
            string source = Path.Combine(root, "source.png");
            File.WriteAllBytes(source, ArtistImageCacheTests.PngWithDimensions(640, 800));
            DateTime sourceWrite = File.GetLastWriteTimeUtc(source);

            MusicBrainzClient.ArtistImageInfo? image = ArtistCustomImageStore.SetFromFile("Julia Wolf", source);
            Assert.NotNull(image);
            Assert.True(image!.IsCustom);
            Assert.Equal("portrait", image.Presentation);
            Assert.StartsWith("https://artist-art.emp/", image.Url);
            Assert.True(ArtistCustomImageStore.TryGet("julia wolf", out MusicBrainzClient.ArtistImageInfo loaded));
            Assert.Equal(image.FileName, loaded.FileName);

            // Original file must remain untouched.
            Assert.Equal(sourceWrite, File.GetLastWriteTimeUtc(source));
            Assert.True(File.Exists(source));
        }

        [Fact]
        public void SetFromFile_RejectsTinyImages()
        {
            string source = Path.Combine(root, "tiny.png");
            File.WriteAllBytes(source, MetadataTestFixtures.TinyPng());
            Assert.Null(ArtistCustomImageStore.SetFromFile("Artist", source));
        }

        [Fact]
        public void Clear_RemovesAssociation()
        {
            string source = Path.Combine(root, "keep.png");
            File.WriteAllBytes(source, ArtistImageCacheTests.PngWithDimensions(900, 700));
            Assert.NotNull(ArtistCustomImageStore.SetFromFile("Audioslave", source));
            Assert.True(ArtistCustomImageStore.Clear("Audioslave"));
            Assert.False(ArtistCustomImageStore.TryGet("Audioslave", out _));
        }

        [Fact]
        public void ApplyCustomImage_OverridesOnlineImage()
        {
            string source = Path.Combine(root, "custom.png");
            File.WriteAllBytes(source, ArtistImageCacheTests.PngWithDimensions(900, 700));
            Assert.NotNull(ArtistCustomImageStore.SetFromFile("Tove Lo", source));

            MusicBrainzClient.ArtistProfile profile = new()
            {
                Name = "Tove Lo",
                Image = new MusicBrainzClient.ArtistImageInfo
                {
                    Url = "https://artist-art.emp/online.jpg",
                    FileName = "0123456789abcdef0123456789abcdef.jpg",
                    IsCustom = false
                }
            };

            MusicBrainzClient.ArtistProfile merged = MusicBrainzClient.ApplyCustomImage(profile);
            Assert.True(merged.Image!.IsCustom);
            Assert.NotEqual("online.jpg", Path.GetFileName(merged.Image.Url));
        }
    }
}
