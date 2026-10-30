namespace EMP.Library.Metadata
{
    internal enum MetadataFieldOp
    {
        Keep = 0,
        Set = 1,
        Clear = 2
    }

    internal enum MetadataArtworkOp
    {
        Keep = 0,
        Set = 1,
        Clear = 2
    }

    internal enum MetadataErrorCode
    {
        None = 0,
        NotFound,
        Unauthorized,
        ReadOnly,
        ReadOnlyFolder,
        Unsupported,
        ExternalChange,
        BusyPlaying,
        BusyCasting,
        InsufficientSpace,
        InvalidImage,
        WriteFailed,
        Cancelled,
        NoChanges,
        EditInProgress,
        InvalidRequest
    }

    internal sealed class MetadataFieldValue
    {
        public string? Value { get; init; }

        public bool HasEmbedded { get; init; }
    }

    internal sealed class MetadataArtworkInfo
    {
        public bool Present { get; init; }

        public string? Mime { get; init; }

        public string? PreviewDataUrl { get; init; }
    }

    internal sealed class EditableTrackMetadata
    {
        public required string TrackId { get; init; }

        public required string FileName { get; init; }

        public required string Extension { get; init; }

        public bool Exists { get; init; }

        public bool ReadOnly { get; init; }

        public bool CanEditTags { get; init; }

        public bool CanEditArtwork { get; init; }

        public bool Busy { get; init; }

        public string? BusyReason { get; init; }

        public MetadataErrorCode? ErrorCode { get; init; }

        public string? ErrorMessage { get; init; }

        public long LastWriteUtcTicks { get; init; }

        public long Length { get; init; }

        public string? AlbumId { get; init; }

        public string? DisplayTitle { get; init; }

        public string? DisplayArtist { get; init; }

        public string? DisplayAlbum { get; init; }

        public string? AlbumCoverUrl { get; init; }

        public MetadataFieldValue Title { get; init; } = new();

        public MetadataFieldValue Artist { get; init; } = new();

        public MetadataFieldValue AlbumArtist { get; init; } = new();

        public MetadataFieldValue Album { get; init; } = new();

        public MetadataFieldValue TrackNumber { get; init; } = new();

        public MetadataFieldValue DiscNumber { get; init; } = new();

        public MetadataFieldValue Genre { get; init; } = new();

        public MetadataFieldValue Year { get; init; } = new();

        public MetadataFieldValue Comment { get; init; } = new();

        public MetadataArtworkInfo Artwork { get; init; } = new();

        public double? ReplayGainTrackGain { get; init; }

        public double? ReplayGainTrackPeak { get; init; }

        public double? ReplayGainAlbumGain { get; init; }

        public double? ReplayGainAlbumPeak { get; init; }
    }

    internal sealed class MetadataFieldEdit
    {
        public MetadataFieldOp Op { get; init; } = MetadataFieldOp.Keep;

        public string? Value { get; init; }
    }

    internal sealed class MetadataArtworkEdit
    {
        public MetadataArtworkOp Op { get; init; } = MetadataArtworkOp.Keep;

        public string? Mime { get; init; }

        public string? DataBase64 { get; init; }
    }

    internal sealed class MetadataTrackEdit
    {
        public required string TrackId { get; init; }

        public long? ExpectedLastWriteUtcTicks { get; init; }

        public long? ExpectedLength { get; init; }

        public MetadataFieldEdit? Title { get; init; }

        public MetadataFieldEdit? Artist { get; init; }

        public MetadataFieldEdit? AlbumArtist { get; init; }

        public MetadataFieldEdit? Album { get; init; }

        public MetadataFieldEdit? TrackNumber { get; init; }

        public MetadataFieldEdit? DiscNumber { get; init; }

        public MetadataFieldEdit? Genre { get; init; }

        public MetadataFieldEdit? Year { get; init; }

        public MetadataFieldEdit? Comment { get; init; }

        public MetadataArtworkEdit? Artwork { get; init; }
    }

    internal sealed class MetadataFileResult
    {
        public required string TrackId { get; init; }

        public bool Succeeded { get; init; }

        public MetadataErrorCode ErrorCode { get; init; }

        public string? ErrorMessage { get; init; }

        public bool ArtworkChanged { get; init; }

        public EditableTrackMetadata? Updated { get; init; }
    }

    internal sealed class MetadataApplySummary
    {
        public required string RequestId { get; init; }

        public int Total { get; init; }

        public int Succeeded { get; init; }

        public int Failed { get; init; }

        public bool Cancelled { get; init; }

        public bool AlbumCoverRegenerated { get; init; }

        public IReadOnlyList<MetadataFileResult> Files { get; init; } = [];
    }

    internal static class MetadataErrorMessages
    {
        public static string For(MetadataErrorCode code) => code switch
        {
            MetadataErrorCode.NotFound => "This file could not be found.",
            MetadataErrorCode.Unauthorized => "This file is outside your music library folders.",
            MetadataErrorCode.ReadOnly => "This file is read-only and cannot be edited.",
            MetadataErrorCode.ReadOnlyFolder => "This folder is read-only, so the file cannot be updated.",
            MetadataErrorCode.Unsupported => "This file format does not support metadata editing.",
            MetadataErrorCode.ExternalChange => "This file changed on disk while the editor was open. Reopen it and try again.",
            MetadataErrorCode.BusyPlaying => "This song is currently playing. Stop playback or wait until it finishes, then try again.",
            MetadataErrorCode.BusyCasting => "This song is being cast to another device. Stop casting it, then try again.",
            MetadataErrorCode.InsufficientSpace => "There is not enough free disk space to update this file safely.",
            MetadataErrorCode.InvalidImage => "The selected image is not a valid JPEG or PNG, or it is too large.",
            MetadataErrorCode.WriteFailed => "EMP could not write metadata to this file.",
            MetadataErrorCode.Cancelled => "The update was cancelled.",
            MetadataErrorCode.NoChanges => "There are no changes to apply.",
            MetadataErrorCode.EditInProgress => "Another metadata update is already in progress.",
            MetadataErrorCode.InvalidRequest => "The metadata request was invalid.",
            _ => "Something went wrong while updating metadata."
        };
    }
}
