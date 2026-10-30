namespace EMP.UpdateCore;

public sealed class UpdatePaths
{
    public UpdatePaths(string updatesRoot, string? logsRoot = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(updatesRoot);
        UpdatesRoot = Path.GetFullPath(updatesRoot);
        LogsRoot = Path.GetFullPath(logsRoot ?? Path.Combine(Path.GetDirectoryName(UpdatesRoot) ?? UpdatesRoot, "logs"));
        PendingDirectory = Path.Combine(UpdatesRoot, "pending");
        RecoveryManifestPath = Path.Combine(UpdatesRoot, "recovery.json");
        UpdaterLogPath = Path.Combine(LogsRoot, "updater.log");
    }

    public string UpdatesRoot { get; }

    public string LogsRoot { get; }

    public string PendingDirectory { get; }

    public string RecoveryManifestPath { get; }

    public string UpdaterLogPath { get; }

    public static UpdatePaths DefaultLocalAppData()
    {
        string root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP");
        return new UpdatePaths(Path.Combine(root, "updates"), Path.Combine(root, "logs"));
    }

    public void EnsureCreated()
    {
        Directory.CreateDirectory(UpdatesRoot);
        Directory.CreateDirectory(PendingDirectory);
        Directory.CreateDirectory(LogsRoot);
    }

    public static string PreferSameVolumeWorkRoot(string installDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installDirectory);
        string installFull = Path.GetFullPath(installDirectory);
        string? parent = Path.GetDirectoryName(installFull);
        if (!string.IsNullOrWhiteSpace(parent))
        {
            try
            {
                string candidate = Path.Combine(parent, ".emp-update-work");
                Directory.CreateDirectory(candidate);
                return candidate;
            }
            catch (Exception)
            {
                // Fall through to TEMP.
            }
        }

        return Path.Combine(Path.GetTempPath(), "EMP-update-work");
    }
}
