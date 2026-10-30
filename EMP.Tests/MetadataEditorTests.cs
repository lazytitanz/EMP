using EMP.Library;
using EMP.Library.Metadata;
using Xunit;

namespace EMP.Tests
{
    public sealed class MetadataEditorTests : IDisposable
    {
        private readonly string root;
        private readonly string artworkRoot;

        public MetadataEditorTests()
        {
            root = MetadataTestFixtures.CreateTempMusicRoot();
            artworkRoot = Path.Combine(root, "artwork");
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
        public void Apply_TitleChange_PreservesReplayGainAndTrackId()
        {
            string path = MetadataTestFixtures.WriteSilentWav(root, "track.wav", "Original");
            string trackId = MusicLibraryScanner.TrackIdForPath(path);
            MetadataTestFixtures.IndexTrack(trackId, path, root);

            MetadataFileResult result = MetadataTagWriter.Apply(
                trackId,
                path,
                new MetadataTrackEdit
                {
                    TrackId = trackId,
                    Title = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "Updated Title" }
                },
                _ => (false, MetadataErrorCode.None));

            Assert.True(result.Succeeded, result.ErrorMessage);
            Assert.Equal(trackId, MusicLibraryScanner.TrackIdForPath(path));

            using TagLib.File file = TagLib.File.Create(path);
            Assert.Equal("Updated Title", file.Tag.Title);
            Assert.Equal(-3.5, file.Tag.ReplayGainTrackGain, 3);
            Assert.Equal(0.95, file.Tag.ReplayGainTrackPeak, 3);
            Assert.Equal(-4.0, file.Tag.ReplayGainAlbumGain, 3);
            Assert.Equal(0.97, file.Tag.ReplayGainAlbumPeak, 3);
            Assert.Empty(Directory.GetFiles(root, "*.emp-meta-*", SearchOption.AllDirectories));
        }

        [Fact]
        public void Apply_DoesNotWriteUnspecifiedFields()
        {
            string path = MetadataTestFixtures.WriteSilentWav(root, "keep.wav", "Keep Title");
            string trackId = MusicLibraryScanner.TrackIdForPath(path);
            MetadataTestFixtures.IndexTrack(trackId, path, root);

            MetadataFileResult result = MetadataTagWriter.Apply(
                trackId,
                path,
                new MetadataTrackEdit
                {
                    TrackId = trackId,
                    Genre = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "Jazz" }
                },
                _ => (false, MetadataErrorCode.None));

            Assert.True(result.Succeeded, result.ErrorMessage);
            using TagLib.File file = TagLib.File.Create(path);
            Assert.Equal("Keep Title", file.Tag.Title);
            Assert.Equal("Jazz", file.Tag.FirstGenre);
            Assert.Equal("Fixture Artist", file.Tag.FirstPerformer);
        }

        [Fact]
        public void Apply_RejectsUnauthorizedPath()
        {
            MetadataEditorService service = new();
            IReadOnlyList<EditableTrackMetadata> got = service.Get(
                ["missing-id"],
                [root],
                _ => (false, null, MetadataErrorCode.None),
                _ => null);

            Assert.Single(got);
            Assert.Equal(MetadataErrorCode.NotFound, got[0].ErrorCode);
        }

        [Fact]
        public void Apply_RejectsReadOnlyFile()
        {
            string path = MetadataTestFixtures.WriteSilentWav(root, "readonly.wav", "RO");
            File.SetAttributes(path, FileAttributes.ReadOnly);
            string trackId = MusicLibraryScanner.TrackIdForPath(path);

            MetadataFileResult result = MetadataTagWriter.Apply(
                trackId,
                path,
                new MetadataTrackEdit
                {
                    TrackId = trackId,
                    Title = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "Nope" }
                },
                _ => (false, MetadataErrorCode.None));

