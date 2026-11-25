using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    public sealed class ReleaseTypeTagsTests : IDisposable
    {
        private readonly string root = MetadataTestFixtures.CreateTempMusicRoot();

        public void Dispose()
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (Exception)
            {
                // Temp cleanup is best-effort.
            }
        }

        [Theory]
        [InlineData("album", "album")]
        [InlineData("Album", "album")]
        [InlineData("EP", "ep")]
        [InlineData(" Single ", "single")]
        [InlineData("broadcast", "broadcast")]
        [InlineData("other", "other")]
        public void Normalize_RecognizesPrimaryTypes_CaseInsensitively(string raw, string expected)
        {
            Assert.Equal(expected, ReleaseTypeTags.Normalize([raw]).Primary);
        }

        [Fact]
        public void Normalize_SplitsMultiValuedTags_IntoPrimaryAndSecondary()
        {
            ReleaseClassification semicolon = ReleaseTypeTags.Normalize(["album; compilation"]);
            Assert.Equal("album", semicolon.Primary);
            Assert.Equal(["compilation"], semicolon.Secondary);

            ReleaseClassification nullSeparated = ReleaseTypeTags.Normalize(["album\0live"]);
            Assert.Equal("album", nullSeparated.Primary);
            Assert.Equal(["live"], nullSeparated.Secondary);

            ReleaseClassification separateValues = ReleaseTypeTags.Normalize(["Album", "Soundtrack", "mixtape/street"]);
            Assert.Equal("album", separateValues.Primary);
            Assert.Equal(["soundtrack", "mixtape"], separateValues.Secondary);
        }

        [Fact]
        public void Normalize_SecondaryOnly_HasUnknownPrimary()
        {
            ReleaseClassification result = ReleaseTypeTags.Normalize(["compilation"]);
            Assert.Null(result.Primary);
            Assert.Equal(["compilation"], result.Secondary);
        }

        [Fact]
        public void Normalize_ConflictingPrimaries_AreUnknown()
        {
            Assert.Null(ReleaseTypeTags.Normalize(["album", "single"]).Primary);
            Assert.Null(ReleaseTypeTags.Normalize(["album; ep"]).Primary);
        }

        [Fact]
        public void Normalize_MissingAndUnsupportedValues_AreUnknown()
        {
            Assert.Equal(ReleaseClassification.Unknown.Primary, ReleaseTypeTags.Normalize([]).Primary);
            Assert.Null(ReleaseTypeTags.Normalize([null, "", "  "]).Primary);
            ReleaseClassification unsupported = ReleaseTypeTags.Normalize(["lp", "official"]);
            Assert.Null(unsupported.Primary);
            Assert.Empty(unsupported.Secondary);
        }

        [Fact]
        public void Combine_RequiresAgreement_AndIgnoresUntaggedTracks()
        {
            ReleaseClassification album = new("album", ["live"]);
            ReleaseClassification untagged = ReleaseClassification.Unknown;

            ReleaseClassification agreed = ReleaseTypeTags.Combine([album, untagged, new("album", [])]);
            Assert.Equal("album", agreed.Primary);
            Assert.Equal(["live"], agreed.Secondary);

            Assert.Null(ReleaseTypeTags.Combine([album, new("ep", [])]).Primary);
            Assert.Null(ReleaseTypeTags.Combine([untagged, untagged]).Primary);
            Assert.Null(ReleaseTypeTags.Combine([]).Primary);
        }

        [Fact]
        public void Read_ReturnsId3v2MusicBrainzAlbumType_IncludingMultipleValues()
        {
            string path = MetadataTestFixtures.WriteSilentWav(root, "typed.wav", title: "Typed");
            using (TagLib.File file = TagLib.File.Create(path))
            {
                TagLib.Id3v2.Tag id3 = (TagLib.Id3v2.Tag)file.GetTag(TagLib.TagTypes.Id3v2, true);
                TagLib.Id3v2.UserTextInformationFrame frame =
                    TagLib.Id3v2.UserTextInformationFrame.Get(id3, "MusicBrainz Album Type", true);
                frame.Text = ["album", "compilation"];
                file.Save();
            }

            using TagLib.File reopened = TagLib.File.Create(path);
            ReleaseClassification result = ReleaseTypeTags.Normalize(ReleaseTypeTags.Read(reopened));

            Assert.Equal("album", result.Primary);
            Assert.Contains("compilation", result.Secondary);
        }

        [Fact]
        public void Scan_SetsAlbumReleaseType_FromTags_NeverFromTrackCount()
        {
            string typedDir = Path.Combine(root, "Typed EP");
            string oneFileDir = Path.Combine(root, "Full Album One Track");
            string typed = MetadataTestFixtures.WriteSilentWav(typedDir, "01.wav", title: "One", album: "Typed EP");
            using (TagLib.File file = TagLib.File.Create(typed))
            {
                TagLib.Id3v2.Tag id3 = (TagLib.Id3v2.Tag)file.GetTag(TagLib.TagTypes.Id3v2, true);
                TagLib.Id3v2.UserTextInformationFrame.Get(id3, "MusicBrainz Album Type", true).Text = ["EP"];
                file.Save();
            }
            // One local file from an untagged album: still unknown, never "single".
            MetadataTestFixtures.WriteSilentWav(oneFileDir, "01.wav", title: "Lonely", album: "Big Album");

            MusicLibrary library = MusicLibraryScanner.Scan(root, Path.Combine(root, ".art"));
            AlbumInfo[] all = [.. library.Albums, .. library.Singles];

            Assert.Equal("ep", all.Single(item => item.Title == "Typed EP").ReleaseType);
            Assert.Null(all.Single(item => item.Title == "Big Album").ReleaseType);
        }
    }
}
