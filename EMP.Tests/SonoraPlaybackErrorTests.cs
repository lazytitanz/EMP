using EMP.Hosting.Sonora;
using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraPlaybackErrorTests
    {
        [Theory]
        [InlineData(SonoraPlaybackError.OperationLoad, true)]
        [InlineData(SonoraPlaybackError.OperationPlay, true)]
        [InlineData(SonoraPlaybackError.OperationSeek, true)]
        [InlineData(SonoraPlaybackError.OperationUnknown, true)]
        [InlineData(SonoraPlaybackError.OperationPreload, false)]
        [InlineData(SonoraPlaybackError.OperationOutputDevice, false)]
        public void AffectsTransport_MatchesOperationPolicy(string operation, bool expected)
        {
            Assert.Equal(expected, SonoraPlaybackError.AffectsTransport(operation));
        }

        [Fact]
        public void IsStale_RejectsOlderGenerations_KeepsCurrentAndNewer()
        {
            Assert.True(SonoraPlaybackError.IsStale(3, 5));
            Assert.False(SonoraPlaybackError.IsStale(5, 5));
            Assert.False(SonoraPlaybackError.IsStale(6, 5));
            Assert.False(SonoraPlaybackError.IsStale(0, 5));
        }

        [Fact]
        public void SanitizeMessage_StripsLocalAndUncPaths()
        {
            string cleaned = SonoraPlaybackError.SanitizeMessage(
                @"The audio source 'C:\Music\Flyleaf\I'm So Sick.m4a' could not be opened.");

            Assert.DoesNotContain(@"C:\", cleaned, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("Flyleaf", cleaned, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("Sick.m4a", cleaned, StringComparison.OrdinalIgnoreCase);

            string unc = SonoraPlaybackError.SanitizeMessage(@"Failed reading \\nas\share\album\track.flac");
            Assert.DoesNotContain(@"\\nas", unc, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void UserMessage_MapsInvalidAudioWithoutExposingPath()
        {
            var inner = new InvalidOperationException("mf failed");
            var ex = new global::Sonora.Audio.InvalidAudioException(
                @"The audio source 'D:\Library\song.m4a' could not be opened.",
                inner);

            string message = SonoraPlaybackError.UserMessage(SonoraPlaybackError.OperationLoad, ex);

            Assert.Equal("This track could not be opened.", message);
            Assert.DoesNotContain(@"D:\", message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void UserMessage_MapsPlayBeforeLoadRace()
        {
            string message = SonoraPlaybackError.UserMessage(
                SonoraPlaybackError.OperationPlay,
                new InvalidOperationException("No audio source is loaded."));

            Assert.Equal("The track is still loading. Try play again in a moment.", message);
        }

        [Fact]
        public void UserMessage_PreloadStaysNonFatalWording()
        {
            string message = SonoraPlaybackError.UserMessage(
                SonoraPlaybackError.OperationPreload,
                new FileNotFoundException("missing"));

            Assert.Equal("This track's file could not be found.", message);
            Assert.Equal("Couldn't prepare next track", SonoraPlaybackError.TitleFor(SonoraPlaybackError.OperationPreload));
        }

        [Fact]
        public void RapidSwitch_StaleLoadErrorDoesNotAffectNewerGeneration()
        {
            PlaybackCommandGate gate = new();
            long failedLoad = gate.BeginCommand();
            long successfulLoad = gate.BeginCommand();

            Assert.True(SonoraPlaybackError.IsStale(failedLoad, successfulLoad));
            Assert.True(SonoraPlaybackError.AffectsTransport(SonoraPlaybackError.OperationLoad));
            // Policy: UI applies transport clear only when !IsStale.
            Assert.False(
                !SonoraPlaybackError.IsStale(failedLoad, successfulLoad)
                && SonoraPlaybackError.AffectsTransport(SonoraPlaybackError.OperationLoad));
        }

        [Fact]
        public void SuccessfulRecovery_CurrentGenerationErrorStillApplies()
        {
            PlaybackCommandGate gate = new();
            long loadGeneration = gate.BeginCommand();

            Assert.False(SonoraPlaybackError.IsStale(loadGeneration, gate.Current));
            Assert.True(
                !SonoraPlaybackError.IsStale(loadGeneration, gate.Current)
                && SonoraPlaybackError.AffectsTransport(SonoraPlaybackError.OperationLoad));
        }

        [Fact]
        public void FailedPreload_DoesNotAffectTransportEvenWhenCurrent()
        {
            PlaybackCommandGate gate = new();
            long preloadGeneration = gate.BeginCommand();

            Assert.False(SonoraPlaybackError.IsStale(preloadGeneration, gate.Current));
            Assert.False(SonoraPlaybackError.AffectsTransport(SonoraPlaybackError.OperationPreload));
        }

        [Fact]
        public void SonoraCommandException_PreservesGenerationAndOperation()
        {
            var inner = new global::Sonora.Audio.InvalidAudioException("open failed");
            var wrapped = new SonoraCommandException(
                42,
                SonoraPlaybackError.OperationLoad,
                "track-1",
                inner);

            Assert.Equal(42, wrapped.Generation);
            Assert.Equal(SonoraPlaybackError.OperationLoad, wrapped.Operation);
            Assert.Equal("track-1", wrapped.TrackId);
            Assert.Same(inner, wrapped.InnerException);
        }
    }
}