            Assert.False(result.Succeeded);
            Assert.Equal(MetadataErrorCode.ReadOnly, result.ErrorCode);
            File.SetAttributes(path, FileAttributes.Normal);
        }

        [Fact]
        public void Apply_RejectsExternalChange()
        {
            string path = MetadataTestFixtures.WriteSilentWav(root, "changed.wav", "A");
            string trackId = MusicLibraryScanner.TrackIdForPath(path);
            FileInfo info = new(path);
            long expectedTicks = info.LastWriteTimeUtc.Ticks;
            long expectedLength = info.Length;

            Thread.Sleep(20);
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(1));

            MetadataFileResult result = MetadataTagWriter.Apply(
                trackId,
                path,
                new MetadataTrackEdit
                {
                    TrackId = trackId,
                    ExpectedLastWriteUtcTicks = expectedTicks,
                    ExpectedLength = expectedLength,
                    Title = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "B" }
                },
                _ => (false, MetadataErrorCode.None));

            Assert.False(result.Succeeded);
            Assert.Equal(MetadataErrorCode.ExternalChange, result.ErrorCode);
        }

        [Fact]
        public void Apply_RejectsBusyPlaying()
        {
            string path = MetadataTestFixtures.WriteSilentWav(root, "busy.wav", "Busy");
            string trackId = MusicLibraryScanner.TrackIdForPath(path);

            MetadataFileResult result = MetadataTagWriter.Apply(
                trackId,
                path,
                new MetadataTrackEdit
                {
                    TrackId = trackId,
                    Title = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "X" }
                },
                _ => (true, MetadataErrorCode.BusyPlaying));

            Assert.False(result.Succeeded);
            Assert.Equal(MetadataErrorCode.BusyPlaying, result.ErrorCode);
        }

        [Fact]
        public void Apply_ArtworkSetAndClear()
        {
            string path = MetadataTestFixtures.WriteSilentWav(root, "art.wav", "Art");
            string trackId = MusicLibraryScanner.TrackIdForPath(path);
            byte[] png = MetadataTestFixtures.TinyPng();

            MetadataFileResult setResult = MetadataTagWriter.Apply(
                trackId,
                path,
                new MetadataTrackEdit
                {
                    TrackId = trackId,
                    Artwork = new MetadataArtworkEdit
                    {
                        Op = MetadataArtworkOp.Set,
                        Mime = "image/png",
                        DataBase64 = Convert.ToBase64String(png)
                    }
                },
                _ => (false, MetadataErrorCode.None));

            Assert.True(setResult.Succeeded, setResult.ErrorMessage);
            Assert.True(setResult.ArtworkChanged);

            using (TagLib.File file = TagLib.File.Create(path))
            {
                Assert.NotEmpty(file.Tag.Pictures);
            }

            MetadataFileResult clearResult = MetadataTagWriter.Apply(
                trackId,
                path,
                new MetadataTrackEdit
                {
                    TrackId = trackId,
                    Artwork = new MetadataArtworkEdit { Op = MetadataArtworkOp.Clear }
                },
                _ => (false, MetadataErrorCode.None));

            Assert.True(clearResult.Succeeded, clearResult.ErrorMessage);
            using (TagLib.File file = TagLib.File.Create(path))
            {
                Assert.Empty(file.Tag.Pictures);
            }
        }

        [Fact]
        public void Batch_PreservesDifferingTitlesWhenSettingAlbum()
        {
            string pathA = MetadataTestFixtures.WriteSilentWav(root, "a.wav", "Title A");
            string pathB = MetadataTestFixtures.WriteSilentWav(root, "b.wav", "Title B");
            string idA = MusicLibraryScanner.TrackIdForPath(pathA);
            string idB = MusicLibraryScanner.TrackIdForPath(pathB);
            LibraryMediaIndex.Replace(new Dictionary<string, LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
            {
                [idA] = new LibraryMediaLocation
                {
                    TrackId = idA,
                    FullPath = pathA,
                    RootPath = root,
                    Title = "Title A",
                    Artist = "Fixture Artist",
                    Album = "Fixture Album",
                    Duration = 0.1
                },
                [idB] = new LibraryMediaLocation
                {
                    TrackId = idB,
                    FullPath = pathB,
                    RootPath = root,
                    Title = "Title B",
                    Artist = "Fixture Artist",
                    Album = "Fixture Album",
                    Duration = 0.1
                }
            });

            MetadataEditorService service = new();
            Assert.True(service.TryBeginApply(out _));
            MetadataApplySummary summary = service.ApplySequential(
                "req",
                [
                    new MetadataTrackEdit
                    {
                        TrackId = idA,
                        Album = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "Shared Album" }
                    },
                    new MetadataTrackEdit
                    {
                        TrackId = idB,
                        Album = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "Shared Album" }
                    }
                ],
                [root],
                _ => (false, MetadataErrorCode.None),
                (_, _, _, _, _) => { },
                CancellationToken.None);
            service.EndApply();

            Assert.Equal(2, summary.Succeeded);
            using TagLib.File fileA = TagLib.File.Create(pathA);
            using TagLib.File fileB = TagLib.File.Create(pathB);
            Assert.Equal("Title A", fileA.Tag.Title);
            Assert.Equal("Title B", fileB.Tag.Title);
            Assert.Equal("Shared Album", fileA.Tag.Album);
            Assert.Equal("Shared Album", fileB.Tag.Album);
        }

        [Fact]
        public void ScanCoordinator_DefersWatcherDuringMetadataEdit()
        {
            LibraryScanCoordinator coordinator = new();
            int started = 0;
            coordinator.BeginMetadataEditSession();
            Assert.True(coordinator.TryDeferWatcherRefresh());
            coordinator.Request(null, _ => started++);
            Assert.Equal(0, started);
            bool needsFull = coordinator.EndMetadataEditSession(editedPathsFullyPatched: true);
            Assert.False(needsFull);
            coordinator.Shutdown();
        }

        [Fact]
        public void AlbumArtworkCache_SingleTrackDoesNotQualifyForRegeneration()
        {
            Assert.False(AlbumArtworkCache.ShouldRegenerateAlbumCover(["a", "b", "c"], ["a"]));
            Assert.True(AlbumArtworkCache.ShouldRegenerateAlbumCover(["a", "b"], ["b", "a"]));
        }

        [Fact]
        public void ArtworkValidator_AcceptsTinyPng()
        {
            Assert.True(ArtworkImageValidator.TryValidate(
                MetadataTestFixtures.TinyPng(),
                "image/png",
                out string mime,
                out _));
            Assert.Equal("image/png", mime);
        }

        [Fact]
        public void ArtworkValidator_RejectsGarbage()
        {
            Assert.False(ArtworkImageValidator.TryValidate([1, 2, 3, 4], "image/png", out _, out _));
        }

        [Fact]
        public void Apply_CancelBetweenFiles_LeavesRemainingUntouched()
        {
            string pathA = MetadataTestFixtures.WriteSilentWav(root, "c1.wav", "One");
            string pathB = MetadataTestFixtures.WriteSilentWav(root, "c2.wav", "Two");
            string idA = MusicLibraryScanner.TrackIdForPath(pathA);
            string idB = MusicLibraryScanner.TrackIdForPath(pathB);
            LibraryMediaIndex.Replace(new Dictionary<string, LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
            {
                [idA] = new LibraryMediaLocation
                {
                    TrackId = idA,
                    FullPath = pathA,
                    RootPath = root,
                    Title = "One",
                    Artist = "Fixture Artist",
                    Album = "Fixture Album",
                    Duration = 0.1
                },
                [idB] = new LibraryMediaLocation
                {
                    TrackId = idB,
                    FullPath = pathB,
                    RootPath = root,
                    Title = "Two",
                    Artist = "Fixture Artist",
                    Album = "Fixture Album",
                    Duration = 0.1
                }
            });

            using CancellationTokenSource cts = new();
            MetadataEditorService service = new();
            Assert.True(service.TryBeginApply(out _));
            int seen = 0;
            MetadataApplySummary summary = service.ApplySequential(
                "cancel",
                [
                    new MetadataTrackEdit
                    {
                        TrackId = idA,
                        Title = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "One*" }
                    },
                    new MetadataTrackEdit
                    {
                        TrackId = idB,
                        Title = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "Two*" }
                    }
                ],
                [root],
                _ => (false, MetadataErrorCode.None),
                (_, _, _, _, _) =>
                {
                    seen++;
                    if (seen == 1)
                    {
                        cts.Cancel();
                    }
                },
                cts.Token);
            service.EndApply();

            Assert.True(summary.Cancelled);
            Assert.Equal(1, summary.Succeeded);
            using TagLib.File fileA = TagLib.File.Create(pathA);
            using TagLib.File fileB = TagLib.File.Create(pathB);
            Assert.Equal("One*", fileA.Tag.Title);
            Assert.Equal("Two", fileB.Tag.Title);
        }

        [Fact]
        public void TrackIdentity_StableForPlaylistAndStatsKeys()
        {
            string path = MetadataTestFixtures.WriteSilentWav(root, "stable.wav", "Stable");
            string before = MusicLibraryScanner.TrackIdForPath(path);
            MetadataTestFixtures.IndexTrack(before, path, root);

            MetadataFileResult result = MetadataTagWriter.Apply(
                before,
                path,
                new MetadataTrackEdit
                {
                    TrackId = before,
                    Title = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "Renamed" },
                    Album = new MetadataFieldEdit { Op = MetadataFieldOp.Set, Value = "New Album" }
                },
                _ => (false, MetadataErrorCode.None));

            Assert.True(result.Succeeded, result.ErrorMessage);
            string after = MusicLibraryScanner.TrackIdForPath(path);
            Assert.Equal(before, after);

            // Playlist / queue / listen-stats all key by this id — unchanged path hash keeps them valid.
            string[] playlistIds = [before];
            Assert.Contains(after, playlistIds);
            Dictionary<string, int> listenStats = new(StringComparer.OrdinalIgnoreCase) { [before] = 3 };
            Assert.True(listenStats.ContainsKey(after));
            string[] queue = [before];
            Assert.Equal(before, queue[0]);
        }

        [Fact]
        public void StagingFiles_AreNotSupportedAudioPaths()
        {
            Assert.False(MusicLibraryScanner.IsSupportedAudioPath(Path.Combine(root, "song.emp-meta-abc.wav")));
            Assert.True(MusicLibraryScanner.IsIgnoredWatchPath(Path.Combine(root, "song.emp-meta-abc.wav")));
        }
    }
}
