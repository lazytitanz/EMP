using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.UpdateCore;

public enum UpdatePhase
{
    Idle,
    PackageVerified,
    WaitingForExit,
    Staged,
    BackupComplete,
    FilesApplied,
    InstallVerified,
    RelaunchRequested,
    Complete,
    Failed,
    RolledBack
}

public sealed class RecoveryManifest
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    public UpdatePhase Phase { get; set; } = UpdatePhase.Idle;

    public string? ExpectedVersion { get; set; }

    public string? InstallDir { get; set; }

    public string? PackagePath { get; set; }

    public string? StageDir { get; set; }

    public string? BackupDir { get; set; }

    public string? PreserveDir { get; set; }

    public List<string> PreservedUserFiles { get; set; } = [];

    public DateTimeOffset StartedUtc { get; set; }

    public DateTimeOffset LastPhaseUtc { get; set; }

    public string? LastError { get; set; }

    public static RecoveryManifest? TryLoad(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            return JsonSerializer.Deserialize<RecoveryManifest>(File.ReadAllText(path), JsonOptions);
        }
        catch (Exception)
        {
            return null;
        }
    }

    public void Save(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string? directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        LastPhaseUtc = DateTimeOffset.UtcNow;
        string temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(this, JsonOptions));
        File.Copy(temp, path, overwrite: true);
        File.Delete(temp);
    }

    public bool NeedsCrashRecovery =>
        Phase is UpdatePhase.BackupComplete or UpdatePhase.FilesApplied;
}
