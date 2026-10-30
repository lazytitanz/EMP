using System.IO.Compression;
using System.Text;
using EMP.UpdateCore;

namespace EMP.Updater.Tests;

public class ChecksumAndZipTests
{
    [Fact]
    public async Task ChecksumVerifier_MatchAndMismatch()
    {
        string dir = TestHelpers.CreateTempDir("checksum");
        string file = Path.Combine(dir, "a.bin");
        byte[] data = Encoding.UTF8.GetBytes("hello");
        await File.WriteAllBytesAsync(file, data);
        string hex = TestHelpers.Sha256Hex(data);
        await ChecksumVerifier.VerifyFileAsync(file, hex, hex);
        await Assert.ThrowsAsync<UpdateVerificationException>(() =>
            ChecksumVerifier.VerifyFileAsync(file, new string('b', 64), null));
    }

    [Fact]
    public async Task ChecksumAuthenticator_NeverSkipped()
    {
        string dir = TestHelpers.CreateTempDir("auth");
        string zip = TestHelpers.CreatePackageZip(dir, "0.1.0");
        string wrong = new string('a', 64);
        ChecksumAuthenticator authenticator = new();
        await Assert.ThrowsAsync<UpdateVerificationException>(() => authenticator.AuthenticateAsync(
            new PackageAuthenticationContext
            {
                PackagePath = zip,
                ExpectedSha256Hex = wrong,
                Release = new ReleaseInfo
                {
                    TagName = "v0.1.0",
                    Version = "0.1.0",
                    PackageFileName = ReleaseAssetNames.PackageZip("0.1.0"),
                    PackageDownloadUrl = new Uri(zip),
                    ChecksumFileName = ReleaseAssetNames.PackageChecksum("0.1.0"),
                    ChecksumDownloadUrl = new Uri(zip + ".sha256")
                }
            }));
    }

    [Fact]
    public void ZipValidator_AcceptsValidPackage()
    {
        string dir = TestHelpers.CreateTempDir("zip-valid");
        string zip = TestHelpers.CreatePackageZip(dir, "0.2.0");
        ZipPackageValidator.Validate(zip);
    }

    [Fact]
    public void ZipValidator_RejectsMissingEmp()
    {
        string dir = TestHelpers.CreateTempDir("zip-missing");
        string zip = TestHelpers.CreatePackageZip(dir, "0.2.0", includeEmp: false);
        Assert.Throws<UpdatePackageException>(() => ZipPackageValidator.Validate(zip));
    }

    [Fact]
    public void ZipValidator_RejectsPathTraversal()
    {
        string dir = TestHelpers.CreateTempDir("zip-trav");
        string zip = Path.Combine(dir, "bad.zip");
        using (ZipArchive archive = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            TestHelpers.AddEntry(archive, "EMP.exe", Encoding.UTF8.GetBytes("x"));
            TestHelpers.AddEntry(archive, "EMP.Updater.exe", Encoding.UTF8.GetBytes("y"));
            TestHelpers.AddEntry(archive, "../evil.txt", Encoding.UTF8.GetBytes("z"));
        }

        Assert.Throws<UpdatePackageException>(() => ZipPackageValidator.Validate(zip));
    }

    [Fact]
    public void ZipValidator_RejectsAbsolutePath()
    {
        string dir = TestHelpers.CreateTempDir("zip-abs");
        string zip = Path.Combine(dir, "bad.zip");
        using (ZipArchive archive = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            TestHelpers.AddEntry(archive, "EMP.exe", Encoding.UTF8.GetBytes("x"));
            TestHelpers.AddEntry(archive, "EMP.Updater.exe", Encoding.UTF8.GetBytes("y"));
            TestHelpers.AddEntry(archive, "C:/Windows/notepad.exe", Encoding.UTF8.GetBytes("z"));
        }

        Assert.Throws<UpdatePackageException>(() => ZipPackageValidator.Validate(zip));
    }

    [Fact]
    public void ZipValidator_RejectsCorruptArchive()
    {
        string dir = TestHelpers.CreateTempDir("zip-corrupt");
        string zip = Path.Combine(dir, "corrupt.zip");
        File.WriteAllText(zip, "not a zip");
        Assert.ThrowsAny<Exception>(() => ZipPackageValidator.Validate(zip));
    }

    [Fact]
    public void ZipValidator_RejectsOversized()
    {
        string dir = TestHelpers.CreateTempDir("zip-big");
        string zip = Path.Combine(dir, "big.zip");
        using (ZipArchive archive = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            TestHelpers.AddEntry(archive, "EMP.exe", Encoding.UTF8.GetBytes("x"));
            TestHelpers.AddEntry(archive, "EMP.Updater.exe", Encoding.UTF8.GetBytes("y"));
            TestHelpers.AddEntry(archive, "www/index.html", new byte[1024]);
        }

        Assert.Throws<UpdatePackageException>(() =>
            ZipPackageValidator.Validate(zip, maxUncompressedBytes: 10));
    }
}
