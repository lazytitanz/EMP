namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Sonora-owned track handoff. EMP must advance queue/UI without issuing a redundant LoadAsync.
    /// </summary>
    internal sealed class SonoraTrackTransitionInfo
    {
        public required long Generation { get; init; }

        public string? PreviousTrackId { get; init; }

        public string? NextTrackId { get; init; }

        public string? PreviousPath { get; init; }

        public string? NextPath { get; init; }

        public TimeSpan PreviousDuration { get; init; }

        public int TransitionId { get; init; }
    }
}
