using EMP.Hosting.Sonora;
using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraQueueHandoffTests
    {
        [Fact]
        public void AfterTransition_MatchingNextPath_PromotesWithoutRedundantLoad()
        {
            SonoraQueueHandoff.State before = new(
                CurrentTrackId: "a",
                NextTrackId: "b",
                CurrentPath: @"C:\music\a.flac",
                NextPath: @"C:\music\b.flac");

            SonoraQueueHandoff.State after = SonoraQueueHandoff.AfterTransition(before, @"C:\music\b.flac");

            Assert.Equal("b", after.CurrentTrackId);
            Assert.Null(after.NextTrackId);
            Assert.Equal(@"C:\music\b.flac", after.CurrentPath);
            Assert.Null(after.NextPath);
        }

        [Fact]
        public void AfterTransition_EmptyNextPath_ClearsPreloadOnly()
        {
            SonoraQueueHandoff.State before = new("a", "b", @"C:\a.flac", @"C:\b.flac");
            SonoraQueueHandoff.State after = SonoraQueueHandoff.AfterTransition(before, null);

            Assert.Equal("a", after.CurrentTrackId);
            Assert.Null(after.NextTrackId);
            Assert.Null(after.NextPath);
        }

        [Theory]
        [InlineData(true, false, false, "next", true)]
        [InlineData(false, true, false, "next", true)]
        [InlineData(true, true, true, "next", false)]
        [InlineData(true, false, false, null, false)]
        [InlineData(false, false, false, "next", false)]
        public void ShouldPreloadNext_MatchesQueuePolicy(
            bool gapless,
            bool crossfade,
            bool repeatOne,
            string? nextId,
            bool expected)
        {
            Assert.Equal(expected, SonoraQueueHandoff.ShouldPreloadNext(gapless, crossfade, repeatOne, nextId));
        }
    }
}
