using System.Diagnostics;
using System.Reflection;

namespace EMP.UpdateCore;

public static class AppVersion
{
    public static string Current
    {
        get
        {
            Assembly assembly = Assembly.GetEntryAssembly() ?? typeof(AppVersion).Assembly;
            string? informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            if (!string.IsNullOrWhiteSpace(informational))
            {
                int metadata = informational.IndexOf('+', StringComparison.Ordinal);
                return metadata > 0 ? informational[..metadata] : informational;
            }

            return assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        }
    }

    public static string FromExecutable(string executablePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(executablePath);
        if (!File.Exists(executablePath))
        {
            throw new FileNotFoundException("Executable not found.", executablePath);
        }

        FileVersionInfo info = FileVersionInfo.GetVersionInfo(executablePath);
        if (!string.IsNullOrWhiteSpace(info.ProductVersion))
        {
            string product = info.ProductVersion;
            int metadata = product.IndexOf('+', StringComparison.Ordinal);
            return metadata > 0 ? product[..metadata] : product;
        }

        if (!string.IsNullOrWhiteSpace(info.FileVersion))
        {
            return info.FileVersion;
        }

        return "0.0.0";
    }
}
