namespace EMP.Library.Metadata
{
    internal sealed class MetadataEditorService
    {
        private readonly object gate = new();
        private CancellationTokenSource? applyCts;
        private bool applyRunning;

        public IReadOnlyList<EditableTrackMetadata> Get(
            IReadOnlyList<string> trackIds,
            IReadOnlyList<string> musicRoots,
            Func<string, (bool Busy, string? Reason, MetadataErrorCode Code)> busyLookup,
            Func<string, TrackDisplayContext?> displayLookup)
        {
            ArgumentNullException.ThrowIfNull(trackIds);
            ArgumentNullException.ThrowIfNull(musicRoots);
            ArgumentNullException.ThrowIfNull(busyLookup);
            ArgumentNullException.ThrowIfNull(displayLookup);

            List<EditableTrackMetadata> results = [];
            foreach (string trackId in trackIds.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (!MetadataAuthorization.TryResolveAuthorizedPath(trackId, musicRoots, out LibraryMediaLocation location, out MetadataErrorCode authError))
                {
                    results.Add(new EditableTrackMetadata
                    {
                        TrackId = trackId,
                        FileName = string.Empty,
                        Extension = string.Empty,
                        Exists = false,
                        ErrorCode = authError,
                        ErrorMessage = MetadataErrorMessages.For(authError)
                    });
                    continue;
                }

                (bool busy, string? reason, MetadataErrorCode busyCode) = busyLookup(trackId);
                TrackDisplayContext? display = displayLookup(trackId);
                results.Add(MetadataRawTagReader.Read(
                    trackId,
                    location,
                    display?.AlbumId,
                    display?.Title,
                    display?.Artist,
                    display?.Album,
                    display?.CoverUrl,
                    busy,
                    busy ? reason ?? MetadataErrorMessages.For(busyCode) : null,
                    busy ? busyCode : null));
            }

            return results;
        }

        public bool TryBeginApply(out string? errorMessage)
        {
            lock (gate)
            {
                if (applyRunning)
                {
                    errorMessage = MetadataErrorMessages.For(MetadataErrorCode.EditInProgress);
                    return false;
                }

                applyRunning = true;
                applyCts = new CancellationTokenSource();
                errorMessage = null;
                return true;
            }
        }

        public void CancelApply()
        {
            lock (gate)
            {
                applyCts?.Cancel();
            }
        }

        public void EndApply()
        {
            lock (gate)
            {
                applyRunning = false;
                applyCts?.Dispose();
                applyCts = null;
            }
        }

        public CancellationToken ApplyToken
        {
            get
            {
                lock (gate)
                {
                    return applyCts?.Token ?? CancellationToken.None;
                }
            }
        }

        public MetadataApplySummary ApplySequential(
            string requestId,
            IReadOnlyList<MetadataTrackEdit> edits,
            IReadOnlyList<string> musicRoots,
            Func<string, (bool Busy, MetadataErrorCode Code)> busyCheck,
            Action<int, int, string?, int, int> onProgress,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(edits);

            List<MetadataFileResult> results = [];
            int succeeded = 0;
            int failed = 0;
            bool cancelled = false;

            for (int index = 0; index < edits.Count; index++)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    cancelled = true;
                    for (int remaining = index; remaining < edits.Count; remaining++)
                    {
                        results.Add(new MetadataFileResult
                        {
                            TrackId = edits[remaining].TrackId,
                            Succeeded = false,
                            ErrorCode = MetadataErrorCode.Cancelled,
                            ErrorMessage = MetadataErrorMessages.For(MetadataErrorCode.Cancelled)
                        });
                        failed++;
                    }

                    break;
                }

                MetadataTrackEdit edit = edits[index];
                string titleHint = edit.TrackId;
                if (!MetadataAuthorization.TryResolveAuthorizedPath(
                        edit.TrackId,
                        musicRoots,
                        out LibraryMediaLocation location,
                        out MetadataErrorCode authError))
                {
                    results.Add(new MetadataFileResult
                    {
                        TrackId = edit.TrackId,
                        Succeeded = false,
                        ErrorCode = authError,
                        ErrorMessage = MetadataErrorMessages.For(authError)
                    });
                    failed++;
                    onProgress(index + 1, edits.Count, titleHint, succeeded, failed);
                    continue;
                }

                titleHint = Path.GetFileName(location.FullPath);
                MetadataFileResult result = MetadataTagWriter.Apply(
                    edit.TrackId,
                    location.FullPath,
                    edit,
                    busyCheck);
                results.Add(result);
                if (result.Succeeded && result.ErrorCode != MetadataErrorCode.NoChanges)
                {
                    succeeded++;
                }
                else if (!result.Succeeded)
                {
                    failed++;
                }

                onProgress(index + 1, edits.Count, titleHint, succeeded, failed);
            }

            return new MetadataApplySummary
            {
                RequestId = requestId,
                Total = edits.Count,
                Succeeded = succeeded,
                Failed = failed,
                Cancelled = cancelled,
                Files = results
            };
        }
    }

    internal sealed class TrackDisplayContext
    {
        public string? AlbumId { get; init; }

        public string? Title { get; init; }

        public string? Artist { get; init; }

        public string? Album { get; init; }

        public string? CoverUrl { get; init; }

        public IReadOnlyList<string> AlbumTrackIds { get; init; } = [];
    }
}
