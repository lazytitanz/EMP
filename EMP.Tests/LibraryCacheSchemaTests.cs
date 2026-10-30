using System.Text.Json;
using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    public sealed class LibraryCacheSchemaTests : IDisposable
    {
        private readonly string root;
        private readonly string cachePath;

        public LibraryCacheSchemaTests()
        {
            root = Path.Combine(Path.GetTempPath(), "EMP-library-cache-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            cachePath = Path.Combine(root, "library-cache.json");
            LibraryCacheStore.SetFilePathForTests(cachePath);
        }

        public void Dispose()
        {
            LibraryCacheStore.SetFilePathForTests(null);
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
        public void SchemaVersion_IsThree()
        {
            Assert.Equal(3, LibraryCacheStore.SchemaVersion);
        }

        [Fact]
        public void ComputeFingerprint_IncludesGenreAlbumArtistFormatYear_ExcludesDateAdded()
        {
            MusicLibrary baseline = SampleLibrary(trackGain: null, albumGain: null);
            MusicLibrary withGenre = WithTrackOverlay(baseline, genre: "Rock");
            MusicLibrary withDateOnly = WithTrackOverlay(baseline, dateAdded: 99);

            Assert.NotEqual(
                LibraryCacheStore.ComputeFingerprint(baseline),
                LibraryCacheStore.ComputeFingerprint(withGenre));
            Assert.Equal(
                LibraryCacheStore.ComputeFingerprint(baseline),
                LibraryCacheStore.ComputeFingerprint(withDateOnly));
        }

        [Fact]
        public void ComputeFingerprint_IncludesReplayGainFields()
        {
            MusicLibrary withoutRg = SampleLibrary(trackGain: null, albumGain: null);
            MusicLibrary withRg = SampleLibrary(trackGain: -2.5, albumGain: -3.1);

            string left = LibraryCacheStore.ComputeFingerprint(withoutRg);
            string right = LibraryCacheStore.ComputeFingerprint(withRg);

            Assert.NotEqual(left, right);
        }

        [Fact]
        public void SchemaMismatch_DoesNotDeleteListenStatsOrPlaylistSidecars()
        {
            string listenStats = Path.Combine(root, "listen-stats.json");
            string listenHistory = Path.Combine(root, "listen-history.json");
            string playlistsSidecar = Path.Combine(root, "playlists-marker.json");
            File.WriteAllText(listenStats, "{\"ok\":true}");
            File.WriteAllText(listenHistory, "{\"ok\":true}");
            File.WriteAllText(playlistsSidecar, "{\"playlists\":[]}");

            string envelope = JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                folderPaths = Array.Empty<string>(),
                contentFingerprint = "abc",
                rootPath = "",
                folders = Array.Empty<object>(),
                albums = Array.Empty<object>(),
                singles = Array.Empty<object>(),
                tracks = Array.Empty<object>(),
                locations = Array.Empty<object>()
            });
            File.WriteAllText(cachePath, envelope);

            CachedMusicLibrary? loaded = LibraryCacheStore.TryLoad([]);
            Assert.Null(loaded);

            Assert.True(File.Exists(listenStats));
            Assert.True(File.Exists(listenHistory));
            Assert.True(File.Exists(playlistsSidecar));
            Assert.Equal("{\"ok\":true}", File.ReadAllText(listenStats));
            Assert.True(File.Exists(cachePath));
        }

        private static MusicLibrary SampleLibrary(double? trackGain, double? albumGain)
        {
            TrackInfo track = new()
            {
                Id = "track1",
                Title = "Song",
                Artist = "Artist",
                Album = "Album",
                AlbumId = "album1",
                TrackNumber = 1,
                Duration = 120,
                Url = "https://music.emp/a.mp3",
                CoverUrl = null,
                IsSingle = false,
                Genre = null,
                AlbumArtist = null,
                Format = "mp3",
                Year = 2001,
                DateAdded = 0,
                ReplayGainTrackGain = trackGain,
                ReplayGainTrackPeak = trackGain is null ? null : 0.95,
                ReplayGainAlbumGain = albumGain,
                ReplayGainAlbumPeak = albumGain is null ? null : 0.9
            };

            return new MusicLibrary
            {
                RootPath = @"C:\Music",
                Folders = [new LibraryFolderInfo { Path = @"C:\Music", Available = true }],
                Albums =
                [
                    new AlbumInfo
                    {
                        Id = "album1",
                        Title = "Album",
                        Artist = "Artist",
                        TrackCount = 1,
                        TrackIds = ["track1"]
                    }
                ],
                Singles = [],
                Tracks = [track],
                Locations = new Dictionary<string, LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
                {
                    ["track1"] = new LibraryMediaLocation
                    {
                        TrackId = "track1",
                        FullPath = @"C:\Music\a.mp3",
                        RootPath = @"C:\Music",
                        Title = "Song",
                        Artist = "Artist",
                        Album = "Album",
                        Duration = 120
                    }
                }
            };
        }

        private static MusicLibrary WithTrackOverlay(
            MusicLibrary source,
            string? genre = null,
            long? dateAdded = null)
        {
            TrackInfo track = source.Tracks[0];
            TrackInfo updated = new()
            {
                Id = track.Id,
                Title = track.Title,
                Artist = track.Artist,
                Album = track.Album,
                AlbumId = track.AlbumId,
                TrackNumber = track.TrackNumber,
                Duration = track.Duration,
                Url = track.Url,
                CoverUrl = track.CoverUrl,
                IsSingle = track.IsSingle,
                Genre = genre ?? track.Genre,
                AlbumArtist = track.AlbumArtist,
                Format = track.Format,
                Year = track.Year,
                DateAdded = dateAdded ?? track.DateAdded,
                ReplayGainTrackGain = track.ReplayGainTrackGain,
                ReplayGainTrackPeak = track.ReplayGainTrackPeak,
                ReplayGainAlbumGain = track.ReplayGainAlbumGain,
                ReplayGainAlbumPeak = track.ReplayGainAlbumPeak
            };

            return new MusicLibrary
            {
                RootPath = source.RootPath,
                Folders = source.Folders,
                Albums = source.Albums,
                Singles = source.Singles,
                Tracks = [updated],
                Locations = source.Locations
            };
        }
    }
}
