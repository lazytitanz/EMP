/**
 * Home page model (pure, testable): pins, section layout, playback-context history,
 * "New in your library" grouping, and relative-time labels.
 *
 * The document is persisted by the host in %LocalAppData%\EMP\home.json (HomeStore.cs) and is
 * independent of playlists and the playback session. Everything here is defensive: the stored
 * document may be missing, from an older/newer build, or hand-edited.
 */
(function (global) {
  "use strict";

  const VERSION = 1;
  const MAX_PINS = 8;
  const MAX_HISTORY = 500;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const PIN_KINDS = Object.freeze(["playlist", "album", "artist", "mix"]);
  const HISTORY_KINDS = Object.freeze(["album", "artist", "playlist", "mix"]);
  /** Queue source kinds that name a destination the user chose to play. */
  const SOURCE_TO_HISTORY_KIND = Object.freeze({
    album: "album",
    artist: "artist",
    playlist: "playlist",
    smart: "playlist",
    mix: "mix"
  });

  const SECTION_IDS = Object.freeze(["continue", "pinned", "jumpBackIn", "mixes", "newInLibrary", "mostPlayed"]);
  const SECTION_LABELS = Object.freeze({
    continue: "Continue listening",
    pinned: "Pinned",
    jumpBackIn: "Jump back in",
    mixes: "Your Mixes",
    newInLibrary: "New in your library",
    mostPlayed: "Most played this month"
  });
  /** Sections that may share a row when adjacent and both shown. */
  const PAIRABLE = Object.freeze(["newInLibrary", "mostPlayed"]);

  const LIKED_PIN = Object.freeze({ kind: "playlist", id: "pl_liked" });

  function defaultSections() {
    return SECTION_IDS.map((id) => ({ id, visible: true }));
  }

  function createDefault() {
    return {
      version: VERSION,
      pins: [],
      pinsSeeded: false,
      sections: defaultSections(),
      history: [],
      resume: null
    };
  }

  function normalizeResume(value) {
    const at = Math.floor(Number(value?.pausedAt));
    if (!value || !validId(value.trackId) || !Number.isFinite(at) || at <= 0) {
      return null;
    }
    return { trackId: value.trackId, pausedAt: at };
  }

  /** Remembers when playback was last paused so the resume card can say "paused 12 min ago". */
  function setResumePoint(doc, trackId, pausedAt) {
    const next = normalizeResume({ trackId, pausedAt });
    const prev = doc.resume;
    if (!next || (prev && prev.trackId === next.trackId && prev.pausedAt === next.pausedAt)) {
      return false;
    }
    doc.resume = next;
    return true;
  }

  /** Pause time for the given track, or 0 when unknown (never inferred). */
  function pausedAtFor(doc, trackId) {
    return doc.resume && doc.resume.trackId === trackId ? doc.resume.pausedAt : 0;
  }

  function validId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512;
  }

  function pinKey(item) {
    if (!item || !validId(item.id)) {
      return "";
    }
    // Artists are addressed by display name; compare case-insensitively.
    const id = item.kind === "artist" ? item.id.toLowerCase() : item.id;
    return `${item.kind}:${id}`;
  }

  function normalizePin(value) {
    if (!value || !PIN_KINDS.includes(value.kind) || !validId(value.id)) {
      return null;
    }
    const pin = { kind: value.kind, id: value.id };
    // Name snapshot so an unavailable pin can still be identified in Edit pins.
    const label = typeof value.label === "string" ? value.label.trim().slice(0, 200) : "";
    if (label) {
      pin.label = label;
    }
    return pin;
  }

  function normalizeHistoryEntry(value) {
    if (!value || !HISTORY_KINDS.includes(value.kind) || !validId(value.id)) {
      return null;
    }
    const at = Math.floor(Number(value.at));
    if (!Number.isFinite(at) || at <= 0) {
      return null;
    }
    return { kind: value.kind, id: value.id, at };
  }

  function normalizeSections(value) {
    const seen = new Set();
    const sections = [];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const id = typeof entry === "string" ? entry : entry?.id;
        if (!SECTION_IDS.includes(id) || seen.has(id)) {
          continue; // Obsolete or duplicate section ids are dropped safely.
        }
        seen.add(id);
        sections.push({ id, visible: typeof entry === "object" ? entry.visible !== false : true });
      }
    }
    // Sections added by newer builds appear (visible) at their default position.
    SECTION_IDS.forEach((id, defaultIndex) => {
      if (seen.has(id)) {
        return;
      }
      const before = SECTION_IDS.slice(0, defaultIndex);
      let insertAt = 0;
      sections.forEach((section, index) => {
        if (before.includes(section.id)) {
          insertAt = index + 1;
        }
      });
      sections.splice(insertAt, 0, { id, visible: true });
      seen.add(id);
    });
    return sections;
  }

  function normalize(raw) {
    const doc = createDefault();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return doc;
    }
    const pinKeys = new Set();
    if (Array.isArray(raw.pins)) {
      for (const value of raw.pins) {
        const pin = normalizePin(value);
        const key = pinKey(pin);
        if (!pin || pinKeys.has(key) || doc.pins.length >= MAX_PINS) {
          continue;
        }
        pinKeys.add(key);
        doc.pins.push(pin);
      }
    }
    doc.pinsSeeded = raw.pinsSeeded === true || doc.pins.length > 0;
    doc.sections = normalizeSections(raw.sections);
    doc.history = normalizeHistory(raw.history);
    doc.resume = normalizeResume(raw.resume);
    return doc;
  }

  function normalizeHistory(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const byKey = new Map();
    for (const raw of value) {
      const entry = normalizeHistoryEntry(raw);
      if (!entry) {
        continue;
      }
      const key = pinKey(entry);
      const existing = byKey.get(key);
      if (!existing || entry.at > existing.at) {
        byKey.set(key, entry);
      }
    }
    return [...byKey.values()].sort((left, right) => right.at - left.at).slice(0, MAX_HISTORY);
  }

  // ---------------------------------------------------------------------------
  // Pins
  // ---------------------------------------------------------------------------

  function isPinned(doc, item) {
    const key = pinKey(item);
    return Boolean(key) && doc.pins.some((pin) => pinKey(pin) === key);
  }

  /** @returns {{ ok: boolean, reason?: "invalid" | "duplicate" | "limit" }} */
  function addPin(doc, item) {
    const pin = normalizePin(item);
    if (!pin) {
      return { ok: false, reason: "invalid" };
    }
    if (isPinned(doc, pin)) {
      return { ok: false, reason: "duplicate" };
    }
    if (doc.pins.length >= MAX_PINS) {
      return { ok: false, reason: "limit" };
    }
    doc.pins.push(pin);
    doc.pinsSeeded = true;
    return { ok: true };
  }

  function removePin(doc, item) {
    const key = pinKey(item);
    const before = doc.pins.length;
    doc.pins = doc.pins.filter((pin) => pinKey(pin) !== key);
    doc.pinsSeeded = true;
    return doc.pins.length !== before;
  }

  function movePin(doc, item, delta) {
    const key = pinKey(item);
    const from = doc.pins.findIndex((pin) => pinKey(pin) === key);
    const to = from + Math.sign(Number(delta) || 0);
    if (from < 0 || to < 0 || to >= doc.pins.length || to === from) {
      return false;
    }
    const [pin] = doc.pins.splice(from, 1);
    doc.pins.splice(to, 0, pin);
    doc.pinsSeeded = true;
    return true;
  }

  function pinsFull(doc) {
    return doc.pins.length >= MAX_PINS;
  }

  /**
   * One-time default: pin Liked Songs once it exists with songs. Never re-adds it after the
   * user has changed pins (pinsSeeded), so unpinning it sticks.
   */
  function seedDefaultPins(doc, { likedAvailable = false } = {}) {
    if (doc.pinsSeeded || !likedAvailable) {
      return false;
    }
    doc.pinsSeeded = true;
    if (!isPinned(doc, LIKED_PIN) && doc.pins.length < MAX_PINS) {
      doc.pins.unshift({ ...LIKED_PIN });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Listening history (playback contexts)
  // ---------------------------------------------------------------------------

  function historyKindForSource(source) {
    return source && validId(source.id) ? SOURCE_TO_HISTORY_KIND[source.kind] || null : null;
  }

  /** Records a qualified play attributed to the source captured when the play began. */
  function recordPlay(doc, source, at) {
    const kind = historyKindForSource(source);
    const time = Math.floor(Number(at));
    if (!kind || !Number.isFinite(time) || time <= 0) {
      return false;
    }
    const entry = { kind, id: source.id, at: time };
    const key = pinKey(entry);
    const rest = doc.history.filter((item) => pinKey(item) !== key);
    doc.history = [entry, ...rest].sort((left, right) => right.at - left.at).slice(0, MAX_HISTORY);
    return true;
  }

  /**
   * Merges recorded playback contexts with album times derived from per-track lastPlayedAt.
   * Derived entries are always albums (the album's tracks really were played then); they are
   * never turned into playlist/mix/artist entries.
   */
  function mergeHistory(contextHistory, derivedAlbums) {
    const byKey = new Map();
    const put = (entry, origin) => {
      const normalized = normalizeHistoryEntry(entry);
      if (!normalized) {
        return;
      }
      const key = pinKey(normalized);
      const existing = byKey.get(key);
      if (!existing || normalized.at > existing.at) {
        byKey.set(key, { ...normalized, origin });
      }
    };
    (contextHistory || []).forEach((entry) => put(entry, "context"));
    (derivedAlbums || []).forEach((entry) => put({ kind: "album", id: entry?.id, at: entry?.at }, "track"));
    return [...byKey.values()].sort((left, right) => right.at - left.at);
  }

  /**
   * Chooses Jump back in entries. Pinned items are skipped only while enough other playable
   * entries exist to fill the row; the result stays in chronological order.
   */
  function pickJumpBackIn(entries, { limit = 8, isPinned: pinned = () => false, resolve = (entry) => entry } = {}) {
    const resolved = [];
    let unpinnedCount = 0;
    for (const entry of entries || []) {
      // Resolution can be costly (playlists, artists); stop once the row is filled.
      if (unpinnedCount >= limit) {
        break;
      }
      const item = resolve(entry);
      if (item) {
        const row = { entry, item, pinned: Boolean(pinned(entry)) };
        resolved.push(row);
        if (!row.pinned) {
          unpinnedCount += 1;
        }
      }
    }
    const unpinned = resolved.filter((row) => !row.pinned);
    if (unpinned.length >= limit) {
      return unpinned.slice(0, limit);
    }
    const keep = new Set(unpinned);
    for (const row of resolved) {
      if (keep.size >= limit) {
        break;
      }
      keep.add(row);
    }
    return resolved.filter((row) => keep.has(row)).slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Dates
  // ---------------------------------------------------------------------------

  function localDayStart(ms) {
    const date = new Date(ms);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function localDayKey(ms) {
    const date = new Date(ms);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function monthKey(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  /** Milliseconds until the next local calendar month begins. */
  function msUntilNextMonth(now) {
    const date = new Date(now);
    return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() - now;
  }

  function calendarDaysBetween(earlier, later) {
    // Round to absorb DST shifts (23h/25h days).
    return Math.round((localDayStart(later) - localDayStart(earlier)) / DAY_MS);
  }

  function formatShortDate(ms, now, locale) {
    const date = new Date(ms);
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    try {
      return date.toLocaleDateString(locale, sameYear
        ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric", year: "numeric" });
    } catch (_) {
      return localDayKey(ms);
    }
  }

  /** "Today", "Yesterday", "3 days ago", "Last week", "3 weeks ago", then a short date. */
  function relativeDay(at, now, locale) {
    const days = calendarDaysBetween(at, now);
    if (days <= 0) {
      return "Today";
    }
    if (days === 1) {
      return "Yesterday";
    }
    if (days < 7) {
      return `${days} days ago`;
    }
    if (days < 14) {
      return "Last week";
    }
    if (days < 28) {
      return `${Math.floor(days / 7)} weeks ago`;
    }
    return formatShortDate(at, now, locale);
  }

  /** "just now", "12 min ago", "3 hr ago" (same day), then relativeDay in lower case. */
  function relativeTime(at, now, locale) {
    const elapsed = Math.max(0, now - at);
    if (elapsed < 60 * 1000) {
      return "just now";
    }
    if (elapsed < 60 * 60 * 1000) {
      return `${Math.floor(elapsed / 60000)} min ago`;
    }
    if (calendarDaysBetween(at, now) === 0) {
      return `${Math.floor(elapsed / 3600000)} hr ago`;
    }
    const day = relativeDay(at, now, locale);
    // Reads as "paused yesterday"; dates ("Sep 2") keep their capitalisation.
    return day === "Yesterday" || day === "Last week" ? day.toLowerCase() : day;
  }

  /** Date heading for New in your library groups: "Sat, Nov 22" (year added when not current). */
  function additionHeading(at, now, locale) {
    const date = new Date(at);
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    try {
      return date.toLocaleDateString(locale, sameYear
        ? { weekday: "short", month: "short", day: "numeric" }
        : { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    } catch (_) {
      return localDayKey(at);
    }
  }

  // ---------------------------------------------------------------------------
  // New in your library
  // ---------------------------------------------------------------------------

  /**
   * Albums whose newest track arrived after the initial library baseline, newest first,
   * grouped by local addition day. Each entry is either a brand-new release ("new") or an
   * existing album that received more tracks ("updated", with the count of new tracks).
   *
   * Returns [] when the baseline is unknown: without it, first-scan dates are indistinguishable
   * from real additions and must not be presented as imports.
   */
  function groupNewAdditions(albums, { dateAddedOf, baselineAt, now, limit = 5, locale } = {}) {
    const baseline = Number(baselineAt) || 0;
    if (baseline <= 0 || typeof dateAddedOf !== "function") {
      return [];
    }
    const entries = [];
    for (const album of albums || []) {
      const ids = Array.isArray(album?.trackIds) ? album.trackIds : [];
      let newest = 0;
      const dates = [];
      for (const id of ids) {
        const added = Number(dateAddedOf(id)) || 0;
        if (added > 0) {
          dates.push(added);
          newest = Math.max(newest, added);
        }
      }
      if (!(newest > baseline) || !dates.length) {
        continue;
      }
      const batchDay = localDayKey(newest);
      const batch = dates.filter((value) => value > baseline && localDayKey(value) === batchDay).length;
      const isNew = batch === dates.length;
      entries.push({
        album,
        addedAt: newest,
        kind: isNew ? "new" : "updated",
        newTrackCount: batch,
        trackCount: dates.length
      });
    }
    entries.sort((left, right) => right.addedAt - left.addedAt
      || String(left.album?.title ?? "").localeCompare(String(right.album?.title ?? "")));
    const total = entries.length;
    const groups = [];
    for (const entry of entries.slice(0, Math.max(0, limit))) {
      const key = localDayKey(entry.addedAt);
      let group = groups[groups.length - 1];
      if (!group || group.key !== key) {
        group = { key, label: additionHeading(entry.addedAt, now ?? Date.now(), locale), entries: [] };
        groups.push(group);
      }
      group.entries.push(entry);
    }
    return Object.assign(groups, { total });
  }

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------

  function sectionVisible(doc, id) {
    return doc.sections.find((section) => section.id === id)?.visible !== false;
  }

  function setSectionVisible(doc, id, visible) {
    const section = doc.sections.find((item) => item.id === id);
    if (!section || section.visible === Boolean(visible)) {
      return false;
    }
    section.visible = Boolean(visible);
    return true;
  }

  function moveSection(doc, id, delta) {
    const from = doc.sections.findIndex((section) => section.id === id);
    const to = from + Math.sign(Number(delta) || 0);
    if (from < 0 || to < 0 || to >= doc.sections.length || to === from) {
      return false;
    }
    const [section] = doc.sections.splice(from, 1);
    doc.sections.splice(to, 0, section);
    return true;
  }

  /** Restores section order/visibility only; pins and history are untouched. */
  function restoreDefaultLayout(doc) {
    doc.sections = defaultSections();
    return doc;
  }

  function isDefaultLayout(doc) {
    return doc.sections.length === SECTION_IDS.length
      && doc.sections.every((section, index) => section.id === SECTION_IDS[index] && section.visible);
  }

  /**
   * Render plan: visible sections that currently have content, in configured order.
   * New in your library and Most played this month become one "pair" block when both render
   * and are adjacent; CSS decides whether the pair sits side by side (stage width).
   */
  function layoutBlocks(doc, hasContent = () => true) {
    const shown = doc.sections.filter((section) => section.visible && hasContent(section.id)).map((section) => section.id);
    const blocks = [];
    for (let index = 0; index < shown.length; index += 1) {
      const id = shown[index];
      const next = shown[index + 1];
      if (PAIRABLE.includes(id) && PAIRABLE.includes(next) && id !== next) {
        blocks.push({ type: "pair", ids: [id, next] });
        index += 1;
      } else {
        blocks.push({ type: "single", ids: [id] });
      }
    }
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Most played this month (async host response guard)
  // ---------------------------------------------------------------------------

  /** Accept only the newest request's response, and only for the month currently shown. */
  function acceptTopTracksResponse(response, { latestRequestId, currentMonth }) {
    return Boolean(response)
      && Number(response.requestId) === Number(latestRequestId)
      && response.month === currentMonth
      && Array.isArray(response.tracks);
  }

  const api = {
    VERSION,
    MAX_PINS,
    MAX_HISTORY,
    PIN_KINDS,
    SECTION_IDS,
    SECTION_LABELS,
    LIKED_PIN,
    createDefault,
    normalize,
    pinKey,
    isPinned,
    addPin,
    removePin,
    movePin,
    pinsFull,
    seedDefaultPins,
    historyKindForSource,
    recordPlay,
    mergeHistory,
    pickJumpBackIn,
    localDayKey,
    monthKey,
    msUntilNextMonth,
    relativeDay,
    relativeTime,
    additionHeading,
    setResumePoint,
    pausedAtFor,
    groupNewAdditions,
    sectionVisible,
    setSectionVisible,
    moveSection,
    restoreDefaultLayout,
    isDefaultLayout,
    layoutBlocks,
    acceptTopTracksResponse
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpHomeModel = api;
})(typeof window !== "undefined" ? window : globalThis);
