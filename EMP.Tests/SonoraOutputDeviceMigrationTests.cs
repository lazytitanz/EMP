using EMP.Hosting.Sonora;
using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraOutputDeviceMigrationTests
    {
        private static readonly SonoraOutputDeviceMigration.Device[] Devices =
        [
            new("wasapi-speakers", "Speakers (Realtek)"),
            new("wasapi-headphones", "Headphones")
        ];

        [Fact]
        public void Resolve_EmptySavedId_KeepsSystemDefault()
        {
            SonoraOutputDeviceMigration.Result result = SonoraOutputDeviceMigration.Resolve("", "", Devices);
            Assert.Equal("", result.DeviceId);
            Assert.False(result.Changed);
        }

        [Fact]
        public void Resolve_ExactWasapiId_KeepsSelection()
        {
            SonoraOutputDeviceMigration.Result result = SonoraOutputDeviceMigration.Resolve(
                "wasapi-headphones",
                "Headphones",
                Devices);

            Assert.Equal("wasapi-headphones", result.DeviceId);
            Assert.Equal("Headphones", result.DeviceLabel);
            Assert.False(result.Changed);
        }

        [Fact]
        public void Resolve_ChromiumIdWithMatchingLabel_MigratesByLabel()
        {
            SonoraOutputDeviceMigration.Result result = SonoraOutputDeviceMigration.Resolve(
                "chromium-sink-abc",
                "Headphones",
                Devices);

            Assert.Equal("wasapi-headphones", result.DeviceId);
            Assert.True(result.Changed);
        }

        [Fact]
        public void Resolve_UnknownIdWithoutLabel_ClearsToDefault()
        {
            SonoraOutputDeviceMigration.Result result = SonoraOutputDeviceMigration.Resolve(
                "chromium-sink-abc",
                "",
                Devices);

            Assert.Equal("", result.DeviceId);
            Assert.True(result.Changed);
        }
    }
}
