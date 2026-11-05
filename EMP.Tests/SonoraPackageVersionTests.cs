using EMP.Hosting.Sonora;
using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraPackageVersionTests
    {
        [Fact]
        public void StripBuildMetadata_RemovesPlusSuffix()
        {
            Assert.Equal("1.0.0-rc.1", SonoraPackageVersion.StripBuildMetadata("1.0.0-rc.1+9a2a9eee"));
            Assert.Equal("1.0.0-rc.1", SonoraPackageVersion.StripBuildMetadata("1.0.0-rc.1"));
        }

        [Fact]
        public void Current_PreservesPrereleaseInformationalVersion()
        {
            string version = SonoraPackageVersion.Current;
            Assert.False(string.IsNullOrWhiteSpace(version));
            Assert.DoesNotContain('+', version);
            // Assembly Version on the Sonora packages is 1.0.0.0; informational keeps the RC label.
            Assert.NotEqual("1.0.0.0", version);
            Assert.Contains("1.0.0", version, StringComparison.Ordinal);
        }
    }
}
