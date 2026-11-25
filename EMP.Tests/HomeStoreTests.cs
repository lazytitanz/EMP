using System.Text.Json;
using EMP.Hosting;
using Xunit;

namespace EMP.Tests
{
    public sealed class HomeStoreTests : IDisposable
    {
        private readonly string root;
        private readonly string homePath;

        public HomeStoreTests()
        {
            root = Path.Combine(Path.GetTempPath(), "EMP-home-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            homePath = Path.Combine(root, "home.json");
            // Long debounce: tests flush explicitly so timing never matters.
            HomeStore.SetFilePathForTests(homePath, TimeSpan.FromMinutes(10));
        }

        public void Dispose()
        {
            HomeStore.SetFilePathForTests(null);
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (Exception)
            {
                // Best-effort temp cleanup.
            }
        }

        [Fact]
        public void MissingFile_BootstrapsNull()
        {
            Assert.Null(HomeStore.CurrentJson);
            Assert.Equal("window.__emp = window.__emp || {}; window.__emp.home = null;", HomeStore.DocumentCreatedAssignment());
        }

        [Fact]
        public void Update_IsDebounced_UntilFlush()
        {
            Assert.True(HomeStore.Update(Parse("{\"version\":1,\"pins\":[{\"kind\":\"playlist\",\"id\":\"pl_liked\"}]}")));

            Assert.True(HomeStore.HasPendingWrite);
            Assert.False(File.Exists(homePath));

            HomeStore.FlushSync();

            Assert.False(HomeStore.HasPendingWrite);
            Assert.True(File.Exists(homePath));
        }

        [Fact]
        public void FlushedDocument_RoundTripsAfterRestart()
        {
            HomeStore.Update(Parse("{\"version\":1,\"pins\":[{\"kind\":\"album\",\"id\":\"a1\"}]}"));
            HomeStore.FlushSync();

            HomeStore.SetFilePathForTests(homePath, TimeSpan.FromMinutes(10));

            using JsonDocument reloaded = JsonDocument.Parse(HomeStore.CurrentJson!);
            Assert.Equal("a1", reloaded.RootElement.GetProperty("pins")[0].GetProperty("id").GetString());
        }

        [Fact]
        public void Update_RejectsNonObjectsAndOversizedPayloads()
        {
            HomeStore.Update(Parse("{\"version\":1}"));

            Assert.False(HomeStore.Update(Parse("[1,2,3]")));
            string huge = "{\"blob\":\"" + new string('x', HomeStore.MaxDocumentBytes) + "\"}";
            Assert.False(HomeStore.Update(Parse(huge)));

            Assert.Equal("{\"version\":1}", HomeStore.CurrentJson);
        }

        [Fact]
        public void CorruptPrimary_FallsBackToBackup()
        {
            HomeStore.Update(Parse("{\"version\":1,\"tag\":\"first\"}"));
            HomeStore.FlushSync();
            HomeStore.Update(Parse("{\"version\":1,\"tag\":\"second\"}"));
            HomeStore.FlushSync();

            File.WriteAllText(homePath, "{ not json");
            HomeStore.SetFilePathForTests(homePath, TimeSpan.FromMinutes(10));

            using JsonDocument restored = JsonDocument.Parse(HomeStore.CurrentJson!);
            Assert.Equal("first", restored.RootElement.GetProperty("tag").GetString());
        }

        [Fact]
        public void HomeFile_DoesNotTouchPlaylistStorage()
        {
            HomeStore.Update(Parse("{\"version\":1}"));
            HomeStore.FlushSync();

            Assert.Equal(new[] { "home.json" }, Directory.GetFiles(root).Select(Path.GetFileName).ToArray());
        }

        private static JsonElement Parse(string json)
        {
            using JsonDocument document = JsonDocument.Parse(json);
            return document.RootElement.Clone();
        }
    }

