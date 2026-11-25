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

        [Fact]
        public void FreshInstall_FirstScanBecomesBaseline_LaterAdditionsAreAfterIt()
        {
            long first = 1_700_000_000_000;
            _ = TrackDateStore.ApplyAndPersist(SampleLibrary("track1"), first);

            Assert.Equal(first, TrackDateStore.LoadBaselineAt());
            Assert.Equal(first, TrackDateStore.CurrentBaselineAt);

            long later = 1_800_000_000_000;
            MusicLibrary hydrated = TrackDateStore.ApplyAndPersist(LibraryWith("track1", "track2"), later);

            Assert.Equal(first, TrackDateStore.LoadBaselineAt());
            Assert.True(hydrated.Tracks.Single(t => t.Id == "track2").DateAdded > TrackDateStore.CurrentBaselineAt);
            Assert.False(hydrated.Tracks.Single(t => t.Id == "track1").DateAdded > TrackDateStore.CurrentBaselineAt);
        }

        [Fact]
        public void EmptyLibrary_DoesNotCreateBaseline()
        {
            MusicLibrary empty = LibraryWith();
            _ = TrackDateStore.ApplyAndPersist(empty, 1_700_000_000_000);

            Assert.Equal(0, TrackDateStore.CurrentBaselineAt);
            Assert.False(File.Exists(datesPath));
        }

        [Fact]
        public void V1Upgrade_InfersBaselineFromEarliestDate_AndKeepsEveryEntry()
        {
            long baseline = 1_600_000_000_000;
            long addedLater = 1_650_000_000_000;
            WriteV1File(new Dictionary<string, long>
            {
                ["track1"] = baseline,
                ["track2"] = baseline,
                ["track3"] = addedLater,
                ["gone"] = baseline
            });
            string v1Text = File.ReadAllText(datesPath);

            _ = TrackDateStore.ApplyAndPersist(LibraryWith("track1", "track2", "track3"), 1_900_000_000_000);

            Assert.Equal(TrackDateStore.SchemaVersion, TrackDateStore.LoadSchemaVersion());
            Assert.Equal(baseline, TrackDateStore.LoadBaselineAt());
            Dictionary<string, long> loaded = TrackDateStore.Load();
            Assert.Equal(4, loaded.Count);
            Assert.Equal(baseline, loaded["gone"]);
            Assert.Equal(addedLater, loaded["track3"]);
            Assert.True(File.Exists(TrackDateStore.LegacyBackupPath));
            Assert.Equal(v1Text, File.ReadAllText(TrackDateStore.LegacyBackupPath));
        }

        [Fact]
        public void V1Upgrade_IsIdempotent()
        {
            long baseline = 1_600_000_000_000;
            WriteV1File(new Dictionary<string, long> { ["track1"] = baseline, ["track2"] = 1_650_000_000_000 });

            _ = TrackDateStore.ApplyAndPersist(LibraryWith("track1", "track2"), 1_900_000_000_000);
            string afterFirst = File.ReadAllText(datesPath);
            DateTime firstWrite = File.GetLastWriteTimeUtc(datesPath);

            _ = TrackDateStore.ApplyAndPersist(LibraryWith("track1", "track2"), 2_000_000_000_000);

            Assert.Equal(afterFirst, File.ReadAllText(datesPath));
            Assert.Equal(firstWrite, File.GetLastWriteTimeUtc(datesPath));
            Assert.Equal(baseline, TrackDateStore.LoadBaselineAt());
        }

        [Fact]
        public void V2File_IsReadableByV1Reader()
        {
            long baseline = 1_600_000_000_000;
            long later = 1_700_000_000_000;
            _ = TrackDateStore.ApplyAndPersist(LibraryWith("track1"), baseline);
            _ = TrackDateStore.ApplyAndPersist(LibraryWith("track1", "track2"), later);

            Dictionary<string, long> seenByV1 = V1Reader.Load(datesPath);

            Assert.Equal(baseline, seenByV1["track1"]);
            Assert.Equal(later, seenByV1["track2"]);
        }

        [Fact]
        public void RewriteByOlderBuild_DropsBaseline_AndV2RederivesTheSameValue()
        {
            long baseline = 1_600_000_000_000;
            _ = TrackDateStore.ApplyAndPersist(LibraryWith("track1"), baseline);
            _ = TrackDateStore.ApplyAndPersist(LibraryWith("track1", "track2"), 1_700_000_000_000);

            // An older build loads and re-saves in its own v1 shape (no baselineAt).
            Dictionary<string, long> viaOld = V1Reader.Load(datesPath);
            viaOld["track3"] = 1_750_000_000_000;
            WriteV1File(viaOld);
            Assert.Equal(0, TrackDateStore.LoadBaselineAt());

            _ = TrackDateStore.ApplyAndPersist(LibraryWith("track1", "track2", "track3"), 1_800_000_000_000);

            Assert.Equal(baseline, TrackDateStore.LoadBaselineAt());
            Assert.Equal(3, TrackDateStore.Load().Count);
        }

        private void WriteV1File(IReadOnlyDictionary<string, long> dates)
        {
            var tracks = dates.ToDictionary(pair => pair.Key, pair => new { dateAdded = pair.Value });
            File.WriteAllText(datesPath, System.Text.Json.JsonSerializer.Serialize(new { schemaVersion = 1, tracks }));
        }

        /// <summary>Verbatim shape of the v1 (0.4.3) reader: default options, no schema check.</summary>
        private static class V1Reader
        {
            private static readonly System.Text.Json.JsonSerializerOptions Options = new()
            {
                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
                WriteIndented = false
            };

            public static Dictionary<string, long> Load(string path)
            {
                Envelope? envelope = System.Text.Json.JsonSerializer.Deserialize<Envelope>(File.ReadAllText(path), Options);
                Dictionary<string, long> result = new(StringComparer.OrdinalIgnoreCase);
                foreach ((string id, Entry? entry) in envelope?.Tracks ?? [])
                {
                    if (entry is not null && entry.DateAdded > 0)
                    {
                        result[id] = entry.DateAdded;
                    }
                }

                return result;
            }

            private sealed class Envelope
            {
                public int SchemaVersion { get; init; }

                public Dictionary<string, Entry>? Tracks { get; init; }
            }

            private sealed class Entry
            {
                public long DateAdded { get; init; }
            }
        }

        private static MusicLibrary LibraryWith(params string[] trackIds)
        {
            return new MusicLibrary
            {
                RootPath = @"C:\Music",
                Folders = [new LibraryFolderInfo { Path = @"C:\Music", Available = true }],
                Albums = [],
                Singles = [],
                Tracks = trackIds.Select(MakeTrack).ToList(),
                Locations = new Dictionary<string, LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
            };
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
