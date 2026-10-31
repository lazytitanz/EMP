namespace EMP.Library.Metadata
{
    internal static class LibraryMetadataPatcher
    {
        public static MusicLibrary PatchTracks(
            MusicLibrary current,
            IReadOnlyList<string> successfulTrackIds,
            string artworkRoot,
            bool regenerateAlbumCover,
            string? albumIdForCover,
            MetadataArtworkOp albumCoverOp,
            byte[]? albumCoverBytes,
            string? albumCoverMime)
        {
            ArgumentNullException.ThrowIfNull(current);
            ArgumentNullException.ThrowIfNull(successfulTrackIds);

            HashSet<string> success = new(successfulTrackIds, StringComparer.OrdinalIgnoreCase);
            if (success.Count == 0)
            {
                return current;
            }

            Dictionary<string, LibraryMediaLocation> locations = new(current.Locations, StringComparer.OrdinalIgnoreCase);
            List<TrackInfo> tracks = [];
            HashSet<string> touchedAlbumIds = new(StringComparer.OrdinalIgnoreCase);

            foreach (TrackInfo track in current.Tracks)
            {
                if (!success.Contains(track.Id) || !locations.TryGetValue(track.Id, out LibraryMediaLocation? location))
                {
                    tracks.Add(track);
                    continue;
                }

                EditableTrackMetadata embedded = MetadataRawTagReader.Read(
                    track.Id,
                    location,
                    track.AlbumId,
                    track.Title,
                    track.Artist,
                    track.Album,
                    track.CoverUrl,
                    busy: false,
                    busyReason: null);

                string title = embedded.Title.HasEmbedded
                    ? embedded.Title.Value ?? track.Title
                    : track.Title;
                string artist = embedded.Artist.HasEmbedded
                    ? embedded.Artist.Value ?? track.Artist
                    : (embedded.AlbumArtist.HasEmbedded ? embedded.AlbumArtist.Value ?? track.Artist : track.Artist);
                string album = embedded.Album.HasEmbedded
                    ? embedded.Album.Value ?? track.Album
                    : track.Album;
                int trackNumber = embedded.TrackNumber.HasEmbedded
                    && int.TryParse(embedded.TrackNumber.Value, out int parsedTrack)
                        ? parsedTrack
                        : track.TrackNumber;

                string? genre = embedded.Genre.HasEmbedded
                    ? embedded.Genre.Value
                    : track.Genre;
                string? albumArtist = embedded.AlbumArtist.HasEmbedded
                    ? embedded.AlbumArtist.Value
                    : track.AlbumArtist;
                int? year = track.Year;
                if (embedded.Year.HasEmbedded)
                {
                    year = int.TryParse(embedded.Year.Value, out int parsedYear) && parsedYear > 0
                        ? parsedYear
                        : null;
                }

                tracks.Add(new TrackInfo
                {
                    Id = track.Id,
                    Title = title,
                    Artist = artist,
                    Album = album,
                    AlbumId = track.AlbumId,
                    TrackNumber = trackNumber,
                    Duration = track.Duration,
                    Url = track.Url,
                    CoverUrl = track.CoverUrl,
                    IsSingle = track.IsSingle,
                    Genre = genre,
                    AlbumArtist = albumArtist,
                    Format = track.Format,
                    Year = year,
                    DateAdded = track.DateAdded,
                    ReplayGainTrackGain = embedded.ReplayGainTrackGain ?? track.ReplayGainTrackGain,
                    ReplayGainTrackPeak = embedded.ReplayGainTrackPeak ?? track.ReplayGainTrackPeak,
                    ReplayGainAlbumGain = embedded.ReplayGainAlbumGain ?? track.ReplayGainAlbumGain,
                    ReplayGainAlbumPeak = embedded.ReplayGainAlbumPeak ?? track.ReplayGainAlbumPeak
                });

                locations[track.Id] = new LibraryMediaLocation
                {
                    TrackId = track.Id,
                    FullPath = location.FullPath,
                    RootPath = location.RootPath,
                    Title = title,
                    Artist = artist,
                    Album = album,
                    Duration = location.Duration,
                    ArtworkPath = location.ArtworkPath
                };

                if (!string.IsNullOrWhiteSpace(track.AlbumId))
                {
                    touchedAlbumIds.Add(track.AlbumId);
                }
            }

            string? newCoverUrl = null;
            if (regenerateAlbumCover && !string.IsNullOrWhiteSpace(albumIdForCover))
            {
                if (albumCoverOp == MetadataArtworkOp.Clear)
                {
                    AlbumArtworkCache.DeleteAlbumCovers(artworkRoot, albumIdForCover);
                    newCoverUrl = null;
                }
                else if (albumCoverOp == MetadataArtworkOp.Set
                    && albumCoverBytes is not null
                    && !string.IsNullOrWhiteSpace(albumCoverMime))
                {
                    newCoverUrl = AlbumArtworkCache.WriteAlbumCover(
                        artworkRoot,
                        albumIdForCover,
                        albumCoverBytes,
                        albumCoverMime);
                }
            }

            List<AlbumInfo> albums = PatchAlbums(current.Albums, tracks, touchedAlbumIds, albumIdForCover, newCoverUrl, regenerateAlbumCover);
            List<AlbumInfo> singles = PatchAlbums(current.Singles, tracks, touchedAlbumIds, albumIdForCover, newCoverUrl, regenerateAlbumCover);

            if (regenerateAlbumCover && !string.IsNullOrWhiteSpace(albumIdForCover))
            {
                for (int i = 0; i < tracks.Count; i++)
                {
                    if (string.Equals(tracks[i].AlbumId, albumIdForCover, StringComparison.OrdinalIgnoreCase))
                    {
                        TrackInfo t = tracks[i];
                        tracks[i] = new TrackInfo
                        {
                            Id = t.Id,
                            Title = t.Title,
                            Artist = t.Artist,
                            Album = t.Album,
                            AlbumId = t.AlbumId,
                            TrackNumber = t.TrackNumber,
                            Duration = t.Duration,
                            Url = t.Url,
                            CoverUrl = newCoverUrl,
                            IsSingle = t.IsSingle,
                            ReplayGainTrackGain = t.ReplayGainTrackGain,
                            ReplayGainTrackPeak = t.ReplayGainTrackPeak,
                            ReplayGainAlbumGain = t.ReplayGainAlbumGain,
                            ReplayGainAlbumPeak = t.ReplayGainAlbumPeak
                        };

                        if (locations.TryGetValue(t.Id, out LibraryMediaLocation? loc))
                        {
                            string? artPath = null;
                            if (!string.IsNullOrWhiteSpace(newCoverUrl))
                            {
                                string? stripped = AlbumArtworkCache.StripCoverUrlQuery(newCoverUrl);
                                string fileName = Path.GetFileName((stripped ?? "").Replace('/', Path.DirectorySeparatorChar));
                                artPath = Path.Combine(artworkRoot, fileName);
                            }

                            locations[t.Id] = new LibraryMediaLocation
                            {
                                TrackId = loc.TrackId,
                                FullPath = loc.FullPath,
                                RootPath = loc.RootPath,
                                Title = loc.Title,
                                Artist = loc.Artist,
                                Album = loc.Album,
                                Duration = loc.Duration,
                                ArtworkPath = artPath
                            };
                        }
                    }
                }
            }

            return new MusicLibrary
            {
                RootPath = current.RootPath,
                Folders = current.Folders,
                Albums = albums,
                Singles = singles,
                Tracks = tracks,
                Locations = locations
            };
        }

        private static List<AlbumInfo> PatchAlbums(
            IReadOnlyList<AlbumInfo> albums,
            IReadOnlyList<TrackInfo> tracks,
            HashSet<string> touchedAlbumIds,
            string? albumIdForCover,
            string? newCoverUrl,
            bool regenerateAlbumCover)
        {
            List<AlbumInfo> result = [];
            foreach (AlbumInfo album in albums)
            {
                if (!touchedAlbumIds.Contains(album.Id))
                {
                    result.Add(album);
                    continue;
                }

                List<TrackInfo> albumTracks = tracks
                    .Where(track => string.Equals(track.AlbumId, album.Id, StringComparison.OrdinalIgnoreCase))
                    .OrderBy(track => track.TrackNumber)
                    .ThenBy(track => track.Title, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                string title = albumTracks
                    .Select(track => track.Album)
                    .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
                    ?? album.Title;
                string artist = albumTracks
                    .Select(track => track.Artist)
                    .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
                    ?? album.Artist;

                string? cover = album.CoverUrl;
                if (regenerateAlbumCover
                    && string.Equals(album.Id, albumIdForCover, StringComparison.OrdinalIgnoreCase))
                {
                    cover = newCoverUrl;
                }

                result.Add(new AlbumInfo
                {
                    Id = album.Id,
                    Title = title,
                    Artist = artist,
                    CoverUrl = cover,
                    Color = album.Color,
                    TrackCount = albumTracks.Count,
                    Year = album.Year,
                    IsSingle = album.IsSingle,
                    TrackIds = albumTracks.Select(track => track.Id).ToArray()
                });
            }

            return result;
        }
    }
}
