using System.Text;

namespace EMP.Tests
{
    /// <summary>
    /// WebM test helpers. Audio/video samples are Chromium media test data
    /// (bear-opus.webm, bear-320x240.webm) shipped under Fixtures/Webm.
    /// </summary>
    internal static class WebmTestFixtures
    {
        private static string FixtureDirectory
        {
            get
            {
                string dir = Path.Combine(AppContext.BaseDirectory, "Fixtures", "Webm");
                if (!Directory.Exists(dir))
                {
                    throw new DirectoryNotFoundException(
                        "WebM fixtures not found at " + dir + ". Ensure EMP.Tests copies Fixtures/Webm to the output.");
                }

                return dir;
            }
        }

        public static string AudioOnlySourcePath => Path.Combine(FixtureDirectory, "bear-opus.webm");

        public static string VideoContainingSourcePath => Path.Combine(FixtureDirectory, "bear-320x240.webm");

        public static string WriteAudioOnly(
            string directory,
            string fileName,
            string? title = null,
            string? artist = null,
            string? album = null)
        {
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, fileName);
            File.Copy(AudioOnlySourcePath, path, overwrite: true);

            if (title is null && artist is null && album is null)
            {
                return path;
            }

            using TagLib.File file = TagLib.File.Create(path);
            if (!string.IsNullOrWhiteSpace(title))
            {
                file.Tag.Title = title;
            }

            if (!string.IsNullOrWhiteSpace(artist))
            {
                file.Tag.Performers = [artist];
            }

            if (!string.IsNullOrWhiteSpace(album))
            {
                file.Tag.Album = album;
            }

            file.Save();
            return path;
        }

        public static string WriteWithVideo(string directory, string fileName)
        {
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, fileName);
            File.Copy(VideoContainingSourcePath, path, overwrite: true);
            return path;
        }

        public static string WriteCorrupt(string directory, string fileName)
        {
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, fileName);
            File.WriteAllBytes(path, Encoding.ASCII.GetBytes("not-a-webm-file"));
            return path;
        }
    }
}
