using System.Text;
using EMP.Lyrics;
using Xunit;

namespace EMP.Tests
{
    public sealed class LocalLyricsReaderTests : IDisposable
    {
        private const string SyncedLrc = "[ti:Lullaby]\n[00:01.50]First line\n[00:04.00]Second line\n";

        private readonly string root = MetadataTestFixtures.CreateTempMusicRoot();

        public void Dispose()
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (Exception)
            {
                // Temp cleanup is best-effort.
            }
        }

        [Fact]
        public void Sidecar_WithTimestamps_IsSynced_AndNamesTheFile()
        {
            string audio = MetadataTestFixtures.WriteSilentWav(root, "Lullaby.wav", title: "Lullaby");
            File.WriteAllText(Path.Combine(root, "Lullaby.lrc"), SyncedLrc, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));

            LyricsResult? result = LocalLyricsReader.TryRead(audio);

            Assert.NotNull(result);
            Assert.Equal(LyricsStatus.Found, result.Status);
            Assert.Equal(LyricsSource.LocalFile, result.Source);
            Assert.Equal("Lullaby.lrc", result.SourceName);
            Assert.True(result.HasSyncedLyrics);
            Assert.StartsWith("[ti:Lullaby]", result.SyncedLyrics);
            Assert.Null(result.PlainLyrics);
        }

        [Fact]
        public void Sidecar_WithoutTimestamps_IsPlain()
        {
            string audio = MetadataTestFixtures.WriteSilentWav(root, "Plain.wav", title: "Plain");
            File.WriteAllText(Path.Combine(root, "Plain.lrc"), "Just words\nNo timing here\n");

            LyricsResult? result = LocalLyricsReader.TryRead(audio);

            Assert.NotNull(result);
            Assert.False(result.HasSyncedLyrics);
            Assert.Equal("Just words\nNo timing here", result.PlainLyrics);
        }

        [Fact]
        public void Sidecar_MustShareTheSongsBaseName()
        {
            string audio = MetadataTestFixtures.WriteSilentWav(root, "Song A.wav", title: "Song A");
            File.WriteAllText(Path.Combine(root, "Song B.lrc"), SyncedLrc);

            Assert.Null(LocalLyricsReader.FindSidecar(audio));
            Assert.Null(LocalLyricsReader.TryReadSidecar(audio));
        }

        [Fact]
        public void Sidecar_EmptyOrOversized_IsIgnored()
        {
            string empty = MetadataTestFixtures.WriteSilentWav(root, "Empty.wav", title: "Empty");
            File.WriteAllText(Path.Combine(root, "Empty.lrc"), "  \n﻿\n");
            Assert.Null(LocalLyricsReader.TryReadSidecar(empty));

            string big = MetadataTestFixtures.WriteSilentWav(root, "Big.wav", title: "Big");
            File.WriteAllText(Path.Combine(root, "Big.lrc"), new string('a', (int)LocalLyricsReader.MaxSidecarBytes + 1));
            Assert.Null(LocalLyricsReader.TryReadSidecar(big));
        }

        [Fact]
        public void Embedded_TagLyrics_AreUsedWhenNoSidecar()
        {
            string audio = MetadataTestFixtures.WriteSilentWav(root, "Tagged.wav", title: "Tagged");
            using (TagLib.File file = TagLib.File.Create(audio))
            {
                file.Tag.Lyrics = SyncedLrc;
                file.Save();
            }

            LyricsResult? result = LocalLyricsReader.TryRead(audio);

            Assert.NotNull(result);
            Assert.Equal(LyricsSource.Embedded, result.Source);
            Assert.Null(result.SourceName);
            Assert.True(result.HasSyncedLyrics);
        }

        [Fact]
        public void Sidecar_WinsOverEmbedded()
        {
            string audio = MetadataTestFixtures.WriteSilentWav(root, "Both.wav", title: "Both");
            using (TagLib.File file = TagLib.File.Create(audio))
            {
                file.Tag.Lyrics = "embedded words";
                file.Save();
            }
            File.WriteAllText(Path.Combine(root, "Both.lrc"), SyncedLrc);

            Assert.Equal(LyricsSource.LocalFile, LocalLyricsReader.TryRead(audio)?.Source);
        }

        [Fact]
        public void MissingFileOrPath_ReturnsNull_WithoutThrowing()
        {
            Assert.Null(LocalLyricsReader.TryRead(null));
            Assert.Null(LocalLyricsReader.TryRead(Path.Combine(root, "missing.flac")));
        }
    }

    public sealed class LyricsCacheDeleteTests : IDisposable
    {
        private readonly string root = MetadataTestFixtures.CreateTempMusicRoot();

        public void Dispose()
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (Exception)
            {
                // Temp cleanup is best-effort.
            }
        }

        [Fact]
        public async Task Delete_ForgetsTheEntry_SoTheNextReadMisses()
        {
            LyricsCache cache = new(root);
            LyricsLookup lookup = new() { TrackId = "t1", Title = "Song", Artist = "Artist", Album = "Album", Duration = 120 };
            LyricsResult found = new() { Status = LyricsStatus.Found, PlainLyrics = "words" };

            await cache.WriteAsync(lookup, found, CancellationToken.None);
            Assert.NotNull(await cache.TryReadAsync(lookup, CancellationToken.None));

            cache.Delete("t1");
            Assert.Null(await cache.TryReadAsync(lookup, CancellationToken.None));

            cache.Delete("never-cached"); // No throw for a missing entry.
        }
    }
}
