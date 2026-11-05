using EMP.Hosting.Sonora;
using Sonora.Audio.Output;
using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraOutputModeMappingTests
    {
        [Fact]
        public void FromUi_Shared_UsesStrictSharedDefaults()
        {
            AudioOutputConfiguration config = SonoraOutputModeMapping.FromUi("shared");
            Assert.Equal(AudioOutputMode.Shared, config.Mode);
            Assert.Equal(ExclusiveModeFallback.None, config.ExclusiveFallback);
        }

        [Fact]
        public void FromUi_Exclusive_DefaultsToSharedFallback()
        {
            AudioOutputConfiguration config = SonoraOutputModeMapping.FromUi("exclusive");
            Assert.Equal(AudioOutputMode.Exclusive, config.Mode);
            Assert.Equal(ExclusiveModeFallback.Shared, config.ExclusiveFallback);
        }

        [Theory]
        [InlineData(ExclusiveFallbackReason.None, "none")]
        [InlineData(ExclusiveFallbackReason.DeviceBusy, "deviceBusy")]
        [InlineData(ExclusiveFallbackReason.ExclusiveModeRestricted, "exclusiveModeRestricted")]
        [InlineData(ExclusiveFallbackReason.UnsupportedFormat, "unsupportedFormat")]
        [InlineData(ExclusiveFallbackReason.InitializationFailed, "initializationFailed")]
        public void ToUiFallbackReason_MapsKnownReasons(ExclusiveFallbackReason reason, string expected)
        {
            Assert.Equal(expected, SonoraOutputModeMapping.ToUiFallbackReason(reason));
        }

        [Fact]
        public void ToUiMode_DistinguishesRequestedEffective()
        {
            Assert.Equal("shared", SonoraOutputModeMapping.ToUiMode(AudioOutputMode.Shared));
            Assert.Equal("exclusive", SonoraOutputModeMapping.ToUiMode(AudioOutputMode.Exclusive));
            Assert.Equal("shared", SonoraOutputModeMapping.ToUiMode(null));
        }
    }
}
