using Microsoft.Win32;

namespace EMP.Hosting
{
    internal static class StartupRegistration
    {
        private const string ValueName = "EMP";
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public static void Apply(string startupOnLogin)
        {
            if (startupOnLogin is "yes" or "minimized")
            {
                Set();
                return;
            }

            Remove();
        }

        private static void Set()
        {
            try
            {
                using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true)
                    ?? Registry.CurrentUser.CreateSubKey(RunKeyPath);
                key?.SetValue(ValueName, $"\"{Application.ExecutablePath}\" --autostart");
            }
            catch (Exception)
            {
                // Startup still works for the current session if the registry cannot be written.
            }
        }

        private static void Remove()
        {
            try
            {
                using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
                if (key is null || key.GetValue(ValueName) is null)
                {
                    return;
                }

                key.DeleteValue(ValueName, throwOnMissingValue: false);
            }
            catch (Exception)
            {
                // Ignore registry errors when clearing the startup entry.
            }
        }
    }
}
