namespace EMP.Library.Metadata
{
    internal static class MetadataRawTagReader
    {
        public static EditableTrackMetadata Read(
            string trackId,
            LibraryMediaLocation location,
            string? albumId,
            string? displayTitle,
            string? displayArtist,
            string? displayAlbum,
            string? albumCoverUrl,
            bool busy,
            string? busyReason,
            MetadataErrorCode? preError = null)
        {
            string path = location.FullPath;
            string fileName = Path.GetFileName(path);
            string extension = Path.GetExtension(path);

            if (preError is MetadataErrorCode code && code != MetadataErrorCode.None)
            {
                return new EditableTrackMetadata
                {
                    TrackId = trackId,
                    FileName = fileName,
                    Extension = extension,
                    Exists = File.Exists(path),
                    Busy = busy,
                    BusyReason = busyReason,
                    ErrorCode = code,
                    ErrorMessage = MetadataErrorMessages.For(code),
                    AlbumId = albumId,
                    DisplayTitle = displayTitle,
                    DisplayArtist = displayArtist,
                    DisplayAlbum = displayAlbum,
                    AlbumCoverUrl = albumCoverUrl
                };
            }

            if (!File.Exists(path))
            {
                return new EditableTrackMetadata
                {
                    TrackId = trackId,
                    FileName = fileName,
                    Extension = extension,
                    Exists = false,
                    ErrorCode = MetadataErrorCode.NotFound,
                    ErrorMessage = MetadataErrorMessages.For(MetadataErrorCode.NotFound),
                    AlbumId = albumId,
                    DisplayTitle = displayTitle,
                    DisplayArtist = displayArtist,
                    DisplayAlbum = displayAlbum,
                    AlbumCoverUrl = albumCoverUrl
                };
            }

            FileInfo info = new(path);
            bool readOnly = info.IsReadOnly;
            EditableTrackMetadata result = new()
            {
                TrackId = trackId,
                FileName = fileName,
                Extension = extension,
                Exists = true,
                ReadOnly = readOnly,
                Busy = busy,
                BusyReason = busyReason,
                LastWriteUtcTicks = info.LastWriteTimeUtc.Ticks,
                Length = info.Length,
                AlbumId = albumId,
                DisplayTitle = displayTitle,
                DisplayArtist = displayArtist,
                DisplayAlbum = displayAlbum,
                AlbumCoverUrl = albumCoverUrl,
                CanEditTags = false,
                CanEditArtwork = false
            };

            if (busy)
            {
                MetadataErrorCode busyCode = string.Equals(busyReason, "casting", StringComparison.OrdinalIgnoreCase)
                    ? MetadataErrorCode.BusyCasting
                    : MetadataErrorCode.BusyPlaying;
                return new EditableTrackMetadata
                {
                    TrackId = result.TrackId,
                    FileName = result.FileName,
                    Extension = result.Extension,
                    Exists = result.Exists,
                    ReadOnly = result.ReadOnly,
                    Busy = true,
                    BusyReason = MetadataErrorMessages.For(busyCode),
                    ErrorCode = busyCode,
                    ErrorMessage = MetadataErrorMessages.For(busyCode),
                    LastWriteUtcTicks = result.LastWriteUtcTicks,
                    Length = result.Length,
                    AlbumId = albumId,
                    DisplayTitle = displayTitle,
                    DisplayArtist = displayArtist,
                    DisplayAlbum = displayAlbum,
                    AlbumCoverUrl = albumCoverUrl
                };
            }

            try
            {
                using TagLib.File file = TagLib.File.Create(path);
                ReplayGainInfo replayGain = ReplayGainParser.FromTagLib(
                    file.Tag.ReplayGainTrackGain,
                    file.Tag.ReplayGainTrackPeak,
                    file.Tag.ReplayGainAlbumGain,
                    file.Tag.ReplayGainAlbumPeak);

                TagLib.IPicture? picture = file.Tag.Pictures.FirstOrDefault(item => item.Data.Count > 0);
                string? preview = null;
                if (picture is not null)
                {
                    string mime = string.IsNullOrWhiteSpace(picture.MimeType) ? "image/jpeg" : picture.MimeType;
                    preview = "data:" + mime + ";base64," + Convert.ToBase64String(picture.Data.Data);
                }

                bool canEdit = !readOnly && !file.PossiblyCorrupt;
                return new EditableTrackMetadata
                {
                    TrackId = trackId,
                    FileName = fileName,
                    Extension = extension,
                    Exists = true,
                    ReadOnly = readOnly,
                    CanEditTags = canEdit,
                    CanEditArtwork = canEdit,
                    Busy = false,
                    LastWriteUtcTicks = info.LastWriteTimeUtc.Ticks,
                    Length = info.Length,
                    AlbumId = albumId,
                    DisplayTitle = displayTitle,
                    DisplayArtist = displayArtist,
                    DisplayAlbum = displayAlbum,
                    AlbumCoverUrl = albumCoverUrl,
                    Title = Field(file.Tag.Title),
                    Artist = Field(file.Tag.FirstPerformer),
                    AlbumArtist = Field(file.Tag.FirstAlbumArtist),
                    Album = Field(file.Tag.Album),
                    TrackNumber = file.Tag.Track > 0 ? Field(file.Tag.Track.ToString()) : new MetadataFieldValue(),
                    DiscNumber = file.Tag.Disc > 0 ? Field(file.Tag.Disc.ToString()) : new MetadataFieldValue(),
                    Genre = Field(file.Tag.FirstGenre),
                    Year = file.Tag.Year > 0 ? Field(file.Tag.Year.ToString()) : new MetadataFieldValue(),
                    Comment = Field(file.Tag.Comment),
                    Artwork = new MetadataArtworkInfo
                    {
                        Present = picture is not null,
                        Mime = picture?.MimeType,
                        PreviewDataUrl = preview
                    },
                    ReplayGainTrackGain = replayGain.TrackGainDb,
                    ReplayGainTrackPeak = replayGain.TrackPeak,
                    ReplayGainAlbumGain = replayGain.AlbumGainDb,
                    ReplayGainAlbumPeak = replayGain.AlbumPeak
                };
            }
            catch (Exception)
            {
                return new EditableTrackMetadata
                {
                    TrackId = trackId,
                    FileName = fileName,
                    Extension = extension,
                    Exists = true,
                    ReadOnly = readOnly,
                    CanEditTags = false,
                    CanEditArtwork = false,
                    ErrorCode = MetadataErrorCode.Unsupported,
                    ErrorMessage = MetadataErrorMessages.For(MetadataErrorCode.Unsupported),
                    LastWriteUtcTicks = info.LastWriteTimeUtc.Ticks,
                    Length = info.Length,
                    AlbumId = albumId,
                    DisplayTitle = displayTitle,
                    DisplayArtist = displayArtist,
                    DisplayAlbum = displayAlbum,
                    AlbumCoverUrl = albumCoverUrl
                };
            }
        }

        private static MetadataFieldValue Field(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return new MetadataFieldValue();
            }

            return new MetadataFieldValue
            {
                Value = value.Trim(),
                HasEmbedded = true
            };
        }
    }
}