    public sealed class HomeAlbumFolderTests
    {
        [Fact]
        public void BuildAlbumFolders_UsesWatchedRoot_WithTildeForProfile()
        {
            EMP.Library.MusicLibrary library = new()
            {
                Albums =
                [
                    new EMP.Library.AlbumInfo { Id = "a1", TrackIds = ["t1"] },
                    new EMP.Library.AlbumInfo { Id = "a2", TrackIds = ["t2"] },
                    new EMP.Library.AlbumInfo { Id = "a3", TrackIds = ["missing"] }
                ],
                Singles = [new EMP.Library.AlbumInfo { Id = "s1", TrackIds = ["t3"] }],
                Locations = new Dictionary<string, EMP.Library.LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
                {
                    ["t1"] = Location("t1", @"C:\Users\pat\Music\Imports\x.flac", @"C:\Users\pat\Music\Imports"),
                    ["t2"] = Location("t2", @"D:\Archive\y.mp3", @"D:\Archive\"),
                    ["t3"] = Location("t3", @"C:\Users\pat\Music\z.mp3", @"C:\Users\pat\Music")
                }
            };

            Dictionary<string, string> folders = WebUiHost.BuildAlbumFolders(library, @"C:\Users\pat");

            Assert.Equal("~/Music/Imports", folders["a1"]);
            Assert.Equal("D:/Archive", folders["a2"]);
            Assert.Equal("~/Music", folders["s1"]);
            Assert.False(folders.ContainsKey("a3"));
        }

        [Fact]
        public void BuildAlbumFolders_DoesNotTreatSiblingPrefixAsProfile()
        {
            EMP.Library.MusicLibrary library = new()
            {
                Albums = [new EMP.Library.AlbumInfo { Id = "a1", TrackIds = ["t1"] }],
                Locations = new Dictionary<string, EMP.Library.LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
                {
                    ["t1"] = Location("t1", @"C:\Users\patrick\Music\x.mp3", @"C:\Users\patrick\Music")
                }
            };

            Assert.Equal("C:/Users/patrick/Music", WebUiHost.BuildAlbumFolders(library, @"C:\Users\pat")["a1"]);
        }

        [Fact]
        public void BuildAlbumRoots_CollectsEveryRootAcrossTracks_IncludingNestedFiles()
        {
            EMP.Library.MusicLibrary library = new()
            {
                Albums =
                [
                    new EMP.Library.AlbumInfo { Id = "a1", TrackIds = ["t1", "t2", "t3"] },
                    new EMP.Library.AlbumInfo { Id = "a2", TrackIds = ["missing"] }
                ],
                Singles = [new EMP.Library.AlbumInfo { Id = "s1", TrackIds = ["t4"] }],
                Locations = new Dictionary<string, EMP.Library.LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
                {
                    ["t1"] = Location("t1", @"D:\Music\Artist\Album\01.flac", @"D:\Music"),
                    ["t2"] = Location("t2", @"D:\Music\Artist\Album\CD2\02.flac", @"D:\music\"),
                    ["t3"] = Location("t3", @"E:\Extra\03.flac", @"E:\Extra"),
                    ["t4"] = Location("t4", @"D:\Music\Deep\Nested\Dir\x.mp3", @"D:\Music")
                }
            };

            Dictionary<string, string[]> roots = WebUiHost.BuildAlbumRoots(library);

            Assert.Equal([@"D:\Music", @"E:\Extra"], roots["a1"]);
            Assert.Equal([@"D:\Music"], roots["s1"]);
            Assert.False(roots.ContainsKey("a2"));
        }

        private static EMP.Library.LibraryMediaLocation Location(string id, string fullPath, string root) => new()
        {
            TrackId = id,
            FullPath = fullPath,
            RootPath = root,
            Title = "t",
            Artist = "a",
            Album = "b"
        };
    }

    [Collection("ListenStatsPaths")]
    public sealed class HomeTopTracksTests : IDisposable
    {
        private readonly string root;

        public HomeTopTracksTests()
        {
            root = Path.Combine(Path.GetTempPath(), "EMP-home-top-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            ListenStatsPaths.SetRootForTests(root);
            ListenStatsCoordinator.ResetForTests();
        }

        public void Dispose()
        {
            ListenStatsCoordinator.ResetForTests();
            ListenStatsPaths.SetRootForTests(null);
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (Exception)
            {
                // Best-effort temp cleanup.
            }
        }

        [Fact]
        public void Build_CountsOnlyQualifiedPlaysInsideTheCalendarMonth()
        {
            Play("a", new DateTime(2026, 10, 31, 23, 30, 0), 9);
            Play("a", new DateTime(2026, 11, 1, 0, 5, 0), 2);
            Play("b", new DateTime(2026, 11, 15, 12, 0, 0), 3);
            Play("c", new DateTime(2026, 12, 1, 8, 0, 0), 7);
            ListenHistoryStore.ApplyEntry("listenOnly", 0, 0, new Dictionary<string, long> { ["2026-11-10"] = 60_000 });

            HomeTopTracksResult result = HomeTopTracks.Build(2026, 11, libraryTrackIds: null);

            Assert.Equal("2026-11", result.Month);
            Assert.Equal("2026-11-01", result.StartDate);
            Assert.Equal("2026-11-30", result.EndDate);
            Assert.Equal(new[] { "b", "a" }, result.Tracks.Select(t => t.TrackId).ToArray());
            Assert.Equal(new long[] { 3, 2 }, result.Tracks.Select(t => t.PlayCount).ToArray());
        }

        [Fact]
        public void Build_ExcludesTracksNoLongerInLibrary_AndCapsAtLimit()
        {
            for (int i = 0; i < 8; i++)
            {
                Play("t" + i, new DateTime(2026, 11, 2), 10 - i);
            }

            HashSet<string> library = new(StringComparer.OrdinalIgnoreCase) { "t1", "t2", "t3", "t4", "t5", "t6", "t7" };
            HomeTopTracksResult result = HomeTopTracks.Build(2026, 11, library, limit: 5);

            Assert.Equal(new[] { "t1", "t2", "t3", "t4", "t5" }, result.Tracks.Select(t => t.TrackId).ToArray());
        }

        [Fact]
        public void PartialCoverage_ReportedOnlyWhenTrackingStartedMidMonth()
        {
            Assert.Equal("2026-11-12", HomeTopTracks.PartialCoverageStart("2026-11-12", "2026-11-01", "2026-11-30"));
            Assert.Null(HomeTopTracks.PartialCoverageStart("2026-11-01", "2026-11-01", "2026-11-30"));
            Assert.Null(HomeTopTracks.PartialCoverageStart("2026-10-03", "2026-11-01", "2026-11-30"));
            Assert.Null(HomeTopTracks.PartialCoverageStart(null, "2026-11-01", "2026-11-30"));
        }

        [Theory]
        [InlineData("2026-11", true)]
        [InlineData("2026-1", false)]
        [InlineData("2026-13", false)]
        [InlineData("nope!!!", false)]
        [InlineData(null, false)]
        public void TryParseMonth_ValidatesKeys(string? key, bool expected)
        {
            Assert.Equal(expected, HomeTopTracks.TryParseMonth(key, out _, out _));
        }

        private static void Play(string trackId, DateTime localTime, int count)
        {
            long at = new DateTimeOffset(DateTime.SpecifyKind(localTime, DateTimeKind.Local)).ToUnixTimeMilliseconds();
            ListenHistoryStore.ApplyEntry(trackId, count, at, dayListenMsDelta: null);
        }
    }
}
