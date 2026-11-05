namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Authoritative last-requested Sonora linear gain (0–1). Survives the window where
    /// WebView posts volume before the host service is attached/initialized, and supplies
    /// re-apply after load / output reconfiguration without depending on a UI slider nudge.
    /// </summary>
    internal sealed class SonoraOutputVolumeStore
    {
        private readonly object gate = new();
        private float rememberedLinear = 1f;
        private bool hasExplicitRequest;

        /// <summary>Last EMP-requested linear gain; defaults to Sonora unity (1) until set.</summary>
        public float RememberedLinear
        {
            get
            {
                lock (gate)
                {
                    return rememberedLinear;
                }
            }
        }

        public bool HasExplicitRequest
        {
            get
            {
                lock (gate)
                {
                    return hasExplicitRequest;
                }
            }
        }

        public float Remember(float linear01)
        {
            float clamped = Math.Clamp(linear01, 0f, 1f);
            lock (gate)
            {
                rememberedLinear = clamped;
                hasExplicitRequest = true;
                return rememberedLinear;
            }
        }

        /// <summary>
        /// Push remembered gain through <paramref name="apply"/> when an explicit EMP request
        /// exists (including 0 for mute). Returns false when nothing was ever requested.
        /// </summary>
        public bool TryApplyExplicit(Action<float> apply)
        {
            ArgumentNullException.ThrowIfNull(apply);
            float volume;
            lock (gate)
            {
                if (!hasExplicitRequest)
                {
                    return false;
                }

                volume = rememberedLinear;
            }

            apply(volume);
            return true;
        }
    }
}
