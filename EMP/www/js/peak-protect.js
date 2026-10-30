/**
 * Post-EQ peak protection helpers.
 * DynamicsCompressorNode reduces distortion risk; it is not brick-wall or true-peak limiting.
 */
(function (global) {
  "use strict";

  const COMPRESSOR = Object.freeze({
    threshold: -1.5,
    knee: 3,
    ratio: 12,
    attack: 0.003,
    release: 0.25
  });

  const BYPASS_RAMP_TIME = 0.018;

  /**
   * Dry/wet mix targets for click-free bypass. Topology stays connected;
   * callers must ramp gains — never disconnect live paths to toggle.
   */
  function peakProtectMixGains(enabled) {
    if (enabled) {
      return { dry: 0, wet: 1 };
    }
    return { dry: 1, wet: 0 };
  }

  function applyCompressorParams(compressor, params = COMPRESSOR) {
    if (!compressor) {
      return;
    }
    if (compressor.threshold) {
      compressor.threshold.value = params.threshold;
    }
    if (compressor.knee) {
      compressor.knee.value = params.knee;
    }
    if (compressor.ratio) {
      compressor.ratio.value = params.ratio;
    }
    if (compressor.attack) {
      compressor.attack.value = params.attack;
    }
    if (compressor.release) {
      compressor.release.value = params.release;
    }
  }

  /**
   * Documents the intended stable graph fragment. Used by tests to assert
   * bypass does not rely on disconnect/reconnect of the mix path.
   */
  function bypassStrategy() {
    return {
      kind: "dry-wet-gain-ramp",
      disconnectsLivePath: false,
      rampTimeConstant: BYPASS_RAMP_TIME
    };
  }

  const api = {
    COMPRESSOR,
    BYPASS_RAMP_TIME,
    peakProtectMixGains,
    applyCompressorParams,
    bypassStrategy
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpPeakProtect = api;
})(typeof window !== "undefined" ? window : globalThis);
