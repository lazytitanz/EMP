using System.Text.Json;

namespace EMP.Hosting
{
    internal static class WindowPlacementStore
    {
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true
        };

        private static string FilePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EMP",
            "window.json");

        public static void Restore(Form form)
        {
            ArgumentNullException.ThrowIfNull(form);

            WindowPlacement? placement = Read();
            if (placement is null || placement.Width < form.MinimumSize.Width || placement.Height < form.MinimumSize.Height)
            {
                return;
            }

            Rectangle bounds = new(placement.X, placement.Y, placement.Width, placement.Height);
            if (!IsVisibleOnAnyScreen(bounds))
            {
                return;
            }

            form.StartPosition = FormStartPosition.Manual;
            form.Location = bounds.Location;
            form.Size = bounds.Size;

            if (placement.Maximized)
            {
                form.WindowState = FormWindowState.Maximized;
            }
        }

        public static void Save(Form form)
        {
            ArgumentNullException.ThrowIfNull(form);

            Rectangle bounds = form.WindowState == FormWindowState.Normal
                ? form.Bounds
                : form.RestoreBounds;

            WindowPlacement placement = new()
            {
                X = bounds.X,
                Y = bounds.Y,
                Width = bounds.Width,
                Height = bounds.Height,
                Maximized = form.WindowState == FormWindowState.Maximized
            };

            try
            {
                string? directory = Path.GetDirectoryName(FilePath);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.WriteAllText(FilePath, JsonSerializer.Serialize(placement, JsonOptions));
            }
            catch (Exception)
            {
                // Ignore disk errors during shutdown.
            }
        }

        private static WindowPlacement? Read()
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    return null;
                }

                return JsonSerializer.Deserialize<WindowPlacement>(File.ReadAllText(FilePath), JsonOptions);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static bool IsVisibleOnAnyScreen(Rectangle bounds)
        {
            return Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(bounds));
        }

        private sealed class WindowPlacement
        {
            public int X { get; set; }

            public int Y { get; set; }

            public int Width { get; set; }

            public int Height { get; set; }

            public bool Maximized { get; set; }
        }
    }
}
