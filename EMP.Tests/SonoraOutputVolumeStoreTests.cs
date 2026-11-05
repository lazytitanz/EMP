using EMP.Hosting.Sonora;
using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraOutputVolumeStoreTests
    {
        [Fact]
        public void DefaultsToUnityUntilExplicitRequest()
        {
            SonoraOutputVolumeStore store = new();

            Assert.Equal(1f, store.RememberedLinear);
            Assert.False(store.HasExplicitRequest);
            Assert.False(store.TryApplyExplicit(_ => Assert.Fail("must not apply before EMP requests volume")));
        }

        [Fact]
        public void Remember_ClampsAndMarksExplicit_IncludingMute()
        {
            SonoraOutputVolumeStore store = new();

            Assert.Equal(0.25f, store.Remember(0.25f));
            Assert.True(store.HasExplicitRequest);

            Assert.Equal(0f, store.Remember(-1f));
            Assert.Equal(1f, store.Remember(2f));
        }

        [Fact]
        public void TryApplyExplicit_ReappliesLastGain_ForStartupAndRecreation()
        {
            SonoraOutputVolumeStore store = new();
            store.Remember(0.36f); // UI 60% after power² curve

            float applied = -1f;
            Assert.True(store.TryApplyExplicit(v => applied = v));
            Assert.Equal(0.36f, applied);

            // Simulate output recreation / track load: same remembered gain must re-apply.
            float reapplied = -1f;
            Assert.True(store.TryApplyExplicit(v => reapplied = v));
            Assert.Equal(0.36f, reapplied);
        }

        [Fact]
        public void MuteZero_IsAnExplicitRequest()
        {
            SonoraOutputVolumeStore store = new();
            store.Remember(0f);

            float applied = 1f;
            Assert.True(store.TryApplyExplicit(v => applied = v));
            Assert.Equal(0f, applied);
        }
    }
}
