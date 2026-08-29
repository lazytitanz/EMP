using System.Runtime.InteropServices;
using EMP.Forms;

namespace EMP
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            NativeMethods.SetCurrentProcessExplicitAppUserModelID("EMP.MusicPlayer");
            ApplicationConfiguration.Initialize();
            Application.Run(new MainForm());
        }

        private static class NativeMethods
        {
            [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
            public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
        }
    }
}
