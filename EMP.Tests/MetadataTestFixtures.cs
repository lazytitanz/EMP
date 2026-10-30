using System.Text;
using EMP.Library;
using EMP.Library.Metadata;

namespace EMP.Tests
{
    internal static class MetadataTestFixtures
    {
        public static string CreateTempMusicRoot()
        {
            string root = Path.Combine(Path.GetTempPath(), "EMP-MetadataTests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        public static string WriteSilentWav(string directory, string fileName, string? title = null)
        {
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, fileName);
            const int sampleRate = 8000;
            const short channels = 1;
            const short bitsPerSample = 16;
            int sampleCount = sampleRate / 10;
            int dataSize = sampleCount * channels * (bitsPerSample / 8);

            using (FileStream stream = File.Create(path))
            using (BinaryWriter writer = new(stream, Encoding.ASCII, leaveOpen: true))
            {
                writer.Write(Encoding.ASCII.GetBytes("RIFF"));
                writer.Write(36 + dataSize);
                writer.Write(Encoding.ASCII.GetBytes("WAVE"));
                writer.Write(Encoding.ASCII.GetBytes("fmt "));
                writer.Write(16);
                writer.Write((short)1);
                writer.Write(channels);
                writer.Write(sampleRate);
                writer.Write(sampleRate * channels * bitsPerSample / 8);
                writer.Write((short)(channels * bitsPerSample / 8));
                writer.Write(bitsPerSample);
                writer.Write(Encoding.ASCII.GetBytes("data"));
                writer.Write(dataSize);
                writer.Write(new byte[dataSize]);
            }

            using (TagLib.File file = TagLib.File.Create(path))
            {
                if (!string.IsNullOrWhiteSpace(title))
                {
                    file.Tag.Title = title;
                }

                file.Tag.Performers = ["Fixture Artist"];
                file.Tag.AlbumArtists = ["Fixture Album Artist"];
                file.Tag.Album = "Fixture Album";
                file.Tag.Track = 1;
                file.Tag.Disc = 1;
                file.Tag.Genres = ["Fixture"];
                file.Tag.Year = 2024;
                file.Tag.Comment = "fixture";
                file.Tag.ReplayGainTrackGain = -3.5;
                file.Tag.ReplayGainTrackPeak = 0.95;
                file.Tag.ReplayGainAlbumGain = -4.0;
                file.Tag.ReplayGainAlbumPeak = 0.97;
                file.Save();
            }

            return path;
        }

        public static byte[] TinyPng()
        {
            // 1x1 PNG
            return Convert.FromBase64String(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6dUAAAAASUVORK5CYII=");
        }

        public static void IndexTrack(string trackId, string fullPath, string rootPath)
        {
            LibraryMediaIndex.Replace(new Dictionary<string, LibraryMediaLocation>(StringComparer.OrdinalIgnoreCase)
            {
                [trackId] = new LibraryMediaLocation
                {
                    TrackId = trackId,
                    FullPath = fullPath,
                    RootPath = rootPath,
                    Title = "Fixture",
                    Artist = "Fixture Artist",
                    Album = "Fixture Album",
                    Duration = 0.1
                }
            });
        }
    }
}
