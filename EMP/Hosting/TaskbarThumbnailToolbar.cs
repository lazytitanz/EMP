using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.WinForms;

namespace EMP.Hosting
{
    internal sealed class TaskbarThumbnailToolbar : IDisposable
    {
        private const int PreviousId = 1;
        private const int PlayPauseId = 2;
        private const int NextId = 3;
        private const int PreviousImage = 0;
        private const int PlayImage = 1;
        private const int PauseImage = 2;
        private const int NextImage = 3;
        private const int WmCommand = 0x0111;
        private const int ThumbButtonClicked = 0x1800;
        private const uint MessageFilterAllow = 1;
        private const int IconSize = 16;

        private static readonly int TaskbarButtonCreated = NativeMethods.RegisterWindowMessage("TaskbarButtonCreated");

        private readonly Form form;
        private readonly WebView2 webView;
        private readonly ImageList imageList;
        private ITaskbarList3? taskbar;
        private bool added;
        private bool playing;
        private bool disposed;

        public TaskbarThumbnailToolbar(Form form, WebView2 webView)
        {
            ArgumentNullException.ThrowIfNull(form);
            ArgumentNullException.ThrowIfNull(webView);

            this.form = form;
            this.webView = webView;
            imageList = new ImageList
            {
                ColorDepth = ColorDepth.Depth32Bit,
                ImageSize = new Size(IconSize, IconSize)
            };
            imageList.Images.Add(ThumbnailIcons.PreviousBitmap());
            imageList.Images.Add(ThumbnailIcons.PlayBitmap());
            imageList.Images.Add(ThumbnailIcons.PauseBitmap());
            imageList.Images.Add(ThumbnailIcons.NextBitmap());
        }

        public void TryAdd()
        {
            if (disposed || added || !form.IsHandleCreated)
            {
                return;
            }

            try
            {
                NativeMethods.ChangeWindowMessageFilterEx(
                    form.Handle,
                    (uint)TaskbarButtonCreated,
                    MessageFilterAllow,
                    IntPtr.Zero);

                taskbar ??= (ITaskbarList3)new CTaskbarList();
                taskbar.HrInit();
                taskbar.ThumbBarSetImageList(form.Handle, imageList.Handle);

                int result = taskbar.ThumbBarAddButtons(form.Handle, 3, CreateButtons());
                added = result == 0;
            }
            catch (Exception)
            {
                added = false;
            }
        }

        public void SetPlaying(bool isPlaying)
        {
            playing = isPlaying;
            if (!added || taskbar is null || disposed || !form.IsHandleCreated)
            {
                return;
            }

            try
            {
                _ = taskbar.ThumbBarUpdateButtons(form.Handle, 3, CreateButtons());
            }
            catch (Exception)
            {
                // The taskbar button may not exist yet.
            }
        }

        public bool HandleWndProc(ref Message message)
        {
            if (message.Msg == TaskbarButtonCreated)
            {
                added = false;
                TryAdd();
                if (playing)
                {
                    SetPlaying(true);
                }

                return false;
            }

            if (message.Msg != WmCommand)
            {
                return false;
            }

            int wparam = unchecked((int)(long)message.WParam);
            int notification = (wparam >> 16) & 0xFFFF;
            if (notification != ThumbButtonClicked)
            {
                return false;
            }

            int id = wparam & 0xFFFF;
            string command = id switch
            {
                PreviousId => "previous",
                PlayPauseId => "toggle",
                NextId => "next",
                _ => string.Empty
            };

            if (command.Length == 0)
            {
                return false;
            }

            _ = SendCommandAsync(command);
            return true;
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            imageList.Dispose();

            if (taskbar is not null)
            {
                Marshal.ReleaseComObject(taskbar);
                taskbar = null;
            }
        }

        private THUMBBUTTON[] CreateButtons()
        {
            return
            [
                Button(PreviousId, PreviousImage, "Previous"),
                Button(PlayPauseId, playing ? PauseImage : PlayImage, playing ? "Pause" : "Play"),
                Button(NextId, NextImage, "Next")
            ];
        }

