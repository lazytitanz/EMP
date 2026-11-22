/**
 * Pure helpers for EMP playback session restoration.
 * Used by player.js restoreSession(); keep side-effect free for unit tests.
 */
(function (global) {
  "use strict";

  /**
   * Clamp a saved playback position for restore.
   * Unknown/invalid duration keeps a non-negative position.
   * At or past the end returns 0 so Play is not stuck on a finished cue.
   */
  function clampPosition(position, duration) {
    const pos = Math.max(0, Number(position) || 0);
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur <= 0) {
      return pos;
    }
    if (pos >= dur) {
      return 0;
    }
    return Math.min(pos, dur);
  }

  /**
   * Pick the track to restore: saved trackId if it still exists, else current
   * queue entry / first remaining queue id.
   */
  function resolveTrackId(session, { trackExists, fallbackIds = [] } = {}) {
    const exists = typeof trackExists === "function" ? trackExists : () => true;
    const saved = typeof session?.trackId === "string" ? session.trackId : "";
    if (saved && exists(saved)) {
      return saved;
    }
    for (const id of fallbackIds) {
      if (typeof id === "string" && id && exists(id)) {
        return id;
      }
    }
    return null;
  }

  /**
   * After LoadAsync the host often snapshots position 0 before Seek lands.
   * Hold the optimistic cue so UI / Play do not restart at 0.
   */
  function shouldHoldCuePosition(cuePosition, incomingPosition, { playing = false } = {}) {
    const cue = Math.max(0, Number(cuePosition) || 0);
    const incoming = Math.max(0, Number(incomingPosition) || 0);
    if (cue <= 0.5) {
      return false;
    }
    if (playing) {
      return false;
    }
    return incoming < 0.5;
  }

  /**
   * True when a host snapshot confirms the pending load seek.
   */
  function cuePositionConfirmed(cuePosition, incomingPosition, { tolerance = 1.25 } = {}) {
    const cue = Math.max(0, Number(cuePosition) || 0);
    const incoming = Math.max(0, Number(incomingPosition) || 0);
    if (cue <= 0.5) {
      return false;
    }
    return Math.abs(incoming - cue) <= Math.max(0.25, Number(tolerance) || 1.25);
  }

  /**
   * Prefer a live engine position; if Stop/Idle has already zeroed it, keep the
   * last meaningful position for the same track so close-flush cannot wipe resume.
   */
  function pickPersistPosition(livePosition, { trackId, lastTrackId, lastPosition, floor = 0.25 } = {}) {
    const live = Math.max(0, Number(livePosition) || 0);
    const min = Math.max(0, Number(floor) || 0);
    if (live > min) {
      return live;
    }
    if (typeof trackId === "string"
      && trackId
      && trackId === lastTrackId
      && Math.max(0, Number(lastPosition) || 0) > min) {
      return Math.max(0, Number(lastPosition) || 0);
    }
    return live;
  }

  const api = {
    clampPosition,
    resolveTrackId,
    shouldHoldCuePosition,
    cuePositionConfirmed,
    pickPersistPosition
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpSessionRestore = api;
})(typeof window !== "undefined" ? window : globalThis);
