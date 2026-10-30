namespace EMP.UpdateCore;

public static class ReleaseAssetNames
{
    public const string Runtime = "win-x64";

    public static string PackageZip(string version)
    {
        string normalized = VersionComparer.Normalize(version);
        return $"EMP-v{normalized}-{Runtime}.zip";
    }

    public static string PackageChecksum(string version)
    {
        return PackageZip(version) + ".sha256";
    }
}
