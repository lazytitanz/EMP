using System.Text;
using EMP.UpdateCore;

namespace EMP.Updater.Tests;

public class UpdateInstallerTests
{
    [Fact]
    public async Task Install_ReplacesPackageFiles_PreservesUserFilesAndArtwork()
    {
        string root = TestHelpers.CreateTempDir("install-happy");
        string install = Path.Combine(root, "install");
        string updates = Path.Combine(root, "updates");
        string releaseDir = Path.Combine(root, "release");
        Directory.CreateDirectory(install);

        await File.WriteAllTextAsync(Path.Combine(install, "EMP.exe"), "EMP:0.1.0");
        await File.WriteAllTextAsync(Path.Combine(install, "EMP.Updater.exe"), "UPDATER:0.1.0");
        Directory.CreateDirectory(Path.Combine(install, "www"));
        await File.WriteAllTextAsync(Path.Combine(install, "www", "index.html"), "<html>old</html>");
        Directory.CreateDirectory(Path.Combine(install, "www", "artwork"));
        await File.WriteAllTextAsync(Path.Combine(install, "www", "artwork", "cover.jpg"), "ART");
        await File.WriteAllTextAsync(Path.Combine(install, "user-notes.txt"), "keep-me");

        string zip = TestHelpers.CreatePackageZip(releaseDir, "0.2.0");
        UpdatePaths paths = new(updates);
        UpdateInstaller installer = new(paths, versionReader: ReadFakeVersion);
        installer.Install(zip, install, "0.2.0", relaunch: false);

        Assert.Equal("EMP:0.2.0", await File.ReadAllTextAsync(Path.Combine(install, "EMP.exe")));
        Assert.Equal("keep-me", await File.ReadAllTextAsync(Path.Combine(install, "user-notes.txt")));
        Assert.Equal("ART", await File.ReadAllTextAsync(Path.Combine(install, "www", "artwork", "cover.jpg")));
        Assert.Contains("0.2.0", await File.ReadAllTextAsync(Path.Combine(install, "www", "index.html")));

        RecoveryManifest? manifest = RecoveryManifest.TryLoad(paths.RecoveryManifestPath);
        Assert.NotNull(manifest);
        Assert.Equal(UpdatePhase.Complete, manifest!.Phase);
    }

    [Fact]
    public async Task DownloadAndVerify_ThenInstall_ViaMockProvider()
    {
        string root = TestHelpers.CreateTempDir("download-install");
        string install = Path.Combine(root, "install");
        string updates = Path.Combine(root, "updates");
        string releaseDir = Path.Combine(root, "release");
        Directory.CreateDirectory(install);
        await File.WriteAllTextAsync(Path.Combine(install, "EMP.exe"), "EMP:0.1.0");
        await File.WriteAllTextAsync(Path.Combine(install, "EMP.Updater.exe"), "UPDATER:0.1.0");
        Directory.CreateDirectory(Path.Combine(install, "www"));
        await File.WriteAllTextAsync(Path.Combine(install, "www", "index.html"), "old");

        TestHelpers.CreatePackageZip(releaseDir, "0.2.0");
        MockReleaseProvider provider = MockReleaseProvider.FromDirectory(releaseDir, "0.2.0");
        UpdatePaths paths = new(updates);
        UpdateDownloader downloader = new(provider, paths);
        AvailableUpdate? available = await downloader.CheckForUpdateAsync("0.1.0");
        Assert.NotNull(available);
        string package = await downloader.DownloadAndVerifyAsync(available!.Release);
        Assert.True(File.Exists(package));

        UpdateInstaller installer = new(paths, versionReader: ReadFakeVersion);
        installer.Install(package, install, "0.2.0", relaunch: false);
        Assert.Equal("EMP:0.2.0", await File.ReadAllTextAsync(Path.Combine(install, "EMP.exe")));
    }

    [Fact]
    public async Task CrashRecovery_RollsBackFromBackupComplete()
    {
        string root = TestHelpers.CreateTempDir("crash-recovery");
        string install = Path.Combine(root, "install");
        string updates = Path.Combine(root, "updates");
        string work = Path.Combine(root, "work");
        Directory.CreateDirectory(install);
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(Path.Combine(install, "EMP.exe"), "EMP:broken");
        await File.WriteAllTextAsync(Path.Combine(install, "EMP.Updater.exe"), "UPDATER:broken");
        Directory.CreateDirectory(Path.Combine(install, "www"));
        await File.WriteAllTextAsync(Path.Combine(install, "www", "index.html"), "broken");

        string backup = Path.Combine(work, "backup");
        Directory.CreateDirectory(backup);
        await File.WriteAllTextAsync(Path.Combine(backup, "EMP.exe"), "EMP:0.1.0");
        await File.WriteAllTextAsync(Path.Combine(backup, "EMP.Updater.exe"), "UPDATER:0.1.0");
        Directory.CreateDirectory(Path.Combine(backup, "www"));
        await File.WriteAllTextAsync(Path.Combine(backup, "www", "index.html"), "good");

        UpdatePaths paths = new(updates);
        paths.EnsureCreated();
        RecoveryManifest manifest = new()
        {
            Phase = UpdatePhase.BackupComplete,
            InstallDir = install,
            BackupDir = backup,
            ExpectedVersion = "0.2.0",
            StartedUtc = DateTimeOffset.UtcNow
        };
        manifest.Save(paths.RecoveryManifestPath);

        UpdateInstaller installer = new(paths, versionReader: ReadFakeVersion);
        installer.RecoverInterruptedIfNeeded();

        Assert.Equal("EMP:0.1.0", await File.ReadAllTextAsync(Path.Combine(install, "EMP.exe")));
        RecoveryManifest? after = RecoveryManifest.TryLoad(paths.RecoveryManifestPath);
        Assert.Equal(UpdatePhase.RolledBack, after!.Phase);
    }

    [Fact]
    public void BuildPreserveSet_IncludesNonPackageAndArtwork()
    {
        string root = TestHelpers.CreateTempDir("preserve-set");
        string install = Path.Combine(root, "install");
        Directory.CreateDirectory(Path.Combine(install, "www", "artwork"));
        File.WriteAllText(Path.Combine(install, "EMP.exe"), "x");
        File.WriteAllText(Path.Combine(install, "user.txt"), "y");
        File.WriteAllText(Path.Combine(install, "www", "artwork", "a.jpg"), "z");

        HashSet<string> package = new(StringComparer.OrdinalIgnoreCase) { "EMP.exe", "www/index.html" };
        List<string> preserve = UpdateInstaller.BuildPreserveSet(install, package);
        Assert.Contains(preserve, p => p.Equals("user.txt", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(preserve, p => p.Replace('\\', '/').Equals("www/artwork/a.jpg", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(preserve, p => p.Equals("EMP.exe", StringComparison.OrdinalIgnoreCase));
    }

    private static string ReadFakeVersion(string exePath)
    {
        string text = File.ReadAllText(exePath, Encoding.UTF8);
        const string prefix = "EMP:";
        if (text.StartsWith(prefix, StringComparison.Ordinal))
        {
            return text[prefix.Length..].Trim();
        }

        return "0.0.0";
    }
}
