using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using EMP.UpdateCore;

namespace EMP.Updater.Tests;

internal static class TestHelpers
{
    public static string CreateTempDir(string prefix)
    {
        string path = Path.Combine(Path.GetTempPath(), "EMP.Updater.Tests", prefix + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    public static void WriteFakeExe(string path, string informationalVersion)
    {
        string? dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        // Minimal PE-like placeholder is not required for most tests; FileVersionInfo needs a real binary.
        // For version verification tests we publish a tiny stub via writing a .NET app isn't practical here,
        // so Installer verification tests use a helper that stamps a sidecar version file when PE isn't available.
        File.WriteAllBytes(path, Encoding.UTF8.GetBytes("FAKE-EXE:" + informationalVersion));
    }

    public static string CreatePackageZip(
        string directory,
        string version,
        IEnumerable<(string RelativePath, byte[] Content)>? extraFiles = null,
        bool includeEmp = true,
        bool includeUpdater = true)
    {
        Directory.CreateDirectory(directory);
        string zipPath = Path.Combine(directory, ReleaseAssetNames.PackageZip(version));
        if (File.Exists(zipPath))
        {
            File.Delete(zipPath);
        }

        using (ZipArchive archive = ZipFile.Open(zipPath, ZipArchiveMode.Create))
        {
            if (includeEmp)
            {
                AddEntry(archive, "EMP.exe", Encoding.UTF8.GetBytes("EMP:" + version));
            }

            if (includeUpdater)
            {
                AddEntry(archive, "EMP.Updater.exe", Encoding.UTF8.GetBytes("UPDATER:" + version));
            }

            AddEntry(archive, "www/index.html", Encoding.UTF8.GetBytes($"<html>EMP {version}</html>"));
            if (extraFiles is not null)
            {
                foreach ((string relative, byte[] content) in extraFiles)
                {
                    AddEntry(archive, relative, content);
                }
            }
        }

        string checksumPath = Path.Combine(directory, ReleaseAssetNames.PackageChecksum(version));
        string hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(zipPath))).ToLowerInvariant();
        File.WriteAllText(checksumPath, $"{hash}  {Path.GetFileName(zipPath)}{Environment.NewLine}");
        return zipPath;
    }

    public static void AddEntry(ZipArchive archive, string relativePath, byte[] content)
    {
        ZipArchiveEntry entry = archive.CreateEntry(relativePath.Replace('\\', '/'), CompressionLevel.Fastest);
        using Stream stream = entry.Open();
        stream.Write(content);
    }

    public static string Sha256Hex(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
}
