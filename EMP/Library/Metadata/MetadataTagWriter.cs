using System.Runtime.InteropServices;

namespace EMP.Library.Metadata
{
    internal static class MetadataTagWriter
    {
        private const long SpaceMarginBytes = 256 * 1024;
        private const int CopyBufferSize = 82 * 1024;

        public static MetadataFileResult Apply(
            string trackId,
            string path,
            MetadataTrackEdit edit,
            Func<string, (bool Busy, MetadataErrorCode Code)> busyCheck)
        {
            ArgumentNullException.ThrowIfNull(edit);

            if (!File.Exists(path))
            {
                return Fail(trackId, MetadataErrorCode.NotFound);
            }

            if (MusicLibraryScanner.IsWebmExtension(Path.GetExtension(path)))
            {
                return Fail(trackId, MetadataErrorCode.Unsupported);
            }

            (bool busy, MetadataErrorCode busyCode) = busyCheck(trackId);
            if (busy)
            {
                return Fail(trackId, busyCode);
            }

            FileInfo info = new(path);
            if (info.IsReadOnly)
            {
                return Fail(trackId, MetadataErrorCode.ReadOnly);
            }

            string? directory = Path.GetDirectoryName(path);
            if (string.IsNullOrWhiteSpace(directory) || !IsDirectoryWritable(directory))
            {
                return Fail(trackId, MetadataErrorCode.ReadOnlyFolder);
            }

            if (edit.ExpectedLastWriteUtcTicks is long expectedTicks
                && edit.ExpectedLength is long expectedLength
                && (info.LastWriteTimeUtc.Ticks != expectedTicks || info.Length != expectedLength))
            {
                return Fail(trackId, MetadataErrorCode.ExternalChange);
            }

            if (!HasAnyChange(edit))
            {
                return new MetadataFileResult
                {
                    TrackId = trackId,
                    Succeeded = true,
                    ErrorCode = MetadataErrorCode.NoChanges,
                    ErrorMessage = MetadataErrorMessages.For(MetadataErrorCode.NoChanges)
                };
            }

            byte[]? artworkBytes = null;
            string? artworkMime = null;
            if (edit.Artwork?.Op == MetadataArtworkOp.Set)
            {
                try
                {
                    artworkBytes = Convert.FromBase64String(edit.Artwork.DataBase64 ?? string.Empty);
                }
                catch (FormatException)
                {
                    return Fail(trackId, MetadataErrorCode.InvalidImage);
                }

                if (!ArtworkImageValidator.TryValidate(artworkBytes, edit.Artwork.Mime, out artworkMime, out _))
                {
                    return Fail(trackId, MetadataErrorCode.InvalidImage);
                }
            }

            if (!HasEnoughFreeSpace(directory, info.Length + SpaceMarginBytes))
            {
                return Fail(trackId, MetadataErrorCode.InsufficientSpace);
            }

            // Keep the original extension so TagLib can identify the format. Avoid a trailing
            // ".tmp" name — TagLib's own save temp naming conflicts with that pattern.
            string tempPath = Path.Combine(
                directory,
                Path.GetFileNameWithoutExtension(path)
                    + ".emp-meta-"
                    + Guid.NewGuid().ToString("N")
                    + Path.GetExtension(path));

            try
            {
                StreamCopy(path, tempPath);

                ReplayGainSnapshot beforeGain;
                using (TagLib.File probe = TagLib.File.Create(tempPath))
                {
                    beforeGain = ReplayGainSnapshot.Capture(probe);
                    ApplyEdits(probe, edit, artworkBytes, artworkMime);
                    beforeGain.Restore(probe);
                    probe.Save();
                }

                // Best-effort ReplayGain check. Some formats cannot round-trip RG tags;
                // never treat NaN↔NaN as failure, and only fail when finite values diverge.
                using (TagLib.File verify = TagLib.File.Create(tempPath))
                {
                    ReplayGainSnapshot after = ReplayGainSnapshot.Capture(verify);
                    if (beforeGain.HasFiniteValues && !after.Matches(beforeGain))
                    {
                        beforeGain.Restore(verify);
                        verify.Save();
                        after = ReplayGainSnapshot.Capture(verify);
                        if (beforeGain.HasFiniteValues && !after.Matches(beforeGain))
                        {
                            TryDelete(tempPath);
                            return Fail(trackId, MetadataErrorCode.WriteFailed, "ReplayGain could not be preserved.");
                        }
                    }
                }

                try
                {
                    // Prefer Replace; fall back to delete+move when Replace is unavailable.
                    if (!TryReplace(tempPath, path))
                    {
                        TryDelete(tempPath);
                        return Fail(trackId, MetadataErrorCode.WriteFailed, "Could not replace the original file.");
                    }
                }
                catch (Exception ex)
                {
                    TryDelete(tempPath);
                    return Fail(trackId, MetadataErrorCode.WriteFailed, ex.Message);
                }

                tempPath = string.Empty;
                bool artworkChanged = edit.Artwork is { Op: MetadataArtworkOp.Set or MetadataArtworkOp.Clear };
                return new MetadataFileResult
                {
                    TrackId = trackId,
                    Succeeded = true,
                    ArtworkChanged = artworkChanged
                };
            }
            catch (UnauthorizedAccessException)
            {
                TryDelete(tempPath);
                return Fail(trackId, MetadataErrorCode.ReadOnly);
            }
            catch (IOException ex)
            {
                TryDelete(tempPath);
                return Fail(trackId, MetadataErrorCode.WriteFailed, ex.Message);
            }
            catch (Exception ex)
            {
                TryDelete(tempPath);
                return Fail(trackId, MetadataErrorCode.WriteFailed, ex.Message);
            }
            finally
            {
                if (!string.IsNullOrWhiteSpace(tempPath))
                {
                    TryDelete(tempPath);
                }
            }
        }

