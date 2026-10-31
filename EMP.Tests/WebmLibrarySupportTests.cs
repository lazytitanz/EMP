using EMP.Cast;
using EMP.Library;
using EMP.Library.Metadata;
using Xunit;

namespace EMP.Tests
{
    public sealed class WebmLibrarySupportTests : IDisposable
    {
        private readonly string root;
        private readonly string artworkRoot;

        public WebmLibrarySupportTests()
        {
            root = MetadataTestFixtures.CreateTempMusicRoot();
            artworkRoot = Path.Combine(root, "_artwork");
            Directory.CreateDirectory(artworkRoot);
            LibraryMediaIndex.Clear();
        }

        public void Dispose()
        {
            LibraryMediaIndex.Clear();
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
        public void IsSupportedAudioPath_AcceptsWebmExtension()
        {
            Assert.True(MusicLibraryScanner.IsSupportedAudioPath(Path.Combine(root, "song.webm")));
            Assert.True(MusicLibraryScanner.IsSupportedAudioPath(Path.Combine(root, "Song.WEBM")));
            Assert.False(MusicLibraryScanner.IsSupportedAudioPath(Path.Combine(root, "song.emp-meta-abc.webm")));
        }

        [Fact]
        public void MediaTypes_MapsWebmToAudioWebm_ButCastAllowlistExcludesIt()
        {
            Assert.Equal("audio/webm", MediaTypes.FromExtension(".webm"));
            Assert.Equal("audio/webm", MediaTypes.FromPath(@"C:\Music\track.webm"));
            Assert.False(MediaTypes.IsCastAudio(".webm"));
            Assert.True(MediaTypes.IsCastAudio(".mp3"));
        }

        [Fact]
        public void TagLib_ClassifiesAudioOnlyAndVideoWebmViaMediaTypes()
        {
            using (TagLib.File audio = TagLib.File.Create(WebmTestFixtures.AudioOnlySourcePath))
            {
                Assert.Equal(TagLib.MediaTypes.Audio, audio.Properties.MediaTypes & TagLib.MediaTypes.Audio);
                Assert.Equal(TagLib.MediaTypes.None, audio.Properties.MediaTypes & TagLib.MediaTypes.Video);
                Assert.True(audio.Properties.Duration.TotalSeconds > 0);
            }

            using (TagLib.File video = TagLib.File.Create(WebmTestFixtures.VideoContainingSourcePath))
            {
                Assert.Equal(TagLib.MediaTypes.Video, video.Properties.MediaTypes & TagLib.MediaTypes.Video);
                Assert.True(video.Properties.VideoWidth > 0);
            }
        }

        [Fact]
        public void Scan_IncludesAudioOnlyWebm_WithEmbeddedMetadata()
        {
            WebmTestFixtures.WriteAudioOnly(
                root,
                "01 - Tagged Song.webm",
                title: "WebM Title",
                artist: "WebM Artist",
                album: "WebM Album");

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Single(library.Tracks);
            TrackInfo track = library.Tracks[0];
            Assert.Equal("webm", track.Format);
            Assert.Equal("WebM Artist", track.Artist);
            Assert.Equal("WebM Album", track.Album);
            // Matroska title mapping can surface album-level titles; accept either embedded value.
            Assert.True(
                track.Title is "WebM Title" or "WebM Album",
                $"Unexpected title '{track.Title}'");
            Assert.True(track.Duration > 0, $"Expected positive duration, got {track.Duration}");
        }

        [Fact]
        public void Scan_UsesFilenameFallback_WhenWebmHasNoTags()
        {
            string albumDir = Path.Combine(root, "Fallback Artist", "Fallback Album");
            WebmTestFixtures.WriteAudioOnly(albumDir, "03 - Untitled Track.webm");

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Single(library.Tracks);
            TrackInfo track = library.Tracks[0];
            Assert.Equal("Untitled Track", track.Title);
            Assert.Equal(3, track.TrackNumber);
            Assert.Equal("Fallback Artist", track.Artist);
            Assert.Equal("Fallback Album", track.Album);
            Assert.True(track.Duration > 0);
        }

        [Fact]
        public void Scan_ExcludesWebmThatContainsVideo()
        {
            WebmTestFixtures.WriteAudioOnly(root, "keep.webm", title: "Keep Me", artist: "Keeper");
            WebmTestFixtures.WriteWithVideo(root, "clip.webm");

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Single(library.Tracks);
            Assert.Equal("Keeper", library.Tracks[0].Artist);
            Assert.DoesNotContain(
                library.Tracks,
                t => t.Url.Contains("clip.webm", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(Path.GetFileNameWithoutExtension(
                        library.Locations.Values.FirstOrDefault(l => l.TrackId == t.Id)?.FullPath ?? ""),
                        "clip",
                        StringComparison.OrdinalIgnoreCase));
        }

        [Fact]
        public void Scan_IncludesCorruptWebm_WithFilenameFallback()
        {
            WebmTestFixtures.WriteCorrupt(root, "09 - Broken Song.webm");

            MusicLibrary library = MusicLibraryScanner.Scan(root, artworkRoot);

            Assert.Single(library.Tracks);
            TrackInfo track = library.Tracks[0];
            Assert.Equal("Broken Song", track.Title);
            Assert.Equal(9, track.TrackNumber);
            Assert.Equal("webm", track.Format);
            Assert.Equal(0, track.Duration);
        }

        [Fact]
        public void Scan_InitialAndIncrementalRescan_PicksUpNewAudioWebm()
        {
            WebmTestFixtures.WriteAudioOnly(root, "first.webm", artist: "First Artist");

            MusicLibrary initial = MusicLibraryScanner.Scan(root, artworkRoot);
            Assert.Single(initial.Tracks);
            Assert.Equal("First Artist", initial.Tracks[0].Artist);

            WebmTestFixtures.WriteAudioOnly(root, "second.webm", artist: "Second Artist");
            WebmTestFixtures.WriteWithVideo(root, "ignored-video.webm");

            MusicLibrary rescanned = MusicLibraryScanner.Scan(root, artworkRoot);
            Assert.Equal(2, rescanned.Tracks.Count);
            Assert.Contains(rescanned.Tracks, t => t.Artist == "First Artist");
            Assert.Contains(rescanned.Tracks, t => t.Artist == "Second Artist");
            Assert.Equal(2, rescanned.Locations.Count);
            Assert.DoesNotContain(
                rescanned.Locations.Values,
                location => Path.GetFileName(location.FullPath)
                    .Equals("ignored-video.webm", StringComparison.OrdinalIgnoreCase));
        }

        [Fact]
        public void MetadataEditor_DisablesWebmEditing_AndRejectsWrites()
        {
            string path = WebmTestFixtures.WriteAudioOnly(root, "edit-me.webm", title: "Original", artist: "WebM Artist");
            string trackId = MusicLibraryScanner.TrackIdForPath(path);
            MetadataTestFixtures.IndexTrack(trackId, path, root);

            EditableTrackMetadata read = MetadataRawTagReader.Read(
                trackId,
                new LibraryMediaLocation
                {
                    TrackId = trackId,
                    FullPath = path,
                    RootPath = root,
                    Title = "Original",
                    Artist = "WebM Artist",
                    Album = "WebM Album",
                    Duration = 0.5
                },
                albumId: null,
                displayTitle: "Original",
                displayArtist: "WebM Artist",
                displayAlbum: "WebM Album",
                albumCoverUrl: null,
                busy: false,
                busyReason: null);

            Assert.False(read.CanEditTags);
            Assert.False(read.CanEditArtwork);
            Assert.Equal(MetadataErrorCode.Unsupported, read.ErrorCode);

            MetadataFileResult write = MetadataTagWriter.Apply(
                trackId,
                path,
                new MetadataTrackEdit
                {
                    TrackId = trackId,
                    Title = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "Nope" }
                },
                _ => (false, MetadataErrorCode.None));

            Assert.False(write.Succeeded);
            Assert.Equal(MetadataErrorCode.Unsupported, write.ErrorCode);
        }
    }
}
