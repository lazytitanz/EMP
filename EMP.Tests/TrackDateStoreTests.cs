using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    public sealed class TrackDateStoreTests : IDisposable
    {
        private readonly string root;
        private readonly string datesPath;

        public TrackDateStoreTests()
        {
            root = Path.Combine(Path.GetTempPath(), "EMP-track-dates-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            datesPath = Path.Combine(root, "track-dates.json");
            TrackDateStore.SetFilePathForTests(datesPath);
        }

        public void Dispose()
        {
            TrackDateStore.SetFilePathForTests(null);
            try
            {
                if (Directory.Exists(root))
                {
                    Directory.Delete(root, recursive: true);
                }
            }
            catch (Exception)
            {
                // Best-effort temp cleanup.
            }
        }

        [Fact]
        public void ApplyAndPersist_AssignsNowForNewTrackIds()
        {
            MusicLibrary library = SampleLibrary("track1");
            long now = 1_700_000_000_000;

            MusicLibrary hydrated = TrackDateStore.ApplyAndPersist(library, now);

            Assert.Equal(now, hydrated.Tracks[0].DateAdded);
            Assert.True(File.Exists(datesPath));
            Dictionary<string, long> loaded = TrackDateStore.Load();
            Assert.Equal(now, loaded["track1"]);
        }

        [Fact]
        public void ApplyAndPersist_PreservesExistingTimestampsAcrossRescan()
        {
            long original = 1_600_000_000_000;
            TrackDateStore.Save(new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase)
            {
                ["track1"] = original
            });

            MusicLibrary rescanned = SampleLibrary("track1");
            MusicLibrary hydrated = TrackDateStore.ApplyAndPersist(rescanned, nowUnixMs: 1_900_000_000_000);

            Assert.Equal(original, hydrated.Tracks[0].DateAdded);
            Assert.Equal(original, TrackDateStore.Load()["track1"]);
        }

        [Fact]
        public void ApplyAndPersist_SurvivesLibraryCacheDeletion()
        {
            long original = 1_650_000_000_000;
            _ = TrackDateStore.ApplyAndPersist(SampleLibrary("track1"), original);

            string cachePath = Path.Combine(root, "library-cache.json");
            File.WriteAllText(cachePath, "{}");
            File.Delete(cachePath);

            MusicLibrary again = TrackDateStore.ApplyAndPersist(SampleLibrary("track1"), nowUnixMs: 2_000_000_000_000);
            Assert.Equal(original, again.Tracks[0].DateAdded);
        }

        [Fact]
        public void NewTrackIds_GetFreshTimestamps_ExistingPreserved()
        {
            long first = 1_700_000_000_000;
            _ = TrackDateStore.ApplyAndPersist(SampleLibrary("track1"), first);

            MusicLibrary both = new()
            {
                RootPath = @"C:\Music",
                Folders = [new LibraryFolderInfo { Path = @"C:\Music", Available = true }],
                Albums = [],
                Singles = [],
                Tracks =
                [
                    MakeTrack("track1"),
                    MakeTrack("track2")
                ],
                Locations = new Dictionary<string, LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
            };

            long later = 1_800_000_000_000;
            MusicLibrary hydrated = TrackDateStore.ApplyAndPersist(both, later);
            Dictionary<string, long> byId = hydrated.Tracks.ToDictionary(t => t.Id, t => t.DateAdded);

            Assert.Equal(first, byId["track1"]);
            Assert.Equal(later, byId["track2"]);
        }

        private static MusicLibrary SampleLibrary(string trackId)
        {
            return new MusicLibrary
            {
                RootPath = @"C:\Music",
                Folders = [new LibraryFolderInfo { Path = @"C:\Music", Available = true }],
                Albums = [],
                Singles = [],
                Tracks = [MakeTrack(trackId)],
                Locations = new Dictionary<string, LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
            };
        }

        private static TrackInfo MakeTrack(string id) => new()
        {
            Id = id,
            Title = "Song",
            Artist = "Artist",
            Album = "Album",
            AlbumId = "album1",
            TrackNumber = 1,
            Duration = 120,
            Url = "https://music.emp/a.mp3",
            Format = "mp3",
            DateAdded = 0
        };
    }
}
