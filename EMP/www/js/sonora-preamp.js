(() => {
  const PREAMP_MIN_DB = -24;
  const PREAMP_MAX_DB = 24;
  /** Practical slider step so ±24 dB stays controllable. */
  const PREAMP_UI_STEP_DB = 0.5;
  /** Magnetic center: values within this of 0 snap to unity (covers ±0.5 with 0.5 steps). */
  const PREAMP_SNAP_TO_ZERO_DB = 0.75;

  function clampPreampDb(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return 0;
    }
    return Math.max(PREAMP_MIN_DB, Math.min(PREAMP_MAX_DB, n));
  }

  /**
   * Round to the UI step, then snap near-neutral values to 0 dB.
   * Does not change Sonora's ±24 dB clamp range.
   */
  function quantizePreampDb(value) {
    const clamped = clampPreampDb(value);
    const stepped = Math.round(clamped / PREAMP_UI_STEP_DB) * PREAMP_UI_STEP_DB;
    const rounded = Math.round(stepped * 10) / 10;
    if (Math.abs(rounded) <= PREAMP_SNAP_TO_ZERO_DB) {
      return 0;
    }
    return clampPreampDb(rounded);
  }

  /**
   * Sonora exposes one preamp slot. EMP sums user trim + ReplayGain into that slot.
   * ReplayGain peak-cap remains inside the RG linear compute path — not here.
   */
  function composePreampDb(userPreampDb, replayGainDb) {
    return clampPreampDb(clampPreampDb(userPreampDb) + clampPreampDb(replayGainDb));
  }

  function formatPreampDb(value) {
    const n = clampPreampDb(value);
    const rounded = Math.round(n * 10) / 10;
    const abs = Math.abs(rounded).toFixed(1);
    if (rounded > 0) {
      return `+${abs} dB`;
    }
    if (rounded < 0) {
      return `-${abs} dB`;
    }
    return "0.0 dB";
  }

  const api = {
    PREAMP_MIN_DB,
    PREAMP_MAX_DB,
    PREAMP_UI_STEP_DB,
    PREAMP_SNAP_TO_ZERO_DB,
    clampPreampDb,
    quantizePreampDb,
    composePreampDb,
    formatPreampDb
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.EmpSonoraPreamp = api;
  }
})();
