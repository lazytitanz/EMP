using System.Diagnostics;
using System.Reflection;
using Sonora.Audio;

namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Reads the installed Sonora package/assembly informational version for About UI.
    /// Prefers <c>Sonora.Audio.Windows</c> (EMP's PackageReference) when loaded.
    /// </summary>
    internal static class SonoraPackageVersion
    {
        public static string Current => FromAssembly(typeof(AudioEngine).Assembly);

        internal static string FromAssembly(Assembly fallbackAssembly)
        {
            ArgumentNullException.ThrowIfNull(fallbackAssembly);

            Assembly target = fallbackAssembly;
            foreach (Assembly candidate in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (string.Equals(candidate.GetName().Name, "Sonora.Audio.Windows", StringComparison.Ordinal))
                {
                    target = candidate;
                    break;
                }
            }

            string? informational = target.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            if (!string.IsNullOrWhiteSpace(informational))
            {
                return StripBuildMetadata(informational);
            }

            if (!string.IsNullOrWhiteSpace(target.Location))
            {
                try
                {
                    FileVersionInfo info = FileVersionInfo.GetVersionInfo(target.Location);
                    if (!string.IsNullOrWhiteSpace(info.ProductVersion))
                    {
                        return StripBuildMetadata(info.ProductVersion);
                    }
                }
                catch (FileNotFoundException)
                {
                    // Fall through to assembly version.
                }
            }

            return target.GetName().Version?.ToString() ?? "0.0.0";
        }

        internal static string StripBuildMetadata(string version)
        {
            int metadata = version.IndexOf('+', StringComparison.Ordinal);
            return metadata > 0 ? version[..metadata] : version;
        }
    }
}