        private static THUMBBUTTON Button(int id, int imageIndex, string tooltip)
        {
            return new THUMBBUTTON
            {
                dwMask = ThumbMask.Bitmap | ThumbMask.Tooltip | ThumbMask.Flags,
                iId = (uint)id,
                iBitmap = (uint)imageIndex,
                hIcon = IntPtr.Zero,
                szTip = tooltip,
                dwFlags = ThumbFlags.Enabled
            };
        }

        private async Task SendCommandAsync(string command)
        {
            if (webView.CoreWebView2 is null || disposed)
            {
                return;
            }

            try
            {
                await webView.ExecuteScriptAsync(
                    $"window.empMediaCommand && window.empMediaCommand('{command}');");
            }
            catch (Exception)
            {
                // The WebView may already be tearing down.
            }
        }

        [ComImport]
        [Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
        [ClassInterface(ClassInterfaceType.None)]
        private class CTaskbarList
        {
        }

        [ComImport]
        [Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ITaskbarList3
        {
            void HrInit();

            void AddTab(IntPtr hwnd);

            void DeleteTab(IntPtr hwnd);

            void ActivateTab(IntPtr hwnd);

            void SetActiveAlt(IntPtr hwnd);

            void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);

            void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);

            void SetProgressState(IntPtr hwnd, int flags);

            void RegisterTab(IntPtr hwndTab, IntPtr hwndMdi);

            void UnregisterTab(IntPtr hwndTab);

            void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);

            void SetTabActive(IntPtr hwndTab, IntPtr hwndMdi, uint reserved);

            [PreserveSig]
            int ThumbBarAddButtons(
                IntPtr hwnd,
                uint count,
                [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] THUMBBUTTON[] buttons);

            [PreserveSig]
            int ThumbBarUpdateButtons(
                IntPtr hwnd,
                uint count,
                [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] THUMBBUTTON[] buttons);

            void ThumbBarSetImageList(IntPtr hwnd, IntPtr imageList);

            void SetOverlayIcon(IntPtr hwnd, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);

            void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string tip);

            void SetThumbnailClip(IntPtr hwnd, IntPtr clip);
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct THUMBBUTTON
        {
            public ThumbMask dwMask;
            public uint iId;
            public uint iBitmap;
            public IntPtr hIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szTip;
            public ThumbFlags dwFlags;
        }

        [Flags]
        private enum ThumbMask : uint
        {
            Bitmap = 0x1,
            Icon = 0x2,
            Tooltip = 0x4,
            Flags = 0x8
        }

        [Flags]
        private enum ThumbFlags : uint
        {
            Enabled = 0,
            Disabled = 0x1
        }

        private static class NativeMethods
        {
            [DllImport("user32.dll", CharSet = CharSet.Unicode)]
            public static extern int RegisterWindowMessage(string message);

            [DllImport("user32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool ChangeWindowMessageFilterEx(
                IntPtr hwnd,
                uint message,
                uint action,
                IntPtr changeFilter);
        }
    }

    internal static class ThumbnailIcons
    {
        public static Bitmap PreviousBitmap() => FromDraw(static g =>
        {
            using SolidBrush brush = new(Color.White);
            g.FillRectangle(brush, 2, 3, 2, 10);
            g.FillPolygon(brush, [new Point(13, 3), new Point(13, 13), new Point(5, 8)]);
        });

        public static Bitmap PlayBitmap() => FromDraw(static g =>
        {
            using SolidBrush brush = new(Color.White);
            g.FillPolygon(brush, [new Point(4, 2), new Point(4, 14), new Point(13, 8)]);
        });

        public static Bitmap PauseBitmap() => FromDraw(static g =>
        {
            using SolidBrush brush = new(Color.White);
            g.FillRectangle(brush, 4, 3, 3, 10);
            g.FillRectangle(brush, 9, 3, 3, 10);
        });

        public static Bitmap NextBitmap() => FromDraw(static g =>
        {
            using SolidBrush brush = new(Color.White);
            g.FillPolygon(brush, [new Point(3, 3), new Point(3, 13), new Point(11, 8)]);
            g.FillRectangle(brush, 12, 3, 2, 10);
        });

        private static Bitmap FromDraw(Action<Graphics> draw)
        {
            Bitmap bitmap = new(16, 16, PixelFormat.Format32bppArgb);
            using Graphics graphics = Graphics.FromImage(bitmap);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.Clear(Color.Transparent);
            draw(graphics);
            return bitmap;
        }
    }
}
