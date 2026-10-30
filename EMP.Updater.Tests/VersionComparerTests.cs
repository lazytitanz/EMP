using EMP.UpdateCore;

namespace EMP.Updater.Tests;

public class VersionComparerTests
{
    [Theory]
    [InlineData("0.2.0", "0.1.0", true)]
    [InlineData("0.10.0", "0.9.0", true)]
    [InlineData("1.0.0", "1.0.0", false)]
    [InlineData("0.1.0", "0.2.0", false)]
    [InlineData("v0.3.0", "0.2.9", true)]
    public void IsNewer_ComparesSemantically(string candidate, string current, bool expected)
    {
        Assert.Equal(expected, VersionComparer.IsNewer(candidate, current));
    }

    [Fact]
    public void TryParse_RejectsInvalidTags()
    {
        Assert.False(VersionComparer.TryParse("not-a-version", out _));
        Assert.False(VersionComparer.TryParse("", out _));
        Assert.False(VersionComparer.TryParse(null, out _));
    }

    [Fact]
    public void Normalize_StripsVPrefix()
    {
        Assert.Equal("1.2.3", VersionComparer.Normalize("v1.2.3"));
    }

    [Fact]
    public void Compare_EqualVersions()
    {
        Assert.Equal(0, VersionComparer.Compare("v1.0.0", "1.0.0"));
    }
}
