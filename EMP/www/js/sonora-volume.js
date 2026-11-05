(() => {
  /**
   * Authoritative UI% → Sonora linear gain. Keep in sync with player.js userVolumeGain.
   * Power curve matches prior Web Audio master gain so restored slider positions sound the same.
   */
  function userVolumeGain(volumePercent, muted) {
    if (muted) {
      return 0;
    }
    const normalized = Math.max(0, Math.min(1, Number(volumePercent) / 100));
    if (!Number.isFinite(normalized)) {
      return 0;
    }
    return Math.pow(normalized, 2);
  }

  const api = { userVolumeGain };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.EmpSonoraVolume = api;
  }
})();
