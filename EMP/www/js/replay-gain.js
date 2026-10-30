/**
 * ReplayGain selection and peak-cap helpers.
 * Metadata-driven only — no runtime RMS estimation.
 */
(function (global) {
  "use strict";

  const MIN_GAIN_DB = -24;
  const MAX_GAIN_DB = 24;
  const MIN_PEAK = 1e-6;
  const MAX_PEAK = 8;

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function clampGainDb(value) {
    if (!isFiniteNumber(value) || value < MIN_GAIN_DB || value > MAX_GAIN_DB) {
      return null;
    }
    return value;
  }

  function clampPeak(value) {
    if (!isFiniteNumber(value) || value <= 0 || value < MIN_PEAK || value > MAX_PEAK) {
      return null;
    }
    return value;
  }

  function dbToLinear(db) {
    if (!isFiniteNumber(db)) {
      return 1;
    }
    return 10 ** (db / 20);
  }

  function normalizeMode(value) {
    return value === "album" ? "album" : "track";
  }

  /**
   * Select gain (dB) and peak for the active normalization mode.
   * Album mode falls back to track tags when album tags are missing.
   * @returns {{ gainDb: number|null, peak: number|null, source: "album"|"track"|"none" }}
   */
  function selectReplayGain(track, mode) {
    const normalizedMode = normalizeMode(mode);
    const trackGain = clampGainDb(track?.replayGainTrackGain);
    const trackPeak = clampPeak(track?.replayGainTrackPeak);
    const albumGain = clampGainDb(track?.replayGainAlbumGain);
    const albumPeak = clampPeak(track?.replayGainAlbumPeak);

    if (normalizedMode === "album") {
      if (albumGain != null) {
        return { gainDb: albumGain, peak: albumPeak, source: "album" };
      }
      if (trackGain != null) {
        return { gainDb: trackGain, peak: trackPeak, source: "track" };
      }
      return { gainDb: null, peak: null, source: "none" };
    }

    if (trackGain != null) {
      return { gainDb: trackGain, peak: trackPeak, source: "track" };
    }
    return { gainDb: null, peak: null, source: "none" };
  }

  /**
   * Apply ReplayGain and optional sample-peak cap. Untagged → unity.
   * Peak metadata is sample peak, not true peak.
   */
  function computeReplayGainLinear(track, { enabled = false, mode = "track" } = {}) {
    if (!enabled) {
      return 1;
    }
    const selected = selectReplayGain(track, mode);
    if (selected.gainDb == null) {
      return 1;
    }
    let linear = dbToLinear(selected.gainDb);
    if (selected.peak != null && selected.peak > 0 && linear * selected.peak > 1) {
      linear = 1 / selected.peak;
    }
    if (!Number.isFinite(linear) || linear <= 0) {
      return 1;
    }
    return linear;
  }

  const api = {
    MIN_GAIN_DB,
    MAX_GAIN_DB,
    MIN_PEAK,
    MAX_PEAK,
    clampGainDb,
    clampPeak,
    dbToLinear,
    normalizeMode,
    selectReplayGain,
    computeReplayGainLinear
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpReplayGain = api;
})(typeof window !== "undefined" ? window : globalThis);