        private static bool TryReplace(string tempPath, string originalPath)
        {
            try
            {
                File.Replace(tempPath, originalPath, destinationBackupFileName: null, ignoreMetadataErrors: true);
                return true;
            }
            catch (PlatformNotSupportedException)
            {
                // Fall through.
            }
            catch (IOException)
            {
                // Fall through to move strategy.
            }

            string backupPath = originalPath + ".emp-bak-" + Guid.NewGuid().ToString("N");
            try
            {
                File.Move(originalPath, backupPath);
                File.Move(tempPath, originalPath);
                TryDelete(backupPath);
                return true;
            }
            catch (Exception)
            {
                if (!File.Exists(originalPath) && File.Exists(backupPath))
                {
                    try
                    {
                        File.Move(backupPath, originalPath);
                    }
                    catch (Exception)
                    {
                        // Original restore best-effort.
                    }
                }

                TryDelete(backupPath);
                return false;
            }
        }

        public static bool HasAnyChange(MetadataTrackEdit edit)
        {
            return IsActive(edit.Title)
                || IsActive(edit.Artist)
                || IsActive(edit.AlbumArtist)
                || IsActive(edit.Album)
                || IsActive(edit.TrackNumber)
                || IsActive(edit.DiscNumber)
                || IsActive(edit.Genre)
                || IsActive(edit.Year)
                || IsActive(edit.Comment)
                || edit.Artwork is { Op: MetadataArtworkOp.Set or MetadataArtworkOp.Clear };
        }

        private static bool IsActive(MetadataFieldEdit? edit)
        {
            return edit is { Op: MetadataFieldOp.Set or MetadataFieldOp.Clear };
        }

        private static void ApplyEdits(
            TagLib.File file,
            MetadataTrackEdit edit,
            byte[]? artworkBytes,
            string? artworkMime)
        {
            ApplyString(file.Tag, edit.Title, value => file.Tag.Title = value, () => file.Tag.Title = null);
            ApplyString(file.Tag, edit.Artist, value => file.Tag.Performers = [value], () => file.Tag.Performers = []);
            ApplyString(file.Tag, edit.AlbumArtist, value => file.Tag.AlbumArtists = [value], () => file.Tag.AlbumArtists = []);
            ApplyString(file.Tag, edit.Album, value => file.Tag.Album = value, () => file.Tag.Album = null);
            ApplyString(file.Tag, edit.Genre, value => file.Tag.Genres = [value], () => file.Tag.Genres = []);
            ApplyString(file.Tag, edit.Comment, value => file.Tag.Comment = value, () => file.Tag.Comment = null);

            if (edit.TrackNumber is { Op: MetadataFieldOp.Clear })
            {
                file.Tag.Track = 0;
            }
            else if (edit.TrackNumber is { Op: MetadataFieldOp.Set }
                && uint.TryParse(edit.TrackNumber.Value, out uint track)
                && track > 0)
            {
                file.Tag.Track = track;
            }

            if (edit.DiscNumber is { Op: MetadataFieldOp.Clear })
            {
                file.Tag.Disc = 0;
            }
            else if (edit.DiscNumber is { Op: MetadataFieldOp.Set }
                && uint.TryParse(edit.DiscNumber.Value, out uint disc)
                && disc > 0)
            {
                file.Tag.Disc = disc;
            }

            if (edit.Year is { Op: MetadataFieldOp.Clear })
            {
                file.Tag.Year = 0;
            }
            else if (edit.Year is { Op: MetadataFieldOp.Set }
                && uint.TryParse(edit.Year.Value, out uint year)
                && year > 0)
            {
                file.Tag.Year = year;
            }

            if (edit.Artwork is { Op: MetadataArtworkOp.Clear })
            {
                file.Tag.Pictures = [];
            }
            else if (edit.Artwork is { Op: MetadataArtworkOp.Set } && artworkBytes is not null)
            {
                file.Tag.Pictures =
                [
                    new TagLib.Picture(new TagLib.ByteVector(artworkBytes))
                    {
                        Type = TagLib.PictureType.FrontCover,
                        MimeType = artworkMime ?? "image/jpeg"
                    }
                ];
            }

            // Intentionally never assign ReplayGain* properties.
            _ = file.Tag;
        }

