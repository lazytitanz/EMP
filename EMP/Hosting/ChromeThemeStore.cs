using System.Globalization;
using System.Text.Json;

namespace EMP.Hosting
{
    /// <summary>
    /// Persists the last resolved UI chrome colors so Form/WebView2 can match the
    /// theme before the frontend boots (avoids a black-frame flash in Light).
    /// </summary>
    internal static class ChromeThemeStore
    {
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true
        };

        private static string FilePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "chrome-theme.json");

        public static Color FormColor { get; private set; } = Color.Black;

        public static Color WebViewColor { get; private set; } = Color.FromArgb(18, 18, 18);

        public static string Theme { get; private set; } = "dark";

        public static void Load()
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    ApplyResolved("dark", persist: false);
                    return;
                }

                ChromeThemeFile? file = JsonSerializer.Deserialize<ChromeThemeFile>(
                    File.ReadAllText(FilePath),
                    JsonOptions);
                ApplyResolved(file?.Theme == "light" ? "light" : "dark", persist: false);
            }
            catch (Exception)
            {
                ApplyResolved("dark", persist: false);
            }
        }

        public static void ApplyResolved(string theme, bool persist = true)
        {
            Theme = theme == "light" ? "light" : "dark";
            if (Theme == "light")
            {
                // Match Light --emp-bg canvas so the 8-DIP gutter blends with the shell.
                FormColor = Color.FromArgb(238, 240, 243);
                WebViewColor = Color.FromArgb(238, 240, 243);
            }
            else
            {
                FormColor = Color.Black;
                WebViewColor = Color.FromArgb(18, 18, 18);
            }

            if (persist)
            {
                Write();
            }
        }

        public static void ApplyTo(Form form, Microsoft.Web.WebView2.WinForms.WebView2 webView)
        {
            ArgumentNullException.ThrowIfNull(form);
            ArgumentNullException.ThrowIfNull(webView);

            if (!form.IsDisposed)
            {
                form.BackColor = FormColor;
            }

            if (!webView.IsDisposed)
            {
                webView.DefaultBackgroundColor = WebViewColor;
            }
        }

        private static void Write()
        {
            try
            {
                string? directory = Path.GetDirectoryName(FilePath);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.WriteAllText(
                    FilePath,
                    JsonSerializer.Serialize(
                        new ChromeThemeFile
                        {
                            Theme = Theme,
                            Form = ToHex(FormColor),
                            WebView = ToHex(WebViewColor)
                        },
                        JsonOptions));
            }
            catch (Exception)
            {
                // In-memory colors still apply if persistence fails.
            }
        }

        private static string ToHex(Color color)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "#{0:X2}{1:X2}{2:X2}",
                color.R,
                color.G,
                color.B);
        }

        private sealed class ChromeThemeFile
        {
            public string? Theme { get; set; }

            public string? Form { get; set; }

            public string? WebView { get; set; }
        }
    }
}
