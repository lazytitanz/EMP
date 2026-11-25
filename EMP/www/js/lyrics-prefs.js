/**
 * Lyrics preferences and timing helpers (pure, testable).
 *
 * Per-song: a timing offset (when synced lyrics run early/late) and "hide lyrics for this song".
 * Global: lyrics text size. Persisted by player.js in localStorage ("emp.lyricsPrefs"), separate
 * from the playback session. Everything is defensive: the stored value may be missing or stale.
 */
(function (global) {
  "use strict";

  const VERSION = 1;
  const STORAGE_KEY = "emp.lyricsPrefs";
  const TEXT_SCALES = Object.freeze([0.85, 1, 1.15, 1.3, 1.5]);
  const OFFSET_STEP_MS = 250;
  const MAX_OFFSET_MS = 10000;
  const MAX_TRACKS = 1000;

  function createDefault() {
    return { version: VERSION, textScale: 1, tracks: {} };
  }

  function validTrackId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512;
  }

  function clampOffset(ms) {
    const value = Math.round(Number(ms) / OFFSET_STEP_MS) * OFFSET_STEP_MS;
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, value));
  }

  function normalize(raw) {
    const prefs = createDefault();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return prefs;
    }
    const scale = Number(raw.textScale);
    prefs.textScale = TEXT_SCALES.includes(scale) ? scale : 1;
    if (raw.tracks && typeof raw.tracks === "object" && !Array.isArray(raw.tracks)) {
      for (const [trackId, value] of Object.entries(raw.tracks)) {
        if (!validTrackId(trackId) || !value || typeof value !== "object") {
          continue;
        }
        const entry = {
          offsetMs: clampOffset(value.offsetMs),
          hidden: value.hidden === true,
          at: Math.max(0, Math.floor(Number(value.at)) || 0)
        };
        if (entry.offsetMs !== 0 || entry.hidden) {
          prefs.tracks[trackId] = entry;
        }
      }
    }
    prune(prefs);
    return prefs;
  }

  /** Keeps only meaningful entries, newest first, up to MAX_TRACKS. */
  function prune(prefs) {
    const entries = Object.entries(prefs.tracks)
      .filter(([, entry]) => entry.offsetMs !== 0 || entry.hidden)
      .sort((left, right) => right[1].at - left[1].at)
      .slice(0, MAX_TRACKS);
    prefs.tracks = Object.fromEntries(entries);
  }

  function updateTrack(prefs, trackId, patch, now) {
    if (!validTrackId(trackId)) {
      return false;
    }
    const previous = prefs.tracks[trackId] || { offsetMs: 0, hidden: false, at: 0 };
    const next = { ...previous, ...patch, at: Math.max(0, Math.floor(Number(now)) || Date.now()) };
    if (next.offsetMs === previous.offsetMs && next.hidden === previous.hidden) {
      return false;
    }
    prefs.tracks[trackId] = next;
    prune(prefs);
    return true;
  }

  // --- Text size ---------------------------------------------------------------

  function textScaleIndex(prefs) {
    const index = TEXT_SCALES.indexOf(prefs?.textScale);
    return index < 0 ? TEXT_SCALES.indexOf(1) : index;
  }

  function canStepTextScale(prefs, delta) {
    const next = textScaleIndex(prefs) + Math.sign(Number(delta) || 0);
    return next >= 0 && next < TEXT_SCALES.length && next !== textScaleIndex(prefs);
  }

  function stepTextScale(prefs, delta) {
    if (!canStepTextScale(prefs, delta)) {
      return false;
    }
    prefs.textScale = TEXT_SCALES[textScaleIndex(prefs) + Math.sign(Number(delta))];
    return true;
  }

  function textScaleLabel(scale) {
    return `${Math.round((TEXT_SCALES.includes(scale) ? scale : 1) * 100)}%`;
  }

  // --- Per-song timing and visibility --------------------------------------------

  /** Positive = lyrics appear later (they were running early). */
  function offsetMs(prefs, trackId) {
    return prefs?.tracks?.[trackId]?.offsetMs || 0;
  }

  function nudgeOffset(prefs, trackId, deltaMs, now) {
    const next = clampOffset(offsetMs(prefs, trackId) + Number(deltaMs || 0));
    updateTrack(prefs, trackId, { offsetMs: next }, now);
    return next;
  }

  function resetOffset(prefs, trackId, now) {
    return updateTrack(prefs, trackId, { offsetMs: 0 }, now);
  }

  function isHidden(prefs, trackId) {
    return prefs?.tracks?.[trackId]?.hidden === true;
  }

  function setHidden(prefs, trackId, hidden, now) {
    return updateTrack(prefs, trackId, { hidden: Boolean(hidden) }, now);
  }

  function formatSeconds(ms) {
    const seconds = Math.abs(ms) / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(2).replace(/0$/, "")}s`;
  }

  /** "In sync", "0.5s later", "0.25s earlier" — what the adjustment does to the lyrics. */
  function describeOffset(ms) {
    const value = clampOffset(ms);
    if (value === 0) {
      return "In sync";
    }
    return `${formatSeconds(value)} ${value > 0 ? "later" : "earlier"}`;
  }

  /** Playback position as the lyrics should see it (seconds). */
  function effectivePosition(position, ms) {
    return Number(position || 0) - clampOffset(ms) / 1000;
  }

  /** Where to seek so a clicked line lands on its (adjusted) time. */
  function seekTimeForLine(lineTime, ms) {
    return Math.max(0, Number(lineTime || 0) + clampOffset(ms) / 1000);
  }

  /**
   * 0..1 progress through an instrumental break (an empty synced line), or null when the
   * line is not a break or the break has no following line to measure against.
   */
  function breakProgress(lines, index, position) {
    const line = Array.isArray(lines) ? lines[index] : null;
    const next = Array.isArray(lines) ? lines[index + 1] : null;
    if (!line || line.text || !next) {
      return null;
    }
    const span = Number(next.time) - Number(line.time);
    if (!(span > 0)) {
      return null;
    }
    return Math.max(0, Math.min(1, (Number(position) - Number(line.time)) / span));
  }

  /** Plain-language credit for where the lyrics came from. */
  function sourceCredit(source, sourceName) {
    if (source === "file") {
      return sourceName ? `Lyrics from ${sourceName}` : "Lyrics from a file next to this song";
    }
    if (source === "embedded") {
      return "Lyrics from this song's file";
    }
    return "Lyrics from LRCLIB";
  }

  const api = {
    VERSION,
    STORAGE_KEY,
    TEXT_SCALES,
    OFFSET_STEP_MS,
    MAX_OFFSET_MS,
    MAX_TRACKS,
    createDefault,
    normalize,
    textScaleIndex,
    canStepTextScale,
    stepTextScale,
    textScaleLabel,
    offsetMs,
    nudgeOffset,
    resetOffset,
    isHidden,
    setHidden,
    describeOffset,
    effectivePosition,
    seekTimeForLine,
    breakProgress,
    sourceCredit
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpLyricsPrefs = api;
})(typeof window !== "undefined" ? window : globalThis);
