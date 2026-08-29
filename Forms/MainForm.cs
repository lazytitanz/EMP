using EMP.Hosting;

namespace EMP.Forms
{
    public partial class MainForm : Form
    {
        private bool sessionSaved;
        private bool allowClose;
        private TaskbarThumbnailToolbar? thumbnailToolbar;
        private NotifyIcon? trayIcon;
        private ContextMenuStrip? trayMenu;

        public MainForm()
        {
            InitializeComponent();
            ApplyWindowIcon();
            AppSettingsStore.Load();
            StartupRegistration.Apply(AppSettingsStore.Current.StartupOnLogin);
            CreateTrayIcon();
            thumbnailToolbar = new TaskbarThumbnailToolbar(this, webView);
            WebUiHost.PlayingChanged += OnPlayingChanged;
            AppSettingsStore.Changed += OnAppSettingsChanged;
            HandleCreated += MainForm_HandleCreated;
            Shown += MainForm_Shown;
            FormClosed += MainForm_FormClosed;
            WindowPlacementStore.Restore(this);
            if (IsAutostartLaunch() && AppSettingsStore.Current.StartupOnLogin == "minimized")
            {
                WindowState = FormWindowState.Minimized;
            }
            if (IsHandleCreated)
            {
                thumbnailToolbar.TryAdd();
            }
        }

        private void ApplyWindowIcon()
        {
            string iconPath = Path.Combine(AppContext.BaseDirectory, "www", "img", "music.ico");
            if (File.Exists(iconPath))
            {
                using FileStream stream = File.OpenRead(iconPath);
                using Icon loaded = new(stream);
                Icon = (Icon)loaded.Clone();
                return;
            }

            try
            {
                Icon? associated = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (associated is not null)
                {
                    Icon = associated;
                }
            }
            catch (Exception)
            {
                // Keep the default window icon if the .ico cannot be loaded.
            }
        }

        private async void MainForm_Load(object sender, EventArgs e)
        {
            try
            {
                await WebUiHost.InitializeAsync(webView);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    this,
                    $"EMP could not start the WebView2 UI.{Environment.NewLine}{Environment.NewLine}{ex.Message}{Environment.NewLine}{Environment.NewLine}Install the Microsoft Edge WebView2 Runtime and try again.",
                    "EMP",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);

                allowClose = true;
                Close();
            }
        }

        private void MainForm_HandleCreated(object? sender, EventArgs e)
        {
            thumbnailToolbar?.TryAdd();
        }

        private void MainForm_Shown(object? sender, EventArgs e)
        {
            BeginInvoke(() => thumbnailToolbar?.TryAdd());
        }

        private void OnPlayingChanged(bool playing)
        {
            if (!IsHandleCreated)
            {
                return;
            }

            void Update() => thumbnailToolbar?.SetPlaying(playing);
            if (InvokeRequired)
            {
                BeginInvoke(Update);
            }
            else
            {
                Update();
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (thumbnailToolbar?.HandleWndProc(ref m) == true)
            {
                return;
            }

            base.WndProc(ref m);
        }

        private void CreateTrayIcon()
        {
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open EMP", null, (_, _) => RestoreFromTray());
            trayMenu.Items.Add("Quit EMP", null, (_, _) => QuitFromTray());

            trayIcon = new NotifyIcon
            {
                Icon = Icon ?? SystemIcons.Application,
                Text = "EMP",
                ContextMenuStrip = trayMenu,
                Visible = AppSettingsStore.Current.CloseMinimizes
            };
            trayIcon.DoubleClick += (_, _) => RestoreFromTray();
        }

        private void OnAppSettingsChanged(AppSettings settings)
        {
            void Apply()
            {
                if (trayIcon is not null)
                {
                    trayIcon.Visible = settings.CloseMinimizes;
                }
            }

            if (IsHandleCreated && InvokeRequired)
            {
                BeginInvoke(Apply);
                return;
            }

            Apply();
        }

        private void RestoreFromTray()
        {
            Show();
            if (WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
            }

            Activate();
        }

        private void QuitFromTray()
        {
            allowClose = true;
            Close();
        }

        private static bool IsAutostartLaunch()
        {
            return Environment.GetCommandLineArgs().Any(argument =>
                string.Equals(argument, "--autostart", StringComparison.OrdinalIgnoreCase));
        }

        private async void MainForm_FormClosing(object sender, FormClosingEventArgs e)
        {
            WindowPlacementStore.Save(this);

            if (!allowClose
                && AppSettingsStore.Current.CloseMinimizes
                && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                WindowState = FormWindowState.Minimized;
                return;
            }

            if (sessionSaved || webView.CoreWebView2 is null)
            {
                return;
            }

            e.Cancel = true;

            try
            {
                await webView.ExecuteScriptAsync("window.empSaveSession && window.empSaveSession();");
            }
            catch (Exception)
            {
                // The WebView may already be tearing down.
            }

            sessionSaved = true;
            BeginInvoke(Close);
        }

        private void MainForm_FormClosed(object? sender, FormClosedEventArgs e)
        {
            AppSettingsStore.Changed -= OnAppSettingsChanged;
            WebUiHost.PlayingChanged -= OnPlayingChanged;
            thumbnailToolbar?.Dispose();
            thumbnailToolbar = null;
            if (trayIcon is not null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
                trayIcon = null;
            }

            trayMenu?.Dispose();
            trayMenu = null;
            WebUiHost.Shutdown();
        }
    }
}
