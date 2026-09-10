using System.Runtime.InteropServices;

namespace EMP.Hosting
{
    /// <summary>
    /// Borderless frame helper: resize-edge hit testing, maximize work-area bounds,
    /// and caption drag started from WebView pointer events (BeginDrag).
    /// CSS app-region is used only on the dedicated window-chrome strip; the in-page
    /// top bar uses BeginDrag because Chromium app-region ignores scroll occlusion.
    /// Native WM_NCHITTEST never returns HTCAPTION.
    /// </summary>
    internal sealed class CustomWindowChrome
    {
        private const int WmNcHitTest = 0x0084;
        private const int WmGetMinMaxInfo = 0x0024;
        private const int WmDwmCompositionChanged = 0x031E;

        private const int HtClient = 1;
        private const int HtCaption = 2;
        private const int HtLeft = 10;
        private const int HtRight = 11;
        private const int HtTop = 12;
        private const int HtTopLeft = 13;
        private const int HtTopRight = 14;
        private const int HtBottom = 15;
        private const int HtBottomLeft = 16;
        private const int HtBottomRight = 17;

        private const int WmNcLButtonDown = 0x00A1;
        private const int WsThickFrame = 0x00040000;
        private const int WsMinimizeBox = 0x00020000;
        private const int WsMaximizeBox = 0x00010000;
        private const int WsSysMenu = 0x00080000;

        private const int DwmwaWindowCornerPreference = 33;
        private const int DwmwaBorderColor = 34;
        private const int DwmwaCaptionColor = 35;
        private const int DwmWcpDefault = 0;
        private const int DwmWcpDonotround = 1;
        private const int DwmWcpRound = 2;
        // COLORREF black — hides the Win11 light system border that otherwise
        // shows as a 1px white strip along the top of borderless windows.
        private const int DwmColorBlack = 0x000000;

        // Match EMP shell --gap so the resize margin reads as the existing black gutter.
        private const int ResizeBorderDip = 8;

        private readonly Form form;

        public CustomWindowChrome(Form form)
        {
            ArgumentNullException.ThrowIfNull(form);
            this.form = form;
        }

        public void Apply()
        {
            form.FormBorderStyle = FormBorderStyle.None;
            SyncFrameChrome();
        }

        public static void ModifyCreateParams(CreateParams createParams)
        {
            createParams.Style |= WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSysMenu;
        }

        public void SyncFrameChrome()
        {
            int border = form.WindowState == FormWindowState.Maximized ? 0 : ResizeBorderThickness();
            Padding padding = new(border);
            if (form.Padding != padding)
            {
                form.Padding = padding;
            }

            TrySetDwmAttributes(form.WindowState == FormWindowState.Maximized
                ? DwmWcpDonotround
                : DwmWcpRound);
        }

        public bool HandleWndProc(ref Message message)
        {
            switch (message.Msg)
            {
                case WmNcHitTest:
                    return HandleNcHitTest(ref message);
                case WmGetMinMaxInfo:
                    HandleGetMinMaxInfo(message.LParam);
                    message.Result = IntPtr.Zero;
                    return true;
                case WmDwmCompositionChanged:
                    SyncFrameChrome();
                    return false;
                default:
                    return false;
            }
        }

        public void Minimize()
        {
            form.WindowState = FormWindowState.Minimized;
        }

        public void ToggleMaximize()
        {
            form.WindowState = form.WindowState == FormWindowState.Maximized
                ? FormWindowState.Normal
                : FormWindowState.Maximized;
        }

        /// <summary>
        /// Starts a native caption drag from a client-area pointer event.
        /// Used for the in-page top bar where CSS app-region loses to scrolled content.
        /// </summary>
        public void BeginDrag()
        {
            if (!form.IsHandleCreated || form.WindowState == FormWindowState.Minimized)
            {
                return;
            }

            _ = NativeMethods.ReleaseCapture();
            _ = NativeMethods.SendMessage(
                form.Handle,
                WmNcLButtonDown,
                (IntPtr)HtCaption,
                IntPtr.Zero);
        }

