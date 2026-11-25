using System.Runtime.InteropServices;

namespace EMP.Hosting
{
    /// <summary>
    /// Opens File Explorer with a file selected, via SHOpenFolderAndSelectItems — the same API
    /// Explorer's own "Open file location" uses. No process command line is assembled, so a path
    /// can never be interpreted as arguments. Read-only: nothing on disk is changed.
    /// </summary>
    internal static class ShellReveal
    {
        /// <summary>
        /// The file to select, or null when the path is not a fully qualified, existing file
        /// (missing file, unavailable drive, relative or malformed path).
        /// </summary>
        internal static string? ResolveRevealTarget(string? fullPath)
        {
            if (string.IsNullOrWhiteSpace(fullPath))
            {
                return null;
            }

            try
            {
                if (!Path.IsPathFullyQualified(fullPath))
                {
                    return null;
                }

                string normalized = Path.GetFullPath(fullPath);
                return File.Exists(normalized) ? normalized : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static bool TryRevealFile(string? fullPath)
        {
            string? target = ResolveRevealTarget(fullPath);
            if (target is null)
            {
                return false;
            }

            IntPtr item = IntPtr.Zero;
            try
            {
                item = NativeMethods.ILCreateFromPathW(target);
                if (item == IntPtr.Zero)
                {
                    return false;
                }

                return NativeMethods.SHOpenFolderAndSelectItems(item, 0, null, 0) == 0;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                if (item != IntPtr.Zero)
                {
                    NativeMethods.ILFree(item);
                }
            }
        }

        private static class NativeMethods
        {
            [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            public static extern IntPtr ILCreateFromPathW(string path);

            [DllImport("shell32.dll", ExactSpelling = true)]
            public static extern void ILFree(IntPtr pidl);

            [DllImport("shell32.dll", ExactSpelling = true)]
            public static extern int SHOpenFolderAndSelectItems(IntPtr pidlFolder, uint cidl, IntPtr[]? apidl, uint flags);
        }
    }
}
