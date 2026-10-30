using System.Diagnostics;

namespace EMP.UpdateCore;

public static class ProcessWaiter
{
    public static async Task WaitForExitAsync(
        int? processId,
        string installDirectory,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        string installFull = Path.GetFullPath(installDirectory)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        DateTime deadline = DateTime.UtcNow + timeout;

        if (processId is int pid)
        {
            try
            {
                using Process process = Process.GetProcessById(pid);
                while (!process.HasExited)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (DateTime.UtcNow > deadline)
                    {
                        throw new UpdateException($"Timed out waiting for EMP process {pid} to exit.");
                    }

                    await Task.Delay(250, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (ArgumentException)
            {
                // Already exited.
            }
        }

        while (DateTime.UtcNow <= deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!AnyEmpProcessInInstallDir(installFull))
            {
                return;
            }

            await Task.Delay(250, cancellationToken).ConfigureAwait(false);
        }

        throw new UpdateException("Timed out waiting for all EMP processes in the install directory to exit.");
    }

    private static bool AnyEmpProcessInInstallDir(string installFull)
    {
        foreach (Process process in Process.GetProcessesByName("EMP"))
        {
            try
            {
                string? path = process.MainModule?.FileName;
                if (string.IsNullOrWhiteSpace(path))
                {
                    continue;
                }

                string? directoryName = Path.GetDirectoryName(Path.GetFullPath(path));
                if (directoryName is null)
                {
                    continue;
                }

                string dir = directoryName.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (string.Equals(dir, installFull, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            catch (Exception)
            {
                // Access denied / process exited — ignore.
            }
            finally
            {
                process.Dispose();
            }
        }

        return false;
    }
}