        private bool HandleNcHitTest(ref Message message)
        {
            if (form.WindowState == FormWindowState.Maximized)
            {
                message.Result = (IntPtr)HtClient;
                return true;
            }

            Point screen = new(
                unchecked((short)(long)message.LParam),
                unchecked((short)((long)message.LParam >> 16)));
            Point client = form.PointToClient(screen);
            Size size = form.ClientSize;
            int border = ResizeBorderThickness();

            bool left = client.X >= 0 && client.X < border;
            bool right = client.X >= size.Width - border && client.X < size.Width;
            bool top = client.Y >= 0 && client.Y < border;
            bool bottom = client.Y >= size.Height - border && client.Y < size.Height;

            if (!left && !right && !top && !bottom)
            {
                message.Result = (IntPtr)HtClient;
                return true;
            }

            if (top && left)
            {
                message.Result = (IntPtr)HtTopLeft;
            }
            else if (top && right)
            {
                message.Result = (IntPtr)HtTopRight;
            }
            else if (bottom && left)
            {
                message.Result = (IntPtr)HtBottomLeft;
            }
            else if (bottom && right)
            {
                message.Result = (IntPtr)HtBottomRight;
            }
            else if (left)
            {
                message.Result = (IntPtr)HtLeft;
            }
            else if (right)
            {
                message.Result = (IntPtr)HtRight;
            }
            else if (top)
            {
                message.Result = (IntPtr)HtTop;
            }
            else
            {
                message.Result = (IntPtr)HtBottom;
            }

            return true;
        }

        private void HandleGetMinMaxInfo(IntPtr lParam)
        {
            MinMaxInfo info = Marshal.PtrToStructure<MinMaxInfo>(lParam);
            Screen screen = Screen.FromHandle(form.Handle);
            Rectangle work = screen.WorkingArea;
            Rectangle bounds = screen.Bounds;

            info.PtMaxPosition.X = work.Left - bounds.Left;
            info.PtMaxPosition.Y = work.Top - bounds.Top;
            info.PtMaxSize.X = work.Width;
            info.PtMaxSize.Y = work.Height;
            info.PtMaxTrackSize.X = work.Width;
            info.PtMaxTrackSize.Y = work.Height;

            Size min = form.MinimumSize;
            if (min.Width > 0)
            {
                info.PtMinTrackSize.X = min.Width;
            }

            if (min.Height > 0)
            {
                info.PtMinTrackSize.Y = min.Height;
            }

            Marshal.StructureToPtr(info, lParam, false);
        }

        private int ResizeBorderThickness()
        {
            float scale = form.DeviceDpi / 96f;
            return Math.Max(4, (int)Math.Round(ResizeBorderDip * scale));
        }

        private void TrySetDwmAttributes(int cornerPreference)
        {
            if (!form.IsHandleCreated)
            {
                return;
            }

            try
            {
                int corner = cornerPreference;
                _ = NativeMethods.DwmSetWindowAttribute(
                    form.Handle,
                    DwmwaWindowCornerPreference,
                    ref corner,
                    sizeof(int));

                int borderColor = DwmColorBlack;
                _ = NativeMethods.DwmSetWindowAttribute(
                    form.Handle,
                    DwmwaBorderColor,
                    ref borderColor,
                    sizeof(int));

                int captionColor = DwmColorBlack;
                _ = NativeMethods.DwmSetWindowAttribute(
                    form.Handle,
                    DwmwaCaptionColor,
                    ref captionColor,
                    sizeof(int));
            }
            catch (Exception)
            {
                // DWM attributes are best-effort on older builds.
            }
        }

        private static class NativeMethods
        {
            [DllImport("user32.dll")]
            public static extern bool ReleaseCapture();

            [DllImport("user32.dll")]
            public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

            [DllImport("dwmapi.dll", PreserveSig = true)]
            public static extern int DwmSetWindowAttribute(
                IntPtr hwnd,
                int attribute,
                ref int attributeValue,
                int attributeSize);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PointApi
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MinMaxInfo
        {
            public PointApi PtReserved;
            public PointApi PtMaxSize;
            public PointApi PtMaxPosition;
            public PointApi PtMinTrackSize;
            public PointApi PtMaxTrackSize;
        }
    }
}
