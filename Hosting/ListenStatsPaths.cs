namespace EMP.Hosting
{
    /// <summary>
    /// Shared %LocalAppData%\EMP root for listening statistics files. Overridable in tests.
    /// </summary>
    internal static class ListenStatsPaths
    {
        private static string? overrideRoot;

        public static string RootDirectory =>
            overrideRoot
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "EMP");

        public static string ListenStatsFile => Path.Combine(RootDirectory, "listen-stats.json");

        public static string ListenHistoryFile => Path.Combine(RootDirectory, "listen-history.json");

        public static string ListenJournalFile => Path.Combine(RootDirectory, "listen-stats-journal.json");

        public static void SetRootForTests(string? root)
        {
            overrideRoot = root;
        }
    }
}
