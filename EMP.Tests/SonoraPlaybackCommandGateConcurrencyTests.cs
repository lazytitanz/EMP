using EMP.Hosting.Sonora;
using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraPlaybackCommandGateConcurrencyTests
    {
        [Fact]
        public void RapidTransportBurst_OnlyLatestGenerationIsCurrent()
        {
            PlaybackCommandGate gate = new();
            long[] gens = new long[256];
            Parallel.For(0, gens.Length, i => gens[i] = gate.BeginCommand());

            long current = gate.Current;
            Assert.Equal(gens.Length, current);
            Assert.Contains(current, gens);
            Assert.True(gate.IsCurrent(current));
            Assert.Equal(gens.Length, gens.Distinct().Count());
        }

        [Fact]
        public void SeekDuringCrossfadePattern_StaleSeekGenerationIsRejected()
        {
            PlaybackCommandGate gate = new();
            long crossfadeArm = gate.BeginCommand(); // preload / crossfade config
            long staleSeek = gate.BeginCommand();
            long latestSeek = gate.BeginCommand();

            Assert.False(gate.IsCurrent(crossfadeArm));
            Assert.False(gate.IsCurrent(staleSeek));
            Assert.True(gate.IsCurrent(latestSeek));
        }

        [Fact]
        public void PreloadCancelPattern_ClearNextSupersedesPreload()
        {
            PlaybackCommandGate gate = new();
            long preload = gate.BeginCommand();
            long clear = gate.BeginCommand();

            Assert.False(gate.IsCurrent(preload));
            Assert.True(gate.IsCurrent(clear));
        }
    }
}
