namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Pure queue-identity handoff after Sonora raises <c>TrackTransitioned</c>.
    /// EMP advances UI/queue ids here and must not issue a redundant LoadAsync.
    /// </summary>
    internal static class SonoraQueueHandoff
    {
        public readonly record struct State(
            string? CurrentTrackId,
            string? NextTrackId,
            string? CurrentPath,
            string? NextPath);

        public static State AfterTransition(State before, string? transitionedNextPath)
        {
            if (string.IsNullOrWhiteSpace(transitionedNextPath))
            {
                return before with { NextTrackId = null, NextPath = null };
            }

            if (string.Equals(transitionedNextPath, before.NextPath, StringComparison.OrdinalIgnoreCase))
            {
                return new State(
                    CurrentTrackId: before.NextTrackId,
                    NextTrackId: null,
                    CurrentPath: before.NextPath,
                    NextPath: null);
            }

            // Path-only fallback when EMP had not registered nextTrackId yet.
            return new State(
                CurrentTrackId: before.NextTrackId,
                NextTrackId: null,
                CurrentPath: transitionedNextPath,
                NextPath: null);
        }

        /// <summary>
        /// Whether EMP should ClearNext + optionally PreloadNext after a queue edit / skip / repeat change.
        /// </summary>
        public static bool ShouldPreloadNext(bool gapless, bool crossfade, bool repeatOne, string? plannedNextTrackId) =>
            !repeatOne
            && (gapless || crossfade)
            && !string.IsNullOrWhiteSpace(plannedNextTrackId);
    }
}
