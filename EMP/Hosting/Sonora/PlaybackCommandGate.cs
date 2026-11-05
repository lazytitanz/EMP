namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Monotonic command generations so stale async Sonora events and completions are ignored
    /// during rapid Play/Pause/Seek/Load/Next operations.
    /// </summary>
    internal sealed class PlaybackCommandGate
    {
        private long generation;

        public long Current => Volatile.Read(ref generation);

        /// <summary>Bumps the generation and returns the new value for the command about to run.</summary>
        public long BeginCommand() => Interlocked.Increment(ref generation);

        public bool IsCurrent(long commandGeneration) =>
            commandGeneration == Volatile.Read(ref generation);
    }
}
