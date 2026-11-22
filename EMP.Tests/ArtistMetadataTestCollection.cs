using Xunit;

namespace EMP.Tests
{
    /// <summary>
    /// MusicBrainzClient / ArtistImageCache tests share process-wide static roots and HTTP clients.
    /// </summary>
    [CollectionDefinition(Name, DisableParallelization = true)]
    public sealed class ArtistMetadataTestCollection
    {
        public const string Name = "ArtistMetadata";
    }
}
