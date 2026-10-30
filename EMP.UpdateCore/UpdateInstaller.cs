namespace EMP.UpdateCore;

public sealed class UpdateInstaller
{
    private readonly UpdatePaths _paths;
    private readonly Action<string>? _log;
    private readonly Func<string, string> _versionReader;

    public UpdateInstaller(
        UpdatePaths paths,
        Action<string>? log = null,
        Func<string, string>? versionReader = null)
    {
        _paths = paths ?? throw new ArgumentNullException(nameof(paths));
        _log = log;
        _versionReader = versionReader ?? AppVersion.FromExecutable;
    }

    public void RecoverInterruptedIfNeeded()
    {
        RecoveryManifest? manifest = RecoveryManifest.TryLoad(_paths.RecoveryManifestPath);
        if (manifest is null || !manifest.NeedsCrashRecovery)
        {
            return;
        }

        Log($"Recovering interrupted update in phase {manifest.Phase}.");
        try
        {
            Rollback(manifest);
            manifest.Phase = UpdatePhase.RolledBack;
            manifest.LastError = "Recovered from interrupted installation.";
            manifest.Save(_paths.RecoveryManifestPath);
        }
        catch (Exception ex)
        {
            Log($"Crash recovery failed: {ex.Message}");
            throw;
        }
    }

    public void Install(
        string packagePath,
        string installDirectory,
        string expectedVersion,
        bool relaunch)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(installDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedVersion);

        _paths.EnsureCreated();
        RecoverInterruptedIfNeeded();

        string installDir = Path.GetFullPath(installDirectory);
        Directory.CreateDirectory(installDir);

        ZipPackageValidator.Validate(packagePath);
        IReadOnlyList<string> packageEntries = ZipPackageValidator.ListEntries(packagePath);
        HashSet<string> packageSet = new(packageEntries, StringComparer.OrdinalIgnoreCase);

        string workRoot = UpdatePaths.PreferSameVolumeWorkRoot(installDir);
        Directory.CreateDirectory(workRoot);
        string runId = Guid.NewGuid().ToString("N");
        string stageDir = Path.Combine(workRoot, "stage-" + runId);
        string backupDir = Path.Combine(workRoot, "backup-" + runId);
        string preserveDir = Path.Combine(workRoot, "preserve-" + runId);

        RecoveryManifest manifest = new()
        {
            Phase = UpdatePhase.PackageVerified,
            ExpectedVersion = VersionComparer.Normalize(expectedVersion),
            InstallDir = installDir,
            PackagePath = Path.GetFullPath(packagePath),
            StageDir = stageDir,
            BackupDir = backupDir,
            PreserveDir = preserveDir,
            StartedUtc = DateTimeOffset.UtcNow
        };
        manifest.Save(_paths.RecoveryManifestPath);

