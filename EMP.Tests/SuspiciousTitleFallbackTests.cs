using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    public sealed class SuspiciousTitleFallbackTests
    {
        private static SuspiciousTitleFallback.Candidate C(
            string? embedded,
            string filenameTitle,
            int filenameTrack,
            string artist,
            string album)
        {
            return new SuspiciousTitleFallback.Candidate(
                embedded,
                filenameTitle,
                filenameTrack,
                artist,
                album);
        }

        [Fact]
        public void Normalize_Trims_And_EqualsNormalized_IgnoresCase()
        {
            Assert.Equal("Audioslave", SuspiciousTitleFallback.Normalize("  Audioslave  "));
            Assert.True(SuspiciousTitleFallback.EqualsNormalized(" audioslave ", "AUDIOSLAVE"));
            Assert.False(SuspiciousTitleFallback.EqualsNormalized("Cochise", "Audioslave"));
        }

        [Theory]
        [InlineData("Cochise", 1, true)]
        [InlineData("Like a Stone", 4, true)]
        [InlineData("Track 05", 0, false)]
        [InlineData("track 05", 5, false)]
        [InlineData("Untitled", 1, false)]
        [InlineData("12", 1, false)]
        [InlineData("", 1, false)]
        [InlineData("Gasoline", 0, false)]
        public void IsMeaningfulFilenameTitle_RequiresNumberedDescriptiveStem(
            string title,
            int trackNumber,
            bool expected)
        {
            Assert.Equal(expected, SuspiciousTitleFallback.IsMeaningfulFilenameTitle(title, trackNumber));
        }

        [Fact]
        public void ResolveTitles_FallsBack_WhenSharedArtistAlbumPlaceholder()
        {
            SuspiciousTitleFallback.Candidate[] album =
            [
                C("Audioslave", "Cochise", 1, "Audioslave", "Audioslave"),
                C("Audioslave", "Gasoline", 3, "Audioslave", "Audioslave"),
                C("Show Me How to Live", "Show Me How to Live", 2, "Audioslave", "Audioslave"),
            ];

            IReadOnlyList<string> titles = SuspiciousTitleFallback.ResolveTitles(album);

            Assert.Equal(["Cochise", "Gasoline", "Show Me How to Live"], titles);
        }

        [Fact]
        public void ResolveTitles_KeepsEmbedded_WhenFilenameMatchesEmbedded()
        {
            SuspiciousTitleFallback.Candidate[] album =
            [
                C("Audioslave", "Audioslave", 1, "Audioslave", "Audioslave"),
                C("Audioslave", "Gasoline", 3, "Audioslave", "Audioslave"),
            ];

            IReadOnlyList<string> titles = SuspiciousTitleFallback.ResolveTitles(album);

            Assert.Equal("Audioslave", titles[0]);
            Assert.Equal("Gasoline", titles[1]);
        }

        [Fact]
        public void ResolveTitles_KeepsEmbedded_ForGenericFilename()
        {
            // Only one meaningful numbered filename in the shared-title cluster → no fallback.
            SuspiciousTitleFallback.Candidate[] album =
            [
                C("Audioslave", "Track 05", 0, "Audioslave", "Audioslave"),
                C("Audioslave", "Gasoline", 3, "Audioslave", "Audioslave"),
            ];

            IReadOnlyList<string> titles = SuspiciousTitleFallback.ResolveTitles(album);

            Assert.Equal(["Audioslave", "Audioslave"], titles);
        }

        [Fact]
        public void ResolveTitles_GenericFilename_DoesNotBlockSiblingFallback_WhenClusterHasTwoMeaningfulNames()
        {
            SuspiciousTitleFallback.Candidate[] album =
            [
                C("Audioslave", "Track 05", 0, "Audioslave", "Audioslave"),
                C("Audioslave", "Cochise", 1, "Audioslave", "Audioslave"),
                C("Audioslave", "Gasoline", 3, "Audioslave", "Audioslave"),
            ];

            IReadOnlyList<string> titles = SuspiciousTitleFallback.ResolveTitles(album);

            Assert.Equal(["Audioslave", "Cochise", "Gasoline"], titles);
        }

        [Fact]
        public void ResolveTitles_KeepsLegitimateLoneAlbumNamedTrack()
        {
            SuspiciousTitleFallback.Candidate[] album =
            [
                C("Audioslave", "Audioslave", 1, "Audioslave", "Audioslave"),
                C("Like a Stone", "Like a Stone", 4, "Audioslave", "Audioslave"),
            ];

            IReadOnlyList<string> titles = SuspiciousTitleFallback.ResolveTitles(album);

            Assert.Equal(["Audioslave", "Like a Stone"], titles);
        }

        [Fact]
        public void ResolveTitles_DoesNotClusterAcrossDifferentAlbumTags()
        {
            SuspiciousTitleFallback.Candidate[] sameDirectory =
            [
                C("Dump", "Alpha", 1, "Dump", "Album A"),
                C("Dump", "Beta", 2, "Dump", "Album A"),
                C("Dump", "Gamma", 1, "Dump", "Album B"),
            ];

            IReadOnlyList<string> titles = SuspiciousTitleFallback.ResolveTitles(sameDirectory);

            Assert.Equal(["Alpha", "Beta", "Dump"], titles);
        }

        [Fact]
        public void ResolveTitles_IsOrderIndependent()
        {
            SuspiciousTitleFallback.Candidate[] forward =
            [
                C("Band", "First", 1, "Band", "Band"),
                C("Band", "Second", 2, "Band", "Band"),
            ];
            SuspiciousTitleFallback.Candidate[] reverse =
            [
                C("Band", "Second", 2, "Band", "Band"),
                C("Band", "First", 1, "Band", "Band"),
            ];

            Assert.Equal(
                SuspiciousTitleFallback.ResolveTitles(forward),
                SuspiciousTitleFallback.ResolveTitles(forward));
            Assert.Equal(["First", "Second"], SuspiciousTitleFallback.ResolveTitles(forward));
            Assert.Equal(["Second", "First"], SuspiciousTitleFallback.ResolveTitles(reverse));
        }

        [Fact]
        public void ResolveTitles_UsesFilename_WhenEmbeddedMissing()
        {
            SuspiciousTitleFallback.Candidate[] album =
            [
                C(null, "From File", 1, "Artist", "Album"),
            ];

            Assert.Equal(["From File"], SuspiciousTitleFallback.ResolveTitles(album));
        }
    }

    public sealed class SuspiciousTitleScanTests : IDisposable
    {
        private readonly string root;
        private readonly string artworkRoot;

        public SuspiciousTitleScanTests()
        {
            root = MetadataTestFixtures.CreateTempMusicRoot();
            artworkRoot = Path.Combine(root, "_artwork");
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
        public void Scan_CorrectsSharedPlaceholderTitles_FromNumberedFilenames()
        {
            string albumDir = Path.Combine(root, "Audioslave", "Audioslave");
            string path1 = MetadataTestFixtures.WriteSilentWav(
                albumDir, "01 Cochise.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 1);
            string path2 = MetadataTestFixtures.WriteSilentWav(
                albumDir, "02 Show Me How to Live.wav", title: "Show Me How to Live", artist: "Audioslave", album: "Audioslave", trackNumber: 2);
            string path3 = MetadataTestFixtures.WriteSilentWav(
                albumDir, "03 Gasoline.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 3);

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Equal(3, library.Tracks.Count);
            Assert.Equal("Cochise", TitleOf(library, path1));
            Assert.Equal("Show Me How to Live", TitleOf(library, path2));
            Assert.Equal("Gasoline", TitleOf(library, path3));
            Assert.All(library.Tracks, t => Assert.Equal("Audioslave", t.Artist));
            Assert.All(library.Tracks, t => Assert.Equal("Audioslave", t.Album));
        }

        [Fact]
        public void Scan_PreservesCorrectDistinctEmbeddedTitles()
        {
            string albumDir = Path.Combine(root, "Band", "Record");
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "01 One.wav", title: "One", artist: "Band", album: "Record", trackNumber: 1);
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "02 Two.wav", title: "Two", artist: "Band", album: "Record", trackNumber: 2);

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Contains(library.Tracks, t => t.Title == "One");
            Assert.Contains(library.Tracks, t => t.Title == "Two");
        }

        [Fact]
        public void Scan_DoesNotOverride_GenericFilename_Or_MatchingSelfTitledFile()
        {
            string albumDir = Path.Combine(root, "Audioslave", "Audioslave");
            string generic = MetadataTestFixtures.WriteSilentWav(
                albumDir, "Track 05.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 5);
            string selfTitled = MetadataTestFixtures.WriteSilentWav(
                albumDir, "01 Audioslave.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 1);
            string gasoline = MetadataTestFixtures.WriteSilentWav(
                albumDir, "03 Gasoline.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 3);
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "04 Like a Stone.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 4);

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Equal("Audioslave", TitleOf(library, generic));
            Assert.Equal("Audioslave", TitleOf(library, selfTitled));
            Assert.Equal("Gasoline", TitleOf(library, gasoline));
        }

        [Fact]
        public void Scan_KeepsLegitimateSingleTitleMatchingAlbum()
        {
            string albumDir = Path.Combine(root, "Artist", "Hit");
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "01 Hit.wav", title: "Hit", artist: "Artist", album: "Hit", trackNumber: 1);

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Single(library.Tracks);
            Assert.Equal("Hit", library.Tracks[0].Title);
        }

        [Fact]
        public void Scan_UsesFilename_WhenNoEmbeddedTitle()
        {
            string albumDir = Path.Combine(root, "Artist", "Album");
            MetadataTestFixtures.WriteSilentWav(
                albumDir,
                "04 Like a Stone.wav",
                title: null,
                artist: "Artist",
                album: "Album",
                trackNumber: 4,
                writeTitleTag: false);

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Single(library.Tracks);
            Assert.Equal("Like a Stone", library.Tracks[0].Title);
        }

        [Fact]
        public void Scan_MixedFormats_ApplySameFallbackRules()
        {
            string albumDir = Path.Combine(root, "Audioslave", "Audioslave");
            string wav = MetadataTestFixtures.WriteSilentWav(
                albumDir, "01 Cochise.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 1);
            string webm = WebmTestFixtures.WriteAudioOnly(
                albumDir, "03 Gasoline.webm", title: "Audioslave", artist: "Audioslave", album: "Audioslave");

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Equal("Cochise", TitleOf(library, wav));
            Assert.Equal("Gasoline", TitleOf(library, webm));
        }

        [Fact]
        public void Scan_TrackIdsStable_AfterTitleCorrection()
        {
            string albumDir = Path.Combine(root, "Audioslave", "Audioslave");
            string path1 = MetadataTestFixtures.WriteSilentWav(
                albumDir, "01 Cochise.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 1);
            string path2 = MetadataTestFixtures.WriteSilentWav(
                albumDir, "03 Gasoline.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 3);

            string id1 = MusicLibraryScanner.TrackIdForPath(path1);
            string id2 = MusicLibraryScanner.TrackIdForPath(path2);

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Contains(id1, library.Tracks.Select(t => t.Id));
            Assert.Contains(id2, library.Tracks.Select(t => t.Id));
            Assert.Equal("Cochise", library.Tracks.Single(t => t.Id == id1).Title);
            Assert.Equal("Gasoline", library.Tracks.Single(t => t.Id == id2).Title);

            // Playlist-style references keyed by path id remain valid.
            string[] playlistIds = [id1, id2];
            Assert.All(playlistIds, id => Assert.Contains(id, library.Tracks.Select(t => t.Id)));
        }

        [Fact]
        public void Scan_Twice_IsIdempotent_ForTitlesIdsAndFingerprint()
        {
            string albumDir = Path.Combine(root, "Audioslave", "Audioslave");
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "01 Cochise.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 1);
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "03 Gasoline.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 3);
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "02 Show Me How to Live.wav", title: "Show Me How to Live", artist: "Audioslave", album: "Audioslave", trackNumber: 2);

            MusicLibrary first = MusicLibraryScanner.Scan(root, artworkRoot);
            string fingerprint1 = LibraryCacheStore.ComputeFingerprint(first);

            MusicLibrary second = MusicLibraryScanner.Scan(root, artworkRoot);
            string fingerprint2 = LibraryCacheStore.ComputeFingerprint(second);

            Assert.Equal(
                first.Tracks.OrderBy(t => t.Id).Select(t => (t.Id, t.Title)).ToArray(),
                second.Tracks.OrderBy(t => t.Id).Select(t => (t.Id, t.Title)).ToArray());
            Assert.Equal(fingerprint1, fingerprint2);
            // Host DeliverLibraryScan skips library posts when fingerprint is unchanged
            // (unless a manual refresh request id is present).
            Assert.False(string.IsNullOrWhiteSpace(fingerprint1));
        }

        [Fact]
        public void Scan_UpdatesTitlesOnNormalRescan_WithoutReaddingFolders()
        {
            string albumDir = Path.Combine(root, "Audioslave", "Audioslave");
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "01 Cochise.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 1);
            MetadataTestFixtures.WriteSilentWav(
                albumDir, "03 Gasoline.wav", title: "Audioslave", artist: "Audioslave", album: "Audioslave", trackNumber: 3);

            // Full Scan always re-reads tags. Same music root (no remove/re-add) yields
            // corrected titles; fingerprint includes titles so the host can refresh UI.
            MusicLibrary first = MusicLibraryScanner.Scan(root, artworkRoot);
            Assert.Contains(first.Tracks, t => t.Title == "Cochise");
            Assert.Contains(first.Tracks, t => t.Title == "Gasoline");
            string fingerprint = LibraryCacheStore.ComputeFingerprint(first);

            MusicLibrary rescanned = MusicLibraryScanner.Scan(root, artworkRoot);
            Assert.Equal(fingerprint, LibraryCacheStore.ComputeFingerprint(rescanned));
            Assert.Contains(rescanned.Tracks, t => t.Title == "Cochise");
            Assert.Contains(rescanned.Tracks, t => t.Title == "Gasoline");
        }

        [Fact]
        public void Scan_DoesNotClusterUnrelatedAlbums_InSameDirectory()
        {
            string dumpDir = Path.Combine(root, "Dump");
            string alpha = MetadataTestFixtures.WriteSilentWav(
                dumpDir, "01 Alpha.wav", title: "Dump", artist: "Dump", album: "Album A", trackNumber: 1);
            string beta = MetadataTestFixtures.WriteSilentWav(
                dumpDir, "02 Beta.wav", title: "Dump", artist: "Dump", album: "Album A", trackNumber: 2);
            string gamma = MetadataTestFixtures.WriteSilentWav(
                dumpDir, "01 Gamma.wav", title: "Dump", artist: "Dump", album: "Album B", trackNumber: 1);

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            // Fallback clusters by embedded album tag before materialization; EMP still
            // projects one directory-level album title onto TrackInfo.Album.
            Assert.Equal("Alpha", TitleOf(library, alpha));
            Assert.Equal("Beta", TitleOf(library, beta));
            Assert.Equal("Dump", TitleOf(library, gamma));
        }

        private static string TitleOf(MusicLibrary library, string fullPath)
        {
            string id = MusicLibraryScanner.TrackIdForPath(fullPath);
            return library.Tracks.Single(t => t.Id == id).Title;
        }
    }
}
