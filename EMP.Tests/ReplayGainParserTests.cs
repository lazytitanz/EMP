using EMP.Library;
using Xunit;

namespace EMP.Tests
{
    public sealed class ReplayGainParserTests
    {
        [Theory]
        [InlineData(0.0, 0.0)]
        [InlineData(-6.5, -6.5)]
        [InlineData(12.0, 12.0)]
        public void TryParseGainDb_AcceptsReasonableValues(double input, double expected)
        {
            Assert.Equal(expected, ReplayGainParser.TryParseGainDb(input));
        }

        [Theory]
        [InlineData(double.NaN)]
        [InlineData(double.PositiveInfinity)]
        [InlineData(double.NegativeInfinity)]
        [InlineData(-24.01)]
        [InlineData(24.01)]
        public void TryParseGainDb_RejectsInvalidValues(double input)
        {
            Assert.Null(ReplayGainParser.TryParseGainDb(input));
        }

        [Theory]
        [InlineData(0.5, 0.5)]
        [InlineData(1.0, 1.0)]
        [InlineData(1.25, 1.25)]
        public void TryParsePeak_AcceptsReasonableValues(double input, double expected)
        {
            Assert.Equal(expected, ReplayGainParser.TryParsePeak(input));
        }

        [Theory]
        [InlineData(double.NaN)]
        [InlineData(0.0)]
        [InlineData(-0.1)]
        [InlineData(8.01)]
        public void TryParsePeak_RejectsInvalidValues(double input)
        {
            Assert.Null(ReplayGainParser.TryParsePeak(input));
        }

        [Fact]
        public void FromTagLib_MapsValidFieldsAndDropsInvalid()
        {
            ReplayGainInfo info = ReplayGainParser.FromTagLib(
                trackGain: -3.2,
                trackPeak: 0.98,
                albumGain: double.NaN,
                albumPeak: 9.0);

            Assert.Equal(-3.2, info.TrackGainDb);
            Assert.Equal(0.98, info.TrackPeak);
            Assert.Null(info.AlbumGainDb);
            Assert.Null(info.AlbumPeak);
        }
    }
}