        try
        {
            Log($"Extracting package to {stageDir}");
            ZipPackageValidator.ExtractTo(packagePath, stageDir);
            manifest.Phase = UpdatePhase.Staged;
            manifest.Save(_paths.RecoveryManifestPath);

            List<string> preserveRelative = BuildPreserveSet(installDir, packageSet);
            manifest.PreservedUserFiles = preserveRelative;
            PreserveFiles(installDir, preserveDir, preserveRelative);
            manifest.Save(_paths.RecoveryManifestPath);

            Log($"Backing up replaceable files to {backupDir}");
            BackupReplaceableFiles(installDir, backupDir, packageSet);
            manifest.Phase = UpdatePhase.BackupComplete;
            manifest.Save(_paths.RecoveryManifestPath);

            Log("Applying staged files.");
            ApplyStagedFiles(stageDir, installDir, packageSet);
            RestorePreservedFiles(preserveDir, installDir, preserveRelative, packageSet);
            manifest.Phase = UpdatePhase.FilesApplied;
            manifest.Save(_paths.RecoveryManifestPath);

            VerifyInstallation(installDir, manifest.ExpectedVersion!, _versionReader);
            manifest.Phase = UpdatePhase.InstallVerified;
            manifest.Save(_paths.RecoveryManifestPath);

            if (relaunch)
            {
                string empExe = Path.Combine(installDir, "EMP.exe");
                Log($"Relaunching {empExe}");
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = empExe,
                    WorkingDirectory = installDir,
                    UseShellExecute = true
                });
                manifest.Phase = UpdatePhase.RelaunchRequested;
                manifest.Save(_paths.RecoveryManifestPath);
            }

            TryDeleteDirectory(stageDir);
            TryDeleteDirectory(preserveDir);
            // Keep backup until next successful cleanup window; mark complete.
            manifest.Phase = UpdatePhase.Complete;
            manifest.LastError = null;
            manifest.Save(_paths.RecoveryManifestPath);
            TryDeleteDirectory(backupDir);
        }
        catch (Exception ex)
        {
            Log($"Install failed: {ex.Message}");
            try
            {
                Rollback(manifest);
                manifest.Phase = UpdatePhase.RolledBack;
            }
            catch (Exception rollbackEx)
            {
                manifest.Phase = UpdatePhase.Failed;
                manifest.LastError = ex.Message + " | rollback: " + rollbackEx.Message;
                manifest.Save(_paths.RecoveryManifestPath);
                throw new UpdateException($"Update failed and rollback also failed: {rollbackEx.Message}", ex);
            }

            manifest.LastError = ex.Message;
            manifest.Save(_paths.RecoveryManifestPath);
            throw;
        }
    }

    public static List<string> BuildPreserveSet(string installDirectory, ISet<string> packageEntries)
    {
        List<string> preserve = [];
        if (!Directory.Exists(installDirectory))
        {
            return preserve;
        }

        foreach (string file in Directory.EnumerateFiles(installDirectory, "*", SearchOption.AllDirectories))
        {
            string relative = Path.GetRelativePath(installDirectory, file).Replace('\\', '/');
            bool knownArtwork = relative.StartsWith("www/artwork/", StringComparison.OrdinalIgnoreCase)
                || string.Equals(relative, "www/artwork", StringComparison.OrdinalIgnoreCase);
            if (knownArtwork || !packageEntries.Contains(relative))
            {
                preserve.Add(relative);
            }
        }

        return preserve;
    }

    public static void VerifyInstallation(
        string installDirectory,
        string expectedVersion,
        Func<string, string>? versionReader = null)
    {
        string emp = Path.Combine(installDirectory, "EMP.exe");
        string updater = Path.Combine(installDirectory, "EMP.Updater.exe");
        string index = Path.Combine(installDirectory, "www", "index.html");

        if (!File.Exists(emp))
        {
            throw new UpdateException("Updated installation is missing EMP.exe.");
        }

        if (!File.Exists(updater))
        {
            throw new UpdateException("Updated installation is missing EMP.Updater.exe.");
        }

        if (!File.Exists(index))
        {
            throw new UpdateException("Updated installation is missing www/index.html.");
        }

        Func<string, string> reader = versionReader ?? AppVersion.FromExecutable;
        string actual = reader(emp);
        if (!VersionComparer.TryParse(actual, out Version actualVersion)
            || !VersionComparer.TryParse(expectedVersion, out Version expected)
            || actualVersion.Major != expected.Major
            || actualVersion.Minor != expected.Minor
            || Math.Max(actualVersion.Build, 0) != Math.Max(expected.Build, 0))
        {
            throw new UpdateException($"Updated EMP version '{actual}' does not match expected '{expectedVersion}'.");
        }
    }

    private void Rollback(RecoveryManifest manifest)
    {
        if (string.IsNullOrWhiteSpace(manifest.InstallDir) || string.IsNullOrWhiteSpace(manifest.BackupDir))
        {
            return;
        }

        if (!Directory.Exists(manifest.BackupDir))
        {
            Log("No backup directory available for rollback.");
            return;
        }

        Log($"Rolling back from {manifest.BackupDir}");
        foreach (string file in Directory.EnumerateFiles(manifest.BackupDir, "*", SearchOption.AllDirectories))
        {
            string relative = Path.GetRelativePath(manifest.BackupDir, file);
            string target = Path.Combine(manifest.InstallDir, relative);
            string? parent = Path.GetDirectoryName(target);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                Directory.CreateDirectory(parent);
            }

            File.Copy(file, target, overwrite: true);
        }
    }

    private static void PreserveFiles(string installDir, string preserveDir, IEnumerable<string> relativePaths)
    {
        foreach (string relative in relativePaths)
        {
            string source = Path.Combine(installDir, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(source))
            {
                continue;
            }

            string target = Path.Combine(preserveDir, relative.Replace('/', Path.DirectorySeparatorChar));
            string? parent = Path.GetDirectoryName(target);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                Directory.CreateDirectory(parent);
            }

            File.Copy(source, target, overwrite: true);
        }
    }

    private static void BackupReplaceableFiles(string installDir, string backupDir, ISet<string> packageEntries)
    {
        Directory.CreateDirectory(backupDir);
        foreach (string relative in packageEntries)
        {
            string source = Path.Combine(installDir, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(source))
            {
                continue;
            }

            // Always preserve artwork separately; still back up if package also ships the path.
            string target = Path.Combine(backupDir, relative.Replace('/', Path.DirectorySeparatorChar));
            string? parent = Path.GetDirectoryName(target);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                Directory.CreateDirectory(parent);
            }

            File.Copy(source, target, overwrite: true);
        }
    }

    private static void ApplyStagedFiles(string stageDir, string installDir, ISet<string> packageEntries)
    {
        foreach (string relative in packageEntries)
        {
            // Do not replace preserved artwork from an empty/missing staged artwork file unless staged has content.
            if (relative.StartsWith("www/artwork/", StringComparison.OrdinalIgnoreCase))
            {
                string stagedArtwork = Path.Combine(stageDir, relative.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(stagedArtwork))
                {
                    continue;
                }
            }

            string source = Path.Combine(stageDir, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(source))
            {
                continue;
            }

            string target = Path.Combine(installDir, relative.Replace('/', Path.DirectorySeparatorChar));
            string? parent = Path.GetDirectoryName(target);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                Directory.CreateDirectory(parent);
            }

            File.Copy(source, target, overwrite: true);
        }
    }

    private static void RestorePreservedFiles(
        string preserveDir,
        string installDir,
        IEnumerable<string> relativePaths,
        ISet<string> packageEntries)
    {
        foreach (string relative in relativePaths)
        {
            bool isArtwork = relative.StartsWith("www/artwork/", StringComparison.OrdinalIgnoreCase);
            if (!isArtwork && packageEntries.Contains(relative))
            {
                // Package intentionally replaced this file.
                continue;
            }

            string source = Path.Combine(preserveDir, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(source))
            {
                continue;
            }

            if (isArtwork && packageEntries.Contains(relative))
            {
                string staged = Path.Combine(installDir, relative.Replace('/', Path.DirectorySeparatorChar));
                if (File.Exists(staged) && new FileInfo(staged).Length > 0)
                {
                    // Package shipped artwork; keep package version.
                    continue;
                }
            }

            string target = Path.Combine(installDir, relative.Replace('/', Path.DirectorySeparatorChar));
            string? parent = Path.GetDirectoryName(target);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                Directory.CreateDirectory(parent);
            }

            File.Copy(source, target, overwrite: true);
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception)
        {
            // Best effort.
        }
    }

    private void Log(string message) => _log?.Invoke(message);
}
