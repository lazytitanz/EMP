/**
 * Crossfade / gapless scheduling helpers (pure, testable).
 */
(function (global) {
  "use strict";

  const CROSSFADE_MIN_SECONDS = 1;
  const CROSSFADE_MAX_SECONDS = 12;
  const CROSSFADE_DEFAULT_SECONDS = 8;
  const GAPLESS_LEAD_SECONDS = 0.12;
  const PRELOAD_SECONDS = 20;
  const GAPLESS_PRELOAD_SECONDS = 30;

  function clampCrossfadeSeconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return CROSSFADE_DEFAULT_SECONDS;
    }
    return Math.max(CROSSFADE_MIN_SECONDS, Math.min(CROSSFADE_MAX_SECONDS, number));
  }

  /**
   * Mutual exclusivity: enabling one clears the other.
   * @returns {{ crossfade: boolean, gapless: boolean }}
   */
  function applyTransitionExclusivity(key, enabled, current) {
    const next = {
      crossfade: Boolean(current?.crossfade),
      gapless: Boolean(current?.gapless)
    };
    if (key === "crossfade") {
      next.crossfade = Boolean(enabled);
      if (next.crossfade) {
        next.gapless = false;
      }
      return next;
    }
    if (key === "gapless") {
      next.gapless = Boolean(enabled);
      if (next.gapless) {
        next.crossfade = false;
      }
    }
    return next;
  }

  function crossfadeDurationMs(configuredSeconds, remainingSeconds) {
    const configured = clampCrossfadeSeconds(configuredSeconds);
    const remaining = Math.max(0.5, Number(remainingSeconds) || configured);
    return Math.min(configured, remaining) * 1000;
  }

  function shouldStartCrossfade(remainingSeconds, configuredSeconds) {
    const configured = clampCrossfadeSeconds(configuredSeconds);
    return remainingSeconds <= configured && remainingSeconds > 0.05;
  }

  function shouldStartGapless(remainingSeconds, leadSeconds = GAPLESS_LEAD_SECONDS) {
    return remainingSeconds <= leadSeconds;
  }

  function preloadHorizonSeconds({ crossfade, gapless, crossfadeSeconds }) {
    if (crossfade) {
      return Math.max(PRELOAD_SECONDS, clampCrossfadeSeconds(crossfadeSeconds) + 4);
    }
    if (gapless) {
      return GAPLESS_PRELOAD_SECONDS;
    }
    return PRELOAD_SECONDS;
  }

  function shouldPreloadNext({
    remote,
    connecting,
    transitioning,
    repeatOne,
    crossfade,
    gapless,
    remainingSeconds,
    crossfadeSeconds
  }) {
    if (remote || connecting || transitioning || repeatOne) {
      return false;
    }
    if (!crossfade && !gapless) {
      return false;
    }
    const horizon = preloadHorizonSeconds({ crossfade, gapless, crossfadeSeconds });
    return Number.isFinite(remainingSeconds) && remainingSeconds <= horizon;
  }

  /**
   * Whether an inactive player still holds the scheduled next track.
   */
  function isIncomingPreloadValid(incomingTrackId, nextId) {
    if (!nextId) {
      return incomingTrackId == null;
    }
    return incomingTrackId === nextId;
  }

  const api = {
    CROSSFADE_MIN_SECONDS,
    CROSSFADE_MAX_SECONDS,
    CROSSFADE_DEFAULT_SECONDS,
    GAPLESS_LEAD_SECONDS,
    PRELOAD_SECONDS,
    GAPLESS_PRELOAD_SECONDS,
    clampCrossfadeSeconds,
    applyTransitionExclusivity,
    crossfadeDurationMs,
    shouldStartCrossfade,
    shouldStartGapless,
    preloadHorizonSeconds,
    shouldPreloadNext,
    isIncomingPreloadValid
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpPlaybackTransitions = api;
})(typeof window !== "undefined" ? window : globalThis);
