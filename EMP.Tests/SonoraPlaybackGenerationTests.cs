using EMP.Hosting.Sonora;
using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraPlaybackGenerationTests
    {
        [Fact]
        public void BeginCommand_IncrementsMonotonically()
        {
            PlaybackCommandGate gate = new();
            Assert.Equal(0, gate.Current);

            long first = gate.BeginCommand();
            long second = gate.BeginCommand();

            Assert.Equal(1, first);
            Assert.Equal(2, second);
            Assert.Equal(2, gate.Current);
        }

        [Fact]
        public void IsCurrent_RejectsStaleGenerations()
        {
            PlaybackCommandGate gate = new();
            long stale = gate.BeginCommand();
            _ = gate.BeginCommand();

            Assert.False(gate.IsCurrent(stale));
            Assert.True(gate.IsCurrent(gate.Current));
        }

        [Fact]
        public void RapidTransportSequence_OnlyLatestGenerationRemainsCurrent()
        {
            PlaybackCommandGate gate = new();
            long[] generations = new long[32];
            for (int i = 0; i < generations.Length; i++)
            {
                generations[i] = gate.BeginCommand();
            }

            for (int i = 0; i < generations.Length - 1; i++)
            {
                Assert.False(gate.IsCurrent(generations[i]));
            }

            Assert.True(gate.IsCurrent(generations[^1]));
        }
    }
}
