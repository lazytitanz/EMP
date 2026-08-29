using System.Text.Json;
using EMP.Library;

namespace EMP.Hosting
{
    internal sealed class AppSettings
    {
        public string StartupOnLogin { get; set; } = "no";

        public bool CloseMinimizes { get; set; }

        public List<string>? MusicFolders { get; set; }
    }

    internal static class AppSettingsStore
    {
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true
        };

        private static string FilePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "settings.json");

        public static AppSettings Current { get; private set; } = new();

        public static event Action<AppSettings>? Changed;

        public static AppSettings Load()
        {
            Current = Normalize(Read() ?? new AppSettings());
            return Current;
        }

        public static void Save(AppSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);

            Current = Normalize(settings);
            Write(Current);
            StartupRegistration.Apply(Current.StartupOnLogin);
            Changed?.Invoke(Current);
        }

        public static string NormalizeStartup(string? value)
        {
            return value is "yes" or "minimized" ? value : "no";
        }

        public static IReadOnlyList<string> ResolvedMusicFolders()
        {
            if (Current.MusicFolders is null)
            {
                string? musicPath = MusicFolderPaths.TryNormalize(MusicLibraryScanner.DefaultMusicPath);
                return string.IsNullOrWhiteSpace(musicPath) ? [] : [musicPath];
            }

            return Current.MusicFolders;
        }

        public static void SaveMusicFolders(IEnumerable<string> folders)
        {
            Save(new AppSettings
            {
                StartupOnLogin = Current.StartupOnLogin,
                CloseMinimizes = Current.CloseMinimizes,
                MusicFolders = folders.ToList()
            });
        }

        private static AppSettings Normalize(AppSettings settings)
        {
            settings.StartupOnLogin = NormalizeStartup(settings.StartupOnLogin);
            if (settings.MusicFolders is not null)
            {
                settings.MusicFolders = MusicFolderPaths.NormalizeConfigured(settings.MusicFolders);
            }

            return settings;
        }

        private static AppSettings? Read()
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    return null;
                }

                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), JsonOptions);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void Write(AppSettings settings)
        {
            try
            {
                string? directory = Path.GetDirectoryName(FilePath);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.WriteAllText(FilePath, JsonSerializer.Serialize(settings, JsonOptions));
            }
            catch (Exception)
            {
                // Preferences still apply in-memory if the file cannot be written.
            }
        }
    }
}
