namespace EMP.Library
{
    internal sealed class LibraryFolderInfo
    {
        public required string Path { get; init; }

        public required bool Available { get; init; }
    }

    internal sealed class MusicLibrary
    {
        public string RootPath { get; init; } = string.Empty;

        public IReadOnlyList<LibraryFolderInfo> Folders { get; init; } = [];

        public IReadOnlyList<AlbumInfo> Albums { get; init; } = [];

        public IReadOnlyList<AlbumInfo> Singles { get; init; } = [];

        public IReadOnlyList<TrackInfo> Tracks { get; init; } = [];

        public IReadOnlyDictionary<string, LibraryMediaLocation> Locations { get; init; } =
            new Dictionary<string, LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase);
    }

    internal sealed class LibraryMediaLocation
    {
        public required string TrackId { get; init; }

        public required string FullPath { get; init; }

        public required string RootPath { get; init; }

        public required string Title { get; init; }

        public required string Artist { get; init; }

        public required string Album { get; init; }

        public double Duration { get; init; }

        public string? ArtworkPath { get; init; }
    }

    internal sealed class AlbumInfo
    {
        public string Id { get; init; } = string.Empty;

        public string Title { get; init; } = string.Empty;

        public string Artist { get; init; } = string.Empty;

        public string? CoverUrl { get; init; }

        public string Color { get; init; } = "#1db954";

        public int TrackCount { get; init; }

        public int? Year { get; init; }

        public bool IsSingle { get; init; }

        public IReadOnlyList<string> TrackIds { get; init; } = [];
    }

    internal sealed class TrackInfo
    {
        public string Id { get; init; } = string.Empty;

        public string Title { get; init; } = string.Empty;

        public string Artist { get; init; } = string.Empty;

        public string Album { get; init; } = string.Empty;

        public string AlbumId { get; init; } = string.Empty;

        public int TrackNumber { get; init; }

        public double Duration { get; init; }

        public string Url { get; init; } = string.Empty;

        public string? CoverUrl { get; init; }

        public bool IsSingle { get; init; }
    }
}
