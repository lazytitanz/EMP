/**
 * Authoritative playback-queue helpers (pure, testable).
 * Entries carry stable uids + provenance so duplicates and user edits survive shuffle/session.
 */
(function (global) {
  "use strict";

  const ORIGIN_SOURCE = "source";
  const ORIGIN_USER = "user";

  let uidCounter = 0;

  function resetUidCounter(value = 0) {
    uidCounter = Math.max(0, Number(value) || 0);
  }

  function nextUid() {
    uidCounter += 1;
    return `qe_${uidCounter}`;
  }

  function createEntry(trackId, origin = ORIGIN_SOURCE, uid) {
    return {
      uid: uid || nextUid(),
      trackId: String(trackId),
      origin: origin === ORIGIN_USER ? ORIGIN_USER : ORIGIN_SOURCE
    };
  }

  function entriesFromIds(ids, origin = ORIGIN_SOURCE) {
    return (ids || []).map((id) => createEntry(id, origin));
  }

  function cloneEntries(entries) {
    return (entries || []).map((entry) => ({
      uid: entry.uid,
      trackId: entry.trackId,
      origin: entry.origin === ORIGIN_USER ? ORIGIN_USER : ORIGIN_SOURCE
    }));
  }

  function trackIdsFromEntries(entries) {
    return (entries || []).map((entry) => entry.trackId);
  }

  function syncQueueProjection(state) {
    state.queue = trackIdsFromEntries(state.entries);
    return state.queue;
  }

  function entryIndexByUid(entries, uid) {
    return (entries || []).findIndex((entry) => entry.uid === uid);
  }

  function currentEntry(state) {
    if (!state?.entries?.length || state.index < 0 || state.index >= state.entries.length) {
      return null;
    }
    return state.entries[state.index];
  }

  function upcomingEntries(state) {
    if (!state?.entries?.length || state.index < 0) {
      return [];
    }
    return state.entries.slice(state.index + 1);
  }

  function bumpRevision(state) {
    state.orderRevision = (Number(state.orderRevision) || 0) + 1;
    return state.orderRevision;
  }

  function markDirty(state) {
    state.queueDirty = true;
  }

  function bumpPreloadGeneration(state) {
    state.preloadGeneration = (Number(state.preloadGeneration) || 0) + 1;
    return state.preloadGeneration;
  }

  function peekNextTrackId(state, { wrap = true } = {}) {
    const entries = state?.entries || [];
    if (!entries.length || state.index < 0) {
      return null;
    }
    if (state.index + 1 < entries.length) {
      return entries[state.index + 1].trackId;
    }
    return wrap && entries.length ? entries[0].trackId : null;
  }

  function planNextPreload(state, { wrap = true, repeatOne = false, shouldPreload = true } = {}) {
    const generation = bumpPreloadGeneration(state);
    if (repeatOne || !shouldPreload) {
      return { generation, nextTrackId: null, action: "clear" };
    }
    const nextTrackId = peekNextTrackId(state, { wrap });
    if (!nextTrackId) {
      return { generation, nextTrackId: null, action: "clear" };
    }
    return { generation, nextTrackId, action: "preload" };
  }

  function isPreloadPlanCurrent(state, generation) {
    return Number(generation) === Number(state.preloadGeneration);
  }

  function shuffleInPlace(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function replaceQueue(state, trackIds, startTrackId, { source = null } = {}) {
    const entries = entriesFromIds(trackIds, ORIGIN_SOURCE);
    let index = 0;
    if (startTrackId) {
      const found = entries.findIndex((entry) => entry.trackId === startTrackId);
      index = found >= 0 ? found : 0;
    }
    state.entries = entries;
    state.index = entries.length ? index : -1;
    state.playNextCount = 0;
    state.queueDirty = false;
    state.queueSource = source ?? state.queueSource ?? null;
    state.shuffleBag = [];
    bumpRevision(state);
    syncQueueProjection(state);
    return state;
  }

  function ensurePlaying(state) {
    if (!state.entries.length) {
      state.index = -1;
      return false;
    }
    if (state.index < 0 || state.index >= state.entries.length) {
      state.index = 0;
    }
    return true;
  }

  /**
   * Play Next — FIFO after current and after the pending play-next block.
   */
  function playNextTracks(state, trackIds) {
    const ids = (trackIds || []).filter(Boolean);
    if (!ids.length) {
      return state;
    }
    if (!state.entries.length) {
      replaceQueue(state, ids, ids[0], { source: state.queueSource });
      state.entries.forEach((entry) => {
        entry.origin = ORIGIN_USER;
      });
      state.queueDirty = true;
      bumpRevision(state);
      syncQueueProjection(state);
      return state;
    }
    ensurePlaying(state);
    const insertAt = state.index + 1 + Math.max(0, Number(state.playNextCount) || 0);
    const created = entriesFromIds(ids, ORIGIN_USER);
    state.entries.splice(insertAt, 0, ...created);
    state.playNextCount = Math.max(0, Number(state.playNextCount) || 0) + created.length;
    markDirty(state);
    bumpRevision(state);
    syncQueueProjection(state);
    return state;
  }

  function addToQueueTracks(state, trackIds) {
    const ids = (trackIds || []).filter(Boolean);
    if (!ids.length) {
      return state;
    }
    if (!state.entries.length) {
      replaceQueue(state, ids, ids[0], { source: state.queueSource });
      state.entries.forEach((entry) => {
        entry.origin = ORIGIN_USER;
      });
      state.queueDirty = true;
      bumpRevision(state);
      syncQueueProjection(state);
      return state;
    }
    state.entries.push(...entriesFromIds(ids, ORIGIN_USER));
    markDirty(state);
    bumpRevision(state);
    syncQueueProjection(state);
    return state;
  }

  function removeEntry(state, uid) {
    const index = entryIndexByUid(state.entries, uid);
    if (index < 0) {
      return { removed: null };
    }
    if (index === state.index) {
      return { removed: null, blocked: "current" };
    }
    const [removed] = state.entries.splice(index, 1);
    if (index < state.index) {
      state.index -= 1;
    } else {
      const playNextEnd = state.index + Math.max(0, Number(state.playNextCount) || 0);
      if (index > state.index && index <= playNextEnd) {
        state.playNextCount = Math.max(0, (Number(state.playNextCount) || 0) - 1);
      }
    }
    markDirty(state);
    bumpRevision(state);
    syncQueueProjection(state);
    return { removed };
  }

  function clearUpcoming(state) {
    if (!state.entries.length || state.index < 0) {
      return { removed: [] };
    }
    const removed = state.entries.splice(state.index + 1);
    state.playNextCount = 0;
    markDirty(state);
    bumpRevision(state);
    syncQueueProjection(state);
    return { removed };
  }

  function restoreClearedUpcoming(state, removed) {
    if (!removed?.length) {
      return state;
    }
    ensurePlaying(state);
    state.entries.splice(state.index + 1, state.entries.length - (state.index + 1), ...cloneEntries(removed));
    state.playNextCount = removed.filter((entry) => entry.origin === ORIGIN_USER).length;
    markDirty(state);
    bumpRevision(state);
    syncQueueProjection(state);
    return state;
  }

  /**
   * Move an upcoming entry to a new upcoming index (0 = first upcoming).
   * Operates on the upcoming slice so source/destination indices stay aligned
   * with the drawer insert indicator after the dragged row is removed.
   */
  function moveUpcomingEntry(state, uid, toUpcomingIndex) {
    const from = entryIndexByUid(state.entries, uid);
    if (from <= state.index) {
      return false;
    }
    const head = state.entries.slice(0, state.index + 1);
    const upcoming = state.entries.slice(state.index + 1);
    const fromUpcoming = from - state.index - 1;
    if (fromUpcoming < 0 || fromUpcoming >= upcoming.length) {
      return false;
    }
    const targetUpcoming = Math.max(0, Math.min(upcoming.length - 1, Number(toUpcomingIndex) || 0));
    if (fromUpcoming === targetUpcoming) {
      return false;
    }
    const [entry] = upcoming.splice(fromUpcoming, 1);
    entry.origin = ORIGIN_USER;
    upcoming.splice(targetUpcoming, 0, entry);
    state.entries = [...head, ...upcoming];

    let count = 0;
    for (let i = state.index + 1; i < state.entries.length; i += 1) {
      if (state.entries[i].origin !== ORIGIN_USER) {
        break;
      }
      count += 1;
    }
    state.playNextCount = count;
    markDirty(state);
    bumpRevision(state);
    syncQueueProjection(state);
    return true;
  }

  function moveEntryToEnd(state, uid) {
    const upcoming = upcomingEntries(state);
    if (!upcoming.length) {
      return false;
    }
    return moveUpcomingEntry(state, uid, upcoming.length - 1);
  }

  function jumpToEntry(state, uid) {
    const index = entryIndexByUid(state.entries, uid);
    if (index < 0) {
      return null;
    }
    state.index = index;
    state.playNextCount = 0;
    bumpRevision(state);
    syncQueueProjection(state);
    return state.entries[index];
  }

  /**
   * Prefer advancing to index+1 when trackId matches (duplicate-safe handoff).
   */
  function advanceToTrackId(state, trackId) {
    if (!state.entries.length) {
      return false;
    }
    const next = state.entries[state.index + 1];
    if (next && next.trackId === trackId) {
      state.index += 1;
      state.playNextCount = Math.max(0, (Number(state.playNextCount) || 0) - 1);
      bumpRevision(state);
      syncQueueProjection(state);
      return true;
    }
    const found = state.entries.findIndex((entry) => entry.trackId === trackId);
    if (found < 0) {
      return false;
    }
    state.index = found;
    state.playNextCount = 0;
    bumpRevision(state);
    syncQueueProjection(state);
    return true;
  }

  function stepNextIndex(state, { wrap = true } = {}) {
    if (!state.entries.length) {
      return { ok: false, reason: "empty" };
    }
    if (state.index + 1 < state.entries.length) {
      state.index += 1;
      state.playNextCount = Math.max(0, (Number(state.playNextCount) || 0) - 1);
      bumpRevision(state);
      syncQueueProjection(state);
      return { ok: true, entry: state.entries[state.index] };
    }
    if (!wrap) {
      return { ok: false, reason: "end" };
    }
    state.index = 0;
    state.playNextCount = 0;
    bumpRevision(state);
    syncQueueProjection(state);
    return { ok: true, entry: state.entries[state.index] };
  }

  function stepPreviousIndex(state) {
    if (!state.entries.length) {
      return { ok: false, reason: "empty" };
    }
    state.index = (state.index - 1 + state.entries.length) % state.entries.length;
    state.playNextCount = 0;
    bumpRevision(state);
    syncQueueProjection(state);
    return { ok: true, entry: state.entries[state.index] };
  }

  /**
   * Enable shuffle: preserve user upcoming order; shuffle source upcoming after that block.
   */
  function enableShuffle(state, randomize = shuffleInPlace) {
    state.shuffle = true;
    if (!state.entries.length || state.index < 0) {
      state.shuffleBag = [];
      bumpRevision(state);
      syncQueueProjection(state);
      return state;
    }
    const head = state.entries.slice(0, state.index + 1);
    const upcoming = state.entries.slice(state.index + 1);
    const userUpcoming = upcoming.filter((entry) => entry.origin === ORIGIN_USER);
    const sourceUpcoming = upcoming.filter((entry) => entry.origin !== ORIGIN_USER);
    randomize(sourceUpcoming);
    state.entries = [...head, ...userUpcoming, ...sourceUpcoming];
    state.playNextCount = userUpcoming.length;
    state.shuffleBag = [];
    bumpRevision(state);
    syncQueueProjection(state);
    return state;
  }

  /**
   * Disable shuffle: keep the edited/shuffled entries order as the new linear order.
   */
  function disableShuffle(state) {
    state.shuffle = false;
    state.shuffleBag = [];
    bumpRevision(state);
    syncQueueProjection(state);
    return state;
  }

  function setShuffle(state, enabled, randomize = shuffleInPlace) {
    if (enabled) {
      return enableShuffle(state, randomize);
    }
    return disableShuffle(state);
  }

  function queueHasUserModifications(state) {
    if (state.queueDirty) {
      return true;
    }
    return (state.entries || []).some((entry) => entry.origin === ORIGIN_USER);
  }

  function canCompactSessionQueue(state, { queueMatchesFullLibrary } = {}) {
    if (queueHasUserModifications(state)) {
      return false;
    }
    const kind = state.queueSource?.kind;
    if (kind !== "library" && kind !== "songs") {
      return false;
    }
    if (typeof queueMatchesFullLibrary === "function") {
      return queueMatchesFullLibrary(trackIdsFromEntries(state.entries));
    }
    return false;
  }

  function serializeQueueSession(state) {
    return {
      entries: cloneEntries(state.entries),
      index: state.index,
      orderRevision: Number(state.orderRevision) || 0,
      playNextCount: Math.max(0, Number(state.playNextCount) || 0),
      queueDirty: Boolean(state.queueDirty),
      queueSource: state.queueSource ?? null,
      shuffle: Boolean(state.shuffle),
      queue: trackIdsFromEntries(state.entries),
      shuffleBag: []
    };
  }

  function hydrateEntriesFromSession(session, { trackExists } = {}) {
    const exists = typeof trackExists === "function" ? trackExists : () => true;
    if (Array.isArray(session?.entries) && session.entries.length) {
      const entries = [];
      let maxUid = uidCounter;
      for (const raw of session.entries) {
        if (!raw || !exists(raw.trackId)) {
          continue;
        }
        const uid = typeof raw.uid === "string" && raw.uid ? raw.uid : nextUid();
        const match = /^qe_(\d+)$/.exec(uid);
        if (match) {
          maxUid = Math.max(maxUid, Number(match[1]) || 0);
        }
        entries.push(createEntry(raw.trackId, raw.origin, uid));
      }
      resetUidCounter(maxUid);
      return entries;
    }

    const order = Array.isArray(session?.shuffleBag) && session.shuffle && session.shuffleBag.length
      ? session.shuffleBag
      : (Array.isArray(session?.queue) ? session.queue : []);
    return entriesFromIds(order.filter(exists), ORIGIN_SOURCE);
  }

  function restoreQueueSession(state, session, { trackExists } = {}) {
    const entries = hydrateEntriesFromSession(session, { trackExists });
    state.entries = entries;
    state.queueDirty = Boolean(session?.queueDirty) || entries.some((entry) => entry.origin === ORIGIN_USER);
    state.playNextCount = Math.max(0, Number(session?.playNextCount) || 0);
    state.orderRevision = Number(session?.orderRevision) || 0;
    state.queueSource = session?.queueSource ?? state.queueSource ?? null;
    state.shuffle = Boolean(session?.shuffle);
    state.shuffleBag = [];

    let index = Number(session?.index);
    if (!Number.isFinite(index) || index < 0 || index >= entries.length) {
      const trackId = session?.trackId;
      index = trackId ? entries.findIndex((entry) => entry.trackId === trackId) : 0;
    }
    state.index = entries.length ? Math.max(0, index) : -1;
    if (state.playNextCount > upcomingEntries(state).length) {
      state.playNextCount = upcomingEntries(state).filter((entry) => entry.origin === ORIGIN_USER).length;
    }
    syncQueueProjection(state);
    return state;
  }

  function findEntryForTrackPlay(state, trackId, { preferUid = null } = {}) {
    if (preferUid) {
      const byUid = entryIndexByUid(state.entries, preferUid);
      if (byUid >= 0) {
        return { index: byUid, entry: state.entries[byUid] };
      }
    }
    if (state.entries[state.index]?.trackId === trackId) {
      return { index: state.index, entry: state.entries[state.index] };
    }
    for (let i = state.index + 1; i < state.entries.length; i += 1) {
      if (state.entries[i].trackId === trackId) {
        return { index: i, entry: state.entries[i] };
      }
    }
    const found = state.entries.findIndex((entry) => entry.trackId === trackId);
    if (found >= 0) {
      return { index: found, entry: state.entries[found] };
    }
    return null;
  }

  const api = {
    ORIGIN_SOURCE,
    ORIGIN_USER,
    resetUidCounter,
    nextUid,
    createEntry,
    entriesFromIds,
    cloneEntries,
    trackIdsFromEntries,
    syncQueueProjection,
    entryIndexByUid,
    currentEntry,
    upcomingEntries,
    bumpRevision,
    bumpPreloadGeneration,
    peekNextTrackId,
    planNextPreload,
    isPreloadPlanCurrent,
    shuffleInPlace,
    replaceQueue,
    playNextTracks,
    addToQueueTracks,
    removeEntry,
    clearUpcoming,
    restoreClearedUpcoming,
    moveUpcomingEntry,
    moveEntryToEnd,
    jumpToEntry,
    advanceToTrackId,
    stepNextIndex,
    stepPreviousIndex,
    enableShuffle,
    disableShuffle,
    setShuffle,
    queueHasUserModifications,
    canCompactSessionQueue,
    serializeQueueSession,
    hydrateEntriesFromSession,
    restoreQueueSession,
    findEntryForTrackPlay
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpQueueModel = api;
})(typeof window !== "undefined" ? window : globalThis);