        private static void ApplyString(
            TagLib.Tag _,
            MetadataFieldEdit? edit,
            Action<string> set,
            Action clear)
        {
            if (edit is null || edit.Op == MetadataFieldOp.Keep)
            {
                return;
            }

            if (edit.Op == MetadataFieldOp.Clear)
            {
                clear();
                return;
            }

            set(edit.Value?.Trim() ?? string.Empty);
        }

        private static void StreamCopy(string source, string destination)
        {
            using FileStream input = new(source, FileMode.Open, FileAccess.Read, FileShare.Read);
            using FileStream output = new(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            input.CopyTo(output, CopyBufferSize);
            output.Flush(true);
        }

        private static bool IsDirectoryWritable(string directory)
        {
            string probe = Path.Combine(directory, ".emp-write-probe-" + Guid.NewGuid().ToString("N"));
            try
            {
                using FileStream stream = new(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                stream.WriteByte(0);
                stream.Flush(true);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                TryDelete(probe);
            }
        }

        private static bool HasEnoughFreeSpace(string directory, long requiredBytes)
        {
            try
            {
                string? root = Path.GetPathRoot(Path.GetFullPath(directory));
                if (string.IsNullOrWhiteSpace(root))
                {
                    return true;
                }

                if (GetDiskFreeSpaceEx(root, out ulong freeBytesAvailable, out _, out _))
                {
                    return freeBytesAvailable >= (ulong)Math.Max(requiredBytes, 0);
                }
            }
            catch (Exception)
            {
                // If free space cannot be queried, allow the write and rely on IO failures.
            }

            return true;
        }

        private static void TryDelete(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return;
            }

            try
            {
                if (File.Exists(path))
                {
                    File.SetAttributes(path, FileAttributes.Normal);
                    File.Delete(path);
                }
            }
            catch (Exception)
            {
                // Best-effort cleanup.
            }
        }

        private static MetadataFileResult Fail(string trackId, MetadataErrorCode code, string? detail = null)
        {
            string message = MetadataErrorMessages.For(code);
            if (!string.IsNullOrWhiteSpace(detail))
            {
                message = message + " " + detail;
            }

            return new MetadataFileResult
            {
                TrackId = trackId,
                Succeeded = false,
                ErrorCode = code,
                ErrorMessage = message
            };
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool GetDiskFreeSpaceEx(
            string lpDirectoryName,
            out ulong lpFreeBytesAvailable,
            out ulong lpTotalNumberOfBytes,
            out ulong lpTotalNumberOfFreeBytes);

        private readonly record struct ReplayGainSnapshot(
            double TrackGain,
            double TrackPeak,
            double AlbumGain,
            double AlbumPeak)
        {
            public bool HasFiniteValues =>
                IsFinite(TrackGain) || IsFinite(TrackPeak) || IsFinite(AlbumGain) || IsFinite(AlbumPeak);

            public static ReplayGainSnapshot Capture(TagLib.File file)
            {
                return new ReplayGainSnapshot(
                    file.Tag.ReplayGainTrackGain,
                    file.Tag.ReplayGainTrackPeak,
                    file.Tag.ReplayGainAlbumGain,
                    file.Tag.ReplayGainAlbumPeak);
            }

            public void Restore(TagLib.File file)
            {
                if (IsFinite(TrackGain))
                {
                    file.Tag.ReplayGainTrackGain = TrackGain;
                }

                if (IsFinite(TrackPeak))
                {
                    file.Tag.ReplayGainTrackPeak = TrackPeak;
                }

                if (IsFinite(AlbumGain))
                {
                    file.Tag.ReplayGainAlbumGain = AlbumGain;
                }

                if (IsFinite(AlbumPeak))
                {
                    file.Tag.ReplayGainAlbumPeak = AlbumPeak;
                }
            }

            public bool Matches(ReplayGainSnapshot other)
            {
                return Same(TrackGain, other.TrackGain)
                    && Same(TrackPeak, other.TrackPeak)
                    && Same(AlbumGain, other.AlbumGain)
                    && Same(AlbumPeak, other.AlbumPeak);
            }

            private static bool Same(double left, double right)
            {
                if (double.IsNaN(left) && double.IsNaN(right))
                {
                    return true;
                }

                return left.Equals(right);
            }

            private static bool IsFinite(double value)
            {
                return !double.IsNaN(value) && !double.IsInfinity(value);
            }
        }
    }
}
