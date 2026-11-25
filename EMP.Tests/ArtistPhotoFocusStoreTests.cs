using EMP.Hosting;
using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    [Collection(ArtistMetadataTestCollection.Name)]
    public sealed class ArtistPhotoFocusStoreTests : IDisposable
    {
        private const string PhotoA = "0123456789abcdef0123456789abcdef.jpg";
        private const string PhotoB = "fedcba9876543210fedcba9876543210.jpg";

        private readonly string root = MetadataTestFixtures.CreateTempMusicRoot();

        public ArtistPhotoFocusStoreTests()
        {
            ArtistPhotoFocusStore.IndexPath = Path.Combine(root, "photo-focus.json");
        }

        public void Dispose()
        {
            ArtistPhotoFocusStore.ResetTestState();
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (Exception)
            {
                // Temp cleanup is best-effort.
            }
        }

        [Fact]
        public void SavedFocus_IsReturnedForTheSamePhoto_CaseInsensitiveArtist()
        {
            Assert.True(ArtistPhotoFocusStore.Set("3 Doors Down", PhotoA, 0.25, 0.4));

            (double X, double Y)? focus = ArtistPhotoFocusStore.TryGet("3 DOORS DOWN", PhotoA);

            Assert.Equal((0.25, 0.4), focus);
        }

        [Fact]
        public void Focus_PersistsAcrossReload()
        {
            ArtistPhotoFocusStore.Set("Artist", PhotoA, 0.1, 0.9);

            // Simulate an application restart: drop memory, keep the file.
            ArtistPhotoFocusStore.IndexPath = ArtistPhotoFocusStore.IndexPath;

            Assert.Equal((0.1, 0.9), ArtistPhotoFocusStore.TryGet("Artist", PhotoA));
        }

        [Fact]
        public void ChangedPhoto_InvalidatesAndPrunesTheOldFocus()
        {
            ArtistPhotoFocusStore.Set("Artist", PhotoA, 0.3, 0.3);

            Assert.Null(ArtistPhotoFocusStore.TryGet("Artist", PhotoB));
            // Pruned: even the original photo no longer has a manual focus.
            Assert.Null(ArtistPhotoFocusStore.TryGet("Artist", PhotoA));
        }

        [Theory]
        [InlineData(double.NaN, 0.5)]
        [InlineData(0.5, double.PositiveInfinity)]
        [InlineData(-0.01, 0.5)]
        [InlineData(0.5, 1.01)]
        public void InvalidCoordinates_AreRejected(double x, double y)
        {
            Assert.False(ArtistPhotoFocusStore.Set("Artist", PhotoA, x, y));
            Assert.Null(ArtistPhotoFocusStore.TryGet("Artist", PhotoA));
        }

        [Fact]
        public void UnsafeOrMissingImageKey_IsRejected()
        {
            Assert.False(ArtistPhotoFocusStore.Set("Artist", "..\\evil.jpg", 0.5, 0.5));
            Assert.False(ArtistPhotoFocusStore.Set("Artist", null, 0.5, 0.5));
            Assert.Null(ArtistPhotoFocusStore.TryGet("Artist", null));
        }

        [Fact]
        public void Clear_RestoresAutomaticFraming()
        {
            ArtistPhotoFocusStore.Set("Artist", PhotoA, 0.6, 0.2);

            Assert.True(ArtistPhotoFocusStore.Clear("Artist"));
            Assert.Null(ArtistPhotoFocusStore.TryGet("Artist", PhotoA));
            Assert.False(ArtistPhotoFocusStore.Clear("Artist"));
        }

        [Fact]
        public void MalformedFile_IsIgnored()
        {
            File.WriteAllText(ArtistPhotoFocusStore.IndexPath,
                "{\"schemaVersion\":1,\"artists\":{\"a\":{\"imageKey\":\"" + PhotoA + "\",\"x\":5,\"y\":0.5},\"b\":\"nope\"}}");
            ArtistPhotoFocusStore.IndexPath = ArtistPhotoFocusStore.IndexPath;

            Assert.Null(ArtistPhotoFocusStore.TryGet("a", PhotoA));
        }
    }

    public sealed class ShellRevealTests : IDisposable
    {
        private readonly string root = MetadataTestFixtures.CreateTempMusicRoot();

        public void Dispose()
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (Exception)
            {
                // Temp cleanup is best-effort.
            }
        }

        [Fact]
        public void ExistingFullyQualifiedFile_IsTheRevealTarget()
        {
            string file = Path.Combine(root, "Album", "01 Song.mp3");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllBytes(file, [1, 2, 3]);

            Assert.Equal(file, ShellReveal.ResolveRevealTarget(file));
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("relative\\song.mp3")]
        [InlineData("cmd.exe /c del *")]
        [InlineData("Z:\\definitely\\missing\\song.mp3")]
        public void MissingRelativeOrMalformedPaths_AreRejected(string? path)
        {
            Assert.Null(ShellReveal.ResolveRevealTarget(path));
        }

        [Fact]
        public void FolderPath_IsNotAFileTarget()
        {
            Assert.Null(ShellReveal.ResolveRevealTarget(root));
        }
    }
}
