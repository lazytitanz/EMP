/**
 * AudioContext rebuild snapshot / listener bind helpers (pure, testable).
 */
(function (global) {
  "use strict";

  function nextBindGeneration(previous) {
    const value = Number(previous) || 0;
    return value + 1;
  }

  /**
   * Capture playback-critical state before replacing Audio elements / context.
   */
  function capturePlaybackSnapshot({
    trackId = null,
    position = 0,
    playing = false,
    queue = [],
    shuffleBag = [],
    index = -1,
    shuffle = false,
    repeat = "off",
    incomingTrackId = null,
    nextId = null,
    lyricsTrackId = null,
    listenOccurrenceIds = []
  } = {}) {
    return {
      trackId,
      position: Number.isFinite(position) ? Math.max(0, position) : 0,
      playing: Boolean(playing),
      queue: Array.isArray(queue) ? [...queue] : [],
      shuffleBag: Array.isArray(shuffleBag) ? [...shuffleBag] : [],
      index: Number.isFinite(index) ? index : -1,
      shuffle: Boolean(shuffle),
      repeat: repeat === "one" || repeat === "all" ? repeat : "off",
      incomingTrackId: incomingTrackId || null,
      nextId: nextId || null,
      lyricsTrackId: lyricsTrackId || null,
      listenOccurrenceIds: Array.isArray(listenOccurrenceIds) ? [...listenOccurrenceIds] : []
    };
  }

  function queueStateUnchanged(before, after) {
    if (!before || !after) {
      return false;
    }
    return before.shuffle === after.shuffle
      && before.repeat === after.repeat
      && before.index === after.index
      && JSON.stringify(before.queue) === JSON.stringify(after.queue)
      && JSON.stringify(before.shuffleBag) === JSON.stringify(after.shuffleBag);
  }

  function positionWithinTolerance(before, after, toleranceSec = 0.35) {
    if (!before || !after) {
      return false;
    }
    if (before.trackId !== after.trackId) {
      return false;
    }
    return Math.abs((before.position || 0) - (after.position || 0)) <= toleranceSec;
  }

  function lyricsAligned(snapshot, currentTrackId) {
    if (!snapshot) {
      return false;
    }
    if (!currentTrackId) {
      return snapshot.lyricsTrackId == null;
    }
    return snapshot.lyricsTrackId == null || snapshot.lyricsTrackId === currentTrackId;
  }

  /**
   * After rebuild, open listen occurrences must keep identity (no phantom duplicates).
   */
  function listenSessionIntegrity(beforeIds, afterIds) {
    const before = Array.isArray(beforeIds) ? beforeIds.filter(Boolean) : [];
    const after = Array.isArray(afterIds) ? afterIds.filter(Boolean) : [];
    if (after.length > before.length) {
      return false;
    }
    return after.every((id) => before.includes(id));
  }

  function resolveIncomingAfterRebuild(snapshot) {
    if (!snapshot) {
      return null;
    }
    if (snapshot.nextId && snapshot.incomingTrackId === snapshot.nextId) {
      return snapshot.nextId;
    }
    return snapshot.nextId || null;
  }

  const api = {
    nextBindGeneration,
    capturePlaybackSnapshot,
    queueStateUnchanged,
    positionWithinTolerance,
    lyricsAligned,
    listenSessionIntegrity,
    resolveIncomingAfterRebuild
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpAudioGraphRecovery = api;
})(typeof window !== "undefined" ? window : globalThis);
