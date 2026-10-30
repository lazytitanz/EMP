using System.Text;
using EMP.UpdateCore;

namespace EMP.Updater;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            UpdaterArgs parsed = UpdaterArgs.Parse(args);
            UpdatePaths paths = new(parsed.UpdatesRoot);
            paths.EnsureCreated();

            using StreamWriter logWriter = new(paths.UpdaterLogPath, append: true, Encoding.UTF8);
            void Log(string message)
            {
                string line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} {message}";
                logWriter.WriteLine(line);
                logWriter.Flush();
                DebugWrite(line);
            }

            Log($"EMP.Updater starting. install={parsed.InstallDir} expected={parsed.ExpectedVersion}");
            UpdateInstaller installer = new(paths, Log);

            installer.RecoverInterruptedIfNeeded();

            if (string.IsNullOrWhiteSpace(parsed.PackagePath))
            {
                Log("No package path provided; recovery-only run complete.");
                return 0;
            }

            RecoveryManifest? manifest = RecoveryManifest.TryLoad(paths.RecoveryManifestPath) ?? new RecoveryManifest
            {
                StartedUtc = DateTimeOffset.UtcNow
            };
            manifest.Phase = UpdatePhase.WaitingForExit;
            manifest.InstallDir = parsed.InstallDir;
            manifest.PackagePath = parsed.PackagePath;
            manifest.ExpectedVersion = parsed.ExpectedVersion;
            manifest.Save(paths.RecoveryManifestPath);

            ProcessWaiter.WaitForExitAsync(
                parsed.Pid,
                parsed.InstallDir,
                TimeSpan.FromMinutes(2)).GetAwaiter().GetResult();

            installer.Install(
                parsed.PackagePath,
                parsed.InstallDir,
                parsed.ExpectedVersion!,
                parsed.Relaunch);

            Log("Update completed successfully.");
            return 0;
        }
        catch (Exception ex)
        {
            DebugWrite("EMP.Updater failed: " + ex);
            try
            {
                MessageBox.Show(
                    "EMP could not finish installing the update." + Environment.NewLine + Environment.NewLine + ex.Message
                    + Environment.NewLine + Environment.NewLine
                    + "If EMP is installed in a protected folder (for example Program Files), move it to a user-writable folder and try again.",
                    "EMP Updater",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            catch (Exception)
            {
                // Headless environments may not support MessageBox.
            }

            return 1;
        }
    }

    private static void DebugWrite(string message)
    {
        System.Diagnostics.Debug.WriteLine(message);
        try
        {
            Console.Error.WriteLine(message);
        }
        catch (Exception)
        {
            // Ignore console failures for WinExe.
        }
    }
}

internal sealed class UpdaterArgs
{
    public string InstallDir { get; init; } = "";

    public string? PackagePath { get; init; }

    public string? ExpectedVersion { get; init; }

    public int? Pid { get; init; }

    public string UpdatesRoot { get; init; } = UpdatePaths.DefaultLocalAppData().UpdatesRoot;

    public bool Relaunch { get; init; }

    public static UpdaterArgs Parse(string[] args)
    {
        Dictionary<string, string?> map = new(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            string key = arg[2..];
            string? value = null;
            if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                value = args[++i];
            }

            map[key] = value;
        }

        if (!map.TryGetValue("install-dir", out string? installDir) || string.IsNullOrWhiteSpace(installDir))
        {
            throw new ArgumentException("Missing required --install-dir argument.");
        }

        string updatesRoot = UpdatePaths.DefaultLocalAppData().UpdatesRoot;
        if (map.TryGetValue("updates-root", out string? updates) && !string.IsNullOrWhiteSpace(updates))
        {
            updatesRoot = updates;
        }

        int? pid = null;
        if (map.TryGetValue("pid", out string? pidText) && int.TryParse(pidText, out int parsedPid))
        {
            pid = parsedPid;
        }

        string? package = map.TryGetValue("package", out string? packagePath) ? packagePath : null;
        string? expected = map.TryGetValue("expected-version", out string? expectedVersion) ? expectedVersion : null;
        if (!string.IsNullOrWhiteSpace(package) && string.IsNullOrWhiteSpace(expected))
        {
            throw new ArgumentException("Missing required --expected-version when --package is provided.");
        }

        return new UpdaterArgs
        {
            InstallDir = Path.GetFullPath(installDir),
            PackagePath = string.IsNullOrWhiteSpace(package) ? null : Path.GetFullPath(package),
            ExpectedVersion = expected,
            Pid = pid,
            UpdatesRoot = Path.GetFullPath(updatesRoot),
            Relaunch = map.ContainsKey("relaunch")
        };
    }
}
