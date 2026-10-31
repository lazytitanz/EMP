const CROSSFADE_SECONDS = 8;
const GAPLESS_LEAD_SECONDS = 0.12;
const PRELOAD_SECONDS = 20;
const ReplayGain = globalThis.EmpReplayGain;
const Transitions = globalThis.EmpPlaybackTransitions;
const PeakProtect = globalThis.EmpPeakProtect;
const GraphRecovery = globalThis.EmpAudioGraphRecovery;

function clampCrossfadeSeconds(value) {
  return Transitions?.clampCrossfadeSeconds?.(value) ?? CROSSFADE_SECONDS;
}

function createAudioPlayer() {
  const el = new Audio();
  el.preload = "auto";
  el.loop = false;
  return {
    el,
    source: null,
    gain: null,
    analyser: null,
    fade: 1,
    normalize: 1,
    trackId: null,
    listenOccurrence: null
  };
}

const players = [createAudioPlayer(), createAudioPlayer()];
players[1].fade = 0;

let currentPlayerIndex = 0;
let audioContext = null;
let masterGain = null;
let eqPreamp = null;
let eqFilters = [];
let eqReady = false;
let cachedEqHeadroomDb = 0;
let audioGraphReady = false;
let peakCompressor = null;
let peakDryGain = null;
let peakWetGain = null;
let audioOutputDevices = [];
let audioOutputSupported = false;
let audioContextResumePromise = null;
let playbackElementBindGeneration = 0;
let transitionGeneration = 0;
let preloadGeneration = 0;
let fadeRaf = 0;
let playbackTransitioning = false;
let fadeStartedAt = 0;
let fadeDurationMs = CROSSFADE_SECONDS * 1000;

function currentPlayer() {
  return players[currentPlayerIndex];
}

function incomingPlayer() {
  return players[1 - currentPlayerIndex];
}

function currentAudio() {
  return currentPlayer().el;
}

function swapPlayers() {
  currentPlayerIndex = 1 - currentPlayerIndex;
}

const REPEAT_MODES = ["off", "all", "one"];

const state = {
  library: { rootPath: "", folders: [], albums: [], singles: [], tracks: [] },
  heldTracks: new Map(),
  view: "home",
  albumId: null,
  artist: null,
  query: "",
  queue: [],
  queueSource: null,
  shuffleBag: [],
  index: -1,
  playing: false,
  seeking: false,
  shuffle: false,
  repeat: "off",
  liked: new Set(),
  volume: 80,
  muted: false,
  lastVolume: 80,
  recentAlbumIds: [],
  recentTrackIds: [],
  recentPlaylistIds: [],
  recentHome: [],
  recentsFilter: "albums",
  playlists: [],
  playlistId: null,
  mixId: null,
  personalizedMixes: true,
  albumFilter: "all",
  librarySort: "recent",
  libraryLayout: "grid",
  sidebarSort: "recent",
  sidebarWidth: 300,
  sidebarCollapsed: false,
  libraryQuery: "",
  holdEnded: false,
  crossfade: false,
  gapless: false,
  crossfadeSeconds: CROSSFADE_SECONDS,
  normalizeVolume: false,
  normalizeMode: "track",
  preventClipping: true,
  audioOutputId: "",
  audioOutputLabel: "",
  equalizerEnabled: false,
  equalizerPreset: "flat",
  equalizerGains: cloneEqGains(EQ_FLAT_GAINS),
  startupOnLogin: "no",
  closeMinimizes: false,
  automaticUpdateChecks: true,
  appVersion: "",
  updateStatus: {
    state: "idle",
    availableVersion: null,
    progress: null,
    error: null,
    dismissedUpdateVersion: null
  },
  playbackTarget: "local",
  connectingDeviceId: null,
  castDevices: [],
  castError: null,
  castVolumeAvailable: false,
  remotePosition: 0,
  remoteDuration: 0,
  remoteStatusAt: 0,
  listenStats: null,
  songsQuery: "",
  songsSort: "title",
  songsSortDir: "asc",
  songsNeverPlayed: false
};

const historyStack = [{ view: "home" }];
let historyIndex = 0;

const viewArea = document.getElementById("viewArea");
const libraryList = document.getElementById("libraryList");
const sidebar = document.getElementById("sidebar");
const librarySearch = document.getElementById("librarySearch");
const sidebarSortBtn = document.getElementById("sidebarSortBtn");
const sidebarSortLabel = document.getElementById("sidebarSortLabel");
const sidebarCollapseBtn = document.getElementById("sidebarCollapseBtn");
const sidebarResize = document.getElementById("sidebarResize");
const createPlaylistBtn = document.getElementById("createPlaylistBtn");
const topSearch = document.getElementById("topSearch");
const searchInput = document.getElementById("searchInput");
const mainStage = document.getElementById("mainStage");
const nowCover = document.getElementById("nowCover");
const nowTitle = document.getElementById("nowTitle");
const nowArtist = document.getElementById("nowArtist");
const playBtn = document.getElementById("playBtn");
const likeBtn = document.getElementById("likeBtn");
const seekBar = document.getElementById("seekBar");
const volumeBar = document.getElementById("volumeBar");
const elapsedEl = document.getElementById("elapsed");
const durationEl = document.getElementById("duration");
const shuffleBtn = document.getElementById("shuffleBtn");
const repeatBtn = document.getElementById("repeatBtn");
const muteBtn = document.getElementById("muteBtn");
const deviceBtn = document.getElementById("deviceBtn");
const deviceDrawerRoot = document.getElementById("deviceDrawerRoot");
const deviceDrawerBody = document.getElementById("deviceDrawerBody");
const deviceDrawerStatus = document.getElementById("deviceDrawerStatus");
const deviceDrawerAlert = document.getElementById("deviceDrawerAlert");
const deviceDrawerNote = document.getElementById("deviceDrawerNote");
const deviceRescanBtn = document.getElementById("deviceRescan");
const lyricsBtn = document.getElementById("lyricsBtn");
const queueBtn = document.getElementById("queueBtn");
const queueDrawerRoot = document.getElementById("queueDrawerRoot");
const queueDrawerBody = document.getElementById("queueDrawerBody");
const queueDrawerStatus = document.getElementById("queueDrawerStatus");

const SESSION_KEY = "emp.playback";
const LIKED_PLAYLIST_ID = "pl_liked";
const LIKED_PLAYLIST_NAME = "Liked Songs";
const HOME_QUICK_SIZE = 6;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 420;
const SIDEBAR_COLLAPSED = 72;
const HOME_SHELF_SIZE = 32;
const SIDEBAR_RECENTS = 12;
const MAX_RECENTS = 24;
const SEARCH_ALBUM_LIMIT = 12;
const SEARCH_TRACK_LIMIT = 40;
const SEARCH_ARTIST_LIMIT = 6;
const SEARCH_PLAYLIST_LIMIT = 6;
const SEARCH_SHOW_MORE_BATCH = 12;
const SEARCH_HISTORY_KEY = "emp.searchHistory.v1";
const SEARCH_HISTORY_MAX = 8;
const SEARCH_HISTORY_MIN_LEN = 2;
const SEARCH_HISTORY_IDLE_MS = 2500;
const TRACK_ROW_HEIGHT = 58;
const ARTIST_INFO_TIMEOUT_MS = 15000;
const DEVICE_SCAN_MS = 6000;
const DEVICE_DRAWER_EXIT_MS = 280;
const QUEUE_DRAWER_LIMIT = 100;
const QUEUE_SOURCE_KINDS = ["album", "playlist", "smart", "artist", "recents", "library", "songs", "mix"];
const SONGS_SORT_OPTIONS = [
  { id: "title", label: "Title" },
  { id: "artist", label: "Artist" },
  { id: "album", label: "Album" },
  { id: "duration", label: "Duration" },
  { id: "year", label: "Year" },
  { id: "mostPlayed", label: "Most Played" },
  { id: "leastPlayed", label: "Least Played" },
  { id: "recentlyPlayed", label: "Recently Played" }
];
const SONGS_FILTER_DEBOUNCE_MS = 120;
const SEARCH_DEBOUNCE_MS = 150;
/** Set `window.__EMP_SEARCH_PERF__ = true` before load to log match vs render timings. */
const SEARCH_PERF_ENABLED = Boolean(globalThis.__EMP_SEARCH_PERF__);
/** Set `window.__EMP_LIBRARY_PERF__ = true` before load to log browse/virtualizer timings. */
const LIBRARY_PERF_ENABLED = Boolean(globalThis.__EMP_LIBRARY_PERF__);
const COLLECTION_VIRTUAL_THRESHOLD = 96;
const COLLECTION_GRID_MIN = 160;
const COLLECTION_GRID_GAP = 18;
const COLLECTION_LIST_ROW_HEIGHT = 64;
const COLLECTION_OVERSCAN_ROWS = 4;
const LYRICS_FALLBACK_COLOR = "#535353";
// Keeps white lyrics text at roughly 4.5:1 contrast or better.
const LYRICS_MAX_LUMINANCE = 0.18;
const LYRICS_ENTRY_LIMIT = 40;
const LYRICS_RETRY_MS = 60000;
const LYRICS_REQUEST_DELAY_MS = 250;
const LYRICS_USER_SCROLL_MS = 4000;
const LYRICS_FOCUS_RATIO = 0.35;
const RESCAN_HOLD_MS = 1000;
const RESCAN_EXPAND_MS = 220;
const artistInfoCache = new Map();
/** Session-scoped: confirmed empty MusicBrainz lookups (not timeouts/errors). */
const artistInfoEmptyCache = new Set();
let artistInfoRequestId = 0;
let artistInfoPendingName = null;
let sessionRestored = false;
let libraryContentFingerprint = "";
let pendingRescanId = "";
let rescanTimer = 0;
let storageUsage = null;
let updateUiShellReady = false;
let updateToastSessionDismissedVersion = null;
let searchIndex = null;
let searchDebounceTimer = 0;
let searchRequestId = 0;
let lastSessionWrite = 0;
let trackVirtual = null;
let collectionVirtual = null;
let collectionResizeRaf = 0;
/** @type {Map<number, { filter: string, layout: string, sort: string, anchorIndex: number, anchorOffset: number }>} */
const browseScrollByHistoryIndex = new Map();
let lastAudioTime = 0;
let listenStatsLoaded = false;
let listenStatsRequestPending = false;
let listenStatsStale = false;
let songsFilterTimer = 0;
let songsResultIds = [];
let sessionSaveFailed = false;

// Local listening statistics (durable store owned by the C# host).
const LISTEN_STATS_TICK_MS = 400;
const LISTEN_STATS_POST_MS = 2000;
let listenSessionToken = createListenSessionToken();
let listenUpdateId = 0;
let listenTickTimer = 0;
let listenPostTimer = 0;
let remoteListenOccurrence = null;
let pendingFinalizedListen = [];

function createListenSessionToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function createListenOccurrence(trackId, durationSec) {
  return {
    trackId,
    listenMs: 0,
    sentListenMs: 0,
    dayListenMs: {},
    sentDayListenMs: {},
    checkpointMs: 0,
    wallCheckpointMs: 0,
    playCounted: false,
    playCountSent: false,
    lastPlayedAt: 0,
    lastPlayedAtSent: 0,
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    seeking: false,
    stalled: false,
    finalized: false
  };
}

function listenThresholdMs(durationSec) {
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) {
    return 30000;
  }
  return Math.min(30000, 0.5 * durationSec * 1000);
}

function maybeQualifyListen(occ) {
  if (!occ || occ.finalized || occ.playCounted) {
    return;
  }
  if (occ.listenMs >= listenThresholdMs(occ.durationSec)) {
    occ.playCounted = true;
    occ.lastPlayedAt = Date.now();
    bumpListenStatsLocal(occ.trackId, occ.lastPlayedAt);
  }
}

function bumpListenStatsLocal(trackId, lastPlayedAt) {
  if (!trackId) {
    return;
  }
  if (!state.listenStats || typeof state.listenStats !== "object") {
    state.listenStats = {};
  }
  const prev = state.listenStats[trackId] || { playCount: 0, lastPlayedAt: 0, listenMs: 0 };
  state.listenStats[trackId] = {
    playCount: (Number(prev.playCount) || 0) + 1,
    lastPlayedAt: Math.max(Number(prev.lastPlayedAt) || 0, Number(lastPlayedAt) || Date.now()),
    listenMs: Math.max(0, Number(prev.listenMs) || 0)
  };
  listenStatsStale = true;
  if (state.view === "songs") {
    refreshSongsResults({ preserveScroll: true });
  }
  scheduleSmartReevaluation({ stats: true, dateRelative: true });
}

function ensureListenStatsForSongs() {
  if (listenStatsRequestPending) {
    return;
  }
  if (listenStatsLoaded && !listenStatsStale) {
    return;
  }
  if (!window.chrome?.webview?.postMessage) {
    if (!state.listenStats) {
      state.listenStats = {};
    }
    listenStatsLoaded = true;
    listenStatsStale = false;
    return;
  }
  listenStatsRequestPending = true;
  window.chrome.webview.postMessage({ type: "listenStatsRequest" });
  window.setTimeout(() => {
    if (listenStatsRequestPending) {
      listenStatsRequestPending = false;
      listenStatsStale = true;
      if (!listenStatsLoaded) {
        if (!state.listenStats) {
          state.listenStats = {};
        }
        listenStatsLoaded = true;
        maybeRefreshMixesAfterStats();
      }
    }
  }, 8000);
}

function applyListenStats(detail) {
  listenStatsRequestPending = false;
  const tracks = detail?.tracks && typeof detail.tracks === "object" ? detail.tracks : {};
  const next = {};
  for (const [id, stats] of Object.entries(tracks)) {
    if (!id || !stats || typeof stats !== "object") {
      continue;
    }
    next[id] = {
      playCount: Math.max(0, Number(stats.playCount) || 0),
      lastPlayedAt: Math.max(0, Number(stats.lastPlayedAt) || 0),
      listenMs: Math.max(0, Number(stats.listenMs) || 0)
    };
  }
  state.listenStats = next;
  listenStatsLoaded = true;
  listenStatsStale = false;
  if (state.view === "songs") {
    refreshSongsResults({ preserveScroll: true });
  }
  maybeRefreshMixesAfterStats();
  scheduleSmartReevaluation({ stats: true, dateRelative: true });
}

function trackListenMs(trackId) {
  return Math.max(0, Number(state.listenStats?.[trackId]?.listenMs) || 0);
}

function mixById(id) {
  return window.EmpMixes?.getMixById?.(id) ?? null;
}

function mixTracks(mix) {
  return (mix?.trackIds ?? []).map(trackById).filter(Boolean);
}

function mixQueueIds(mix) {
  return mixTracks(mix).map((track) => track.id);
}

function isMixQueuePlaying(mixId) {
  return state.queueSource?.kind === "mix"
    && state.queueSource?.id === mixId
    && Boolean(currentTrack())
    && state.playing;
}

function ensurePersonalizedMixes({ forceStats = false } = {}) {
  if (state.personalizedMixes === false) {
    return [];
  }
  if (!window.EmpMixes?.ensureMixSnapshot) {
    return [];
  }
  if (!state.library?.tracks?.length) {
    return [];
  }
  if (forceStats || (!listenStatsLoaded && !listenStatsRequestPending)) {
    ensureListenStatsForSongs();
  }
  // Avoid writing a cold-start snapshot before durable stats arrive on first paint.
  // Same-day cached snapshots still load; generation waits until stats are ready
  // (or the host is unavailable so listenStatsLoaded was set empty).
  const allowGenerate = listenStatsLoaded || !window.chrome?.webview?.postMessage;
  try {
    window.EmpMixes.ensureMixSnapshot({
      enabled: true,
      tracks: state.library.tracks,
      listenStats: state.listenStats || {},
      libraryFingerprint: libraryContentFingerprint || "",
      now: Date.now(),
      allowGenerate
    });
  } catch (error) {
    console.error("EMP mix generation failed.", error);
    return [];
  }
  return window.EmpMixes.getHomeMixes?.(window.EmpMixes.MAX_HOME_MIXES) || [];
}

function maybeRefreshMixesAfterStats() {
  if (state.personalizedMixes === false) {
    return;
  }
  if (!state.library?.tracks?.length) {
    return;
  }
  const beforeIds = (window.EmpMixes?.peekSnapshot?.()?.lineup || []).join("|");
  ensurePersonalizedMixes();
  const afterIds = (window.EmpMixes?.peekSnapshot?.()?.lineup || []).join("|");
  if (beforeIds === afterIds && beforeIds) {
    return;
  }
  if (state.view === "home") {
    renderHome();
  } else if (state.view === "mixes") {
    renderMixes();
  } else if (state.view === "mix" && state.mixId) {
    renderMix(state.mixId);
  }
}

function setPersonalizedMixes(enabled) {
  const next = Boolean(enabled);
  state.personalizedMixes = next;
  writeSession();
  if (state.view === "settings") {
    const toggle = viewArea.querySelector('[data-setting="personalizedMixes"]');
    toggle?.setAttribute("aria-checked", next ? "true" : "false");
  }
  if (!next) {
    if (state.view === "mix" || state.view === "mixes") {
      navigate({ view: "home" });
    } else if (state.view === "home") {
      renderHome();
    }
    return;
  }
  ensurePersonalizedMixes({ forceStats: true });
  if (state.view === "home") {
    renderHome();
  }
}

function mixCoverMarkup(mix, className) {
  const urls = selectDistinctCoverUrls(mixTracks(mix), 4);
  if (mix?.type === "artist" && urls[0]) {
    return coverMarkup({ coverUrl: urls[0], title: mix.title, color: "#282828" }, className);
  }
  if (urls.length >= 2) {
    return coverMosaicMarkup(urls, className);
  }
  if (urls[0]) {
    return coverMarkup({ coverUrl: urls[0], title: mix.title, color: "#282828" }, className);
  }
  return coverMarkup({ title: mix?.title, color: "#1e3b2a" }, className);
}

function mixCard(mix) {
  const playing = isMixQueuePlaying(mix.id);
  return `
    <article class="media-card${playing ? " is-playing" : ""}" data-open-mix="${escapeHtml(mix.id)}">
      <div class="media-cover-wrap">
        ${mixCoverMarkup(mix, "media-cover")}
        <button class="play-fab${playing ? " is-playing" : ""}" type="button" data-play-mix="${escapeHtml(mix.id)}" title="${playing ? "Pause" : "Play"}" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(mix.title)}">
          <i class="bi ${playing ? "bi-pause-fill" : "bi-play-fill"}"></i>
        </button>
      </div>
      <div class="media-title">${escapeHtml(mix.title)}</div>
      <div class="media-sub mix-card-desc">${escapeHtml(mix.description || "")}</div>
    </article>
  `;
}

function mixesShelfSection(mixes) {
  if (!mixes.length) {
    return "";
  }
  const cols = homeShelfColumns();
  const shown = mixes.slice(0, HOME_SHELF_SIZE);
  const showAll = mixes.length > cols;
  return `
    <section class="home-shelf home-shelf-mixes" data-shelf="mixes" data-total="${mixes.length}">
      <div class="section-head">
        <button class="section-title-btn" type="button" data-nav="mixes">
          <h2>Your Mixes</h2>
        </button>
        ${mixes.length > 2 ? `<button class="see-all" type="button" data-nav="mixes"${showAll ? "" : " hidden"}>See all</button>` : ""}
      </div>
      <div class="shelf-row">${shown.map(mixCard).join("")}</div>
    </section>
  `;
}

function albumsForHomeShelf(recentItems) {
  const recentAlbumIds = new Set();
  for (const item of recentItems) {
    if (item?.kind === "album" && item.album?.id) {
      recentAlbumIds.add(item.album.id);
    }
  }
  const ranked = albumsByRecency(state.library.albums);
  if (ranked.length <= recentAlbumIds.size + 2) {
    return ranked;
  }
  const preferred = ranked.filter((album) => !recentAlbumIds.has(album.id));
  return preferred.length >= Math.min(4, ranked.length) ? preferred : ranked;
}

function playMix(mixId, startId) {
  const mix = mixById(mixId);
  const ids = mixQueueIds(mix);
  if (!ids.length) {
    return;
  }
  playTrack(queueStartId(ids, startId), ids, { source: { kind: "mix", id: mixId } });
}

function trackPlayCount(trackId) {
  return Math.max(0, Number(state.listenStats?.[trackId]?.playCount) || 0);
}

function trackLastPlayedAt(trackId) {
  return Math.max(0, Number(state.listenStats?.[trackId]?.lastPlayedAt) || 0);
}

function normalizeSongsSort(value) {
  return SONGS_SORT_OPTIONS.some((option) => option.id === value) ? value : "title";
}

function normalizeSongsSortDir(value) {
  return value === "desc" ? "desc" : "asc";
}

function advanceListenOccurrence(occ, now, progressing, wallNow = Date.now()) {
  if (!occ || occ.finalized) {
    return;
  }
  if (occ.checkpointMs > 0) {
    const delta = now - occ.checkpointMs;
    if (delta > 0 && delta < 120000) {
      occ.listenMs += delta;
      const split = globalThis.EmpListenDateSplit;
      if (split?.splitListenMsByLocalDate) {
        const buckets = split.splitListenMsByLocalDate(delta, wallNow, occ.wallCheckpointMs || 0);
        split.addDayBuckets(occ.dayListenMs, buckets);
      } else {
        const key = split?.localDateKey?.(wallNow)
          || (() => {
            const d = new Date(wallNow);
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            return `${d.getFullYear()}-${m}-${day}`;
          })();
        occ.dayListenMs[key] = (Math.floor(Number(occ.dayListenMs[key])) || 0) + Math.floor(delta);
      }
      maybeQualifyListen(occ);
    }
  }
  occ.checkpointMs = progressing ? now : 0;
  occ.wallCheckpointMs = progressing ? wallNow : 0;
}

function listenOccurrenceDayDelta(occ) {
  const split = globalThis.EmpListenDateSplit;
  if (split?.dayBucketsDelta) {
    return split.dayBucketsDelta(occ.dayListenMs, occ.sentDayListenMs);
  }
  const out = {};
  for (const [key, value] of Object.entries(occ.dayListenMs || {})) {
    const delta = Math.floor(Number(value) || 0) - Math.floor(Number(occ.sentDayListenMs?.[key]) || 0);
    if (delta > 0) {
      out[key] = delta;
    }
  }
  return out;
}

function listenOccurrenceHasUnsent(occ) {
  if (!occ) {
    return false;
  }
  const listenMsDelta = Math.floor(occ.listenMs) - Math.floor(occ.sentListenMs);
  const playCountDelta = occ.playCounted && !occ.playCountSent ? 1 : 0;
  const lastPlayedAt = occ.lastPlayedAt > occ.lastPlayedAtSent ? occ.lastPlayedAt : 0;
  const dayDelta = listenOccurrenceDayDelta(occ);
  return listenMsDelta > 0 || playCountDelta > 0 || lastPlayedAt > 0 || Object.keys(dayDelta).length > 0;
}

function markListenOccurrenceSent(occ, listenMsDelta, playCountDelta, lastPlayedAt, dayListenMsDelta) {
  occ.sentListenMs += listenMsDelta;
  if (playCountDelta > 0) {
    occ.playCountSent = true;
  }
  if (lastPlayedAt > 0) {
    occ.lastPlayedAtSent = lastPlayedAt;
  }
  const split = globalThis.EmpListenDateSplit;
  if (split?.markDayBucketsSent) {
    split.markDayBucketsSent(occ.sentDayListenMs, dayListenMsDelta);
  } else if (dayListenMsDelta) {
    for (const [key, value] of Object.entries(dayListenMsDelta)) {
      const n = Math.floor(Number(value));
      if (n > 0) {
        occ.sentDayListenMs[key] = (Math.floor(Number(occ.sentDayListenMs[key])) || 0) + n;
      }
    }
  }
}

function allListenOccurrences() {
  const list = [];
  for (const player of players) {
    if (player.listenOccurrence) {
      list.push(player.listenOccurrence);
    }
  }
  if (remoteListenOccurrence) {
    list.push(remoteListenOccurrence);
  }
  for (const occ of pendingFinalizedListen) {
    list.push(occ);
  }
  return list;
}

function pruneSentFinalizedListen() {
  pendingFinalizedListen = pendingFinalizedListen.filter((occ) => listenOccurrenceHasUnsent(occ));
}

function buildListenStatsPayloads() {
  const payloads = [];
  for (const occ of allListenOccurrences()) {
    if (!listenOccurrenceHasUnsent(occ)) {
      continue;
    }
    const listenMsDelta = Math.max(0, Math.floor(occ.listenMs) - Math.floor(occ.sentListenMs));
    const playCountDelta = occ.playCounted && !occ.playCountSent ? 1 : 0;
    const lastPlayedAt = occ.lastPlayedAt > occ.lastPlayedAtSent ? occ.lastPlayedAt : 0;
    const dayListenMsDelta = listenOccurrenceDayDelta(occ);
    if (listenMsDelta <= 0 && playCountDelta <= 0 && lastPlayedAt <= 0 && Object.keys(dayListenMsDelta).length === 0) {
      continue;
    }
    listenUpdateId += 1;
    payloads.push({
      occ,
      listenMsDelta,
      playCountDelta,
      lastPlayedAt,
      dayListenMsDelta,
      message: {
        type: "listenStatsUpdate",
        sessionToken: listenSessionToken,
        updateId: listenUpdateId,
        trackId: occ.trackId,
        playCountDelta,
        listenMsDelta,
        lastPlayedAt: lastPlayedAt > 0 ? lastPlayedAt : 0,
        dayListenMsDelta
      }
    });
  }
  return payloads;
}

function postListenStatsUpdates() {
  const payloads = buildListenStatsPayloads();
  if (!payloads.length) {
    return [];
  }
  try {
    for (const item of payloads) {
      window.chrome?.webview?.postMessage(item.message);
      markListenOccurrenceSent(
        item.occ,
        item.listenMsDelta,
        item.playCountDelta,
        item.lastPlayedAt,
        item.dayListenMsDelta);
    }
  } catch {
    // Host bridge unavailable; keep unsent for a later flush.
  }
  pruneSentFinalizedListen();
  return payloads.map((item) => item.message);
}

function takeListenStatsUpdatesForClose() {
  const payloads = buildListenStatsPayloads();
  for (const item of payloads) {
    markListenOccurrenceSent(
      item.occ,
      item.listenMsDelta,
      item.playCountDelta,
      item.lastPlayedAt,
      item.dayListenMsDelta);
  }
  pruneSentFinalizedListen();
  return payloads.map((item) => item.message);
}

function scheduleListenStatsPost() {
  if (listenPostTimer) {
    return;
  }
  listenPostTimer = window.setTimeout(() => {
    listenPostTimer = 0;
    postListenStatsUpdates();
  }, LISTEN_STATS_POST_MS);
}

function ensureListenStatsTick() {
  if (listenTickTimer) {
    return;
  }
  listenTickTimer = window.setInterval(tickListenStats, LISTEN_STATS_TICK_MS);
}

function stopListenStatsTick() {
  if (listenTickTimer) {
    window.clearInterval(listenTickTimer);
    listenTickTimer = 0;
  }
  if (listenPostTimer) {
    window.clearTimeout(listenPostTimer);
    listenPostTimer = 0;
  }
}

function playerListenProgressing(player, occ) {
  if (!player || !occ || occ.finalized || occ.seeking || occ.stalled) {
    return false;
  }
  if (!player.trackId || player.trackId !== occ.trackId) {
    return false;
  }
  const el = player.el;
  return Boolean(el && !el.paused && !el.ended);
}

function tickPlayerListen(player, now) {
  const occ = player.listenOccurrence;
  if (!occ || occ.finalized) {
    return;
  }
  const el = player.el;
  if (!(occ.durationSec > 0) && el && Number.isFinite(el.duration) && el.duration > 0) {
    occ.durationSec = el.duration;
  }
  advanceListenOccurrence(occ, now, playerListenProgressing(player, occ));
}

function tickRemoteListen(now) {
  if (!isRemotePlayback()) {
    return;
  }
  const track = currentTrack();
  if (!track) {
    return;
  }
  if (!remoteListenOccurrence || remoteListenOccurrence.finalized || remoteListenOccurrence.trackId !== track.id) {
    return;
  }
  if (!(remoteListenOccurrence.durationSec > 0)) {
    const duration = state.remoteDuration || track.duration || 0;
    if (duration > 0) {
      remoteListenOccurrence.durationSec = duration;
    }
  }
  const progressing = Boolean(state.playing) && !remoteListenOccurrence.seeking && !state.seeking;
  advanceListenOccurrence(remoteListenOccurrence, now, progressing);
}

function tickListenStats() {
  const now = performance.now();
  for (const player of players) {
    tickPlayerListen(player, now);
  }
  tickRemoteListen(now);
  if (allListenOccurrences().some(listenOccurrenceHasUnsent)) {
    scheduleListenStatsPost();
  }
}

function beginPlayerListen(player, track) {
  if (!player || !track?.id) {
    return;
  }
  finalizePlayerListen(player);
  player.listenOccurrence = createListenOccurrence(track.id, track.duration || 0);
  ensureListenStatsTick();
}

function finalizePlayerListen(player) {
  if (!player) {
    return;
  }
  const occ = player.listenOccurrence;
  if (!occ || occ.finalized) {
    player.listenOccurrence = null;
    return;
  }
  advanceListenOccurrence(occ, performance.now(), false);
  occ.finalized = true;
  occ.checkpointMs = 0;
  player.listenOccurrence = null;
  if (listenOccurrenceHasUnsent(occ)) {
    pendingFinalizedListen.push(occ);
  }
  postListenStatsUpdates();
}

function beginRemoteListen(track) {
  finalizeRemoteListen();
  if (!track?.id) {
    return;
  }
  remoteListenOccurrence = createListenOccurrence(track.id, track.duration || state.remoteDuration || 0);
  ensureListenStatsTick();
}

function finalizeRemoteListen() {
  const occ = remoteListenOccurrence;
  if (!occ || occ.finalized) {
    remoteListenOccurrence = null;
    return;
  }
  advanceListenOccurrence(occ, performance.now(), false);
  occ.finalized = true;
  occ.checkpointMs = 0;
  remoteListenOccurrence = null;
  if (listenOccurrenceHasUnsent(occ)) {
    pendingFinalizedListen.push(occ);
  }
  postListenStatsUpdates();
}

function setListenSeeking(seeking) {
  const now = performance.now();
  for (const player of players) {
    const occ = player.listenOccurrence;
    if (!occ || occ.finalized) {
      continue;
    }
    if (seeking) {
      advanceListenOccurrence(occ, now, false);
      occ.seeking = true;
    } else {
      occ.seeking = false;
      occ.checkpointMs = playerListenProgressing(player, occ) ? now : 0;
    }
  }
  if (remoteListenOccurrence && !remoteListenOccurrence.finalized) {
    if (seeking) {
      advanceListenOccurrence(remoteListenOccurrence, now, false);
      remoteListenOccurrence.seeking = true;
    } else {
      remoteListenOccurrence.seeking = false;
      remoteListenOccurrence.checkpointMs = state.playing ? now : 0;
    }
  }
}

function setPlayerListenStalled(player, stalled) {
  const occ = player?.listenOccurrence;
  if (!occ || occ.finalized) {
    return;
  }
  const now = performance.now();
  if (stalled) {
    advanceListenOccurrence(occ, now, false);
    occ.stalled = true;
  } else {
    occ.stalled = false;
    occ.checkpointMs = playerListenProgressing(player, occ) ? now : 0;
  }
}

function teardownListenStatsForUnload() {
  const now = performance.now();
  for (const player of players) {
    const occ = player.listenOccurrence;
    if (occ && !occ.finalized) {
      advanceListenOccurrence(occ, now, false);
      occ.finalized = true;
      occ.checkpointMs = 0;
      if (listenOccurrenceHasUnsent(occ)) {
        pendingFinalizedListen.push(occ);
      }
    }
    player.listenOccurrence = null;
  }
  if (remoteListenOccurrence && !remoteListenOccurrence.finalized) {
    advanceListenOccurrence(remoteListenOccurrence, now, false);
    remoteListenOccurrence.finalized = true;
    remoteListenOccurrence.checkpointMs = 0;
    if (listenOccurrenceHasUnsent(remoteListenOccurrence)) {
      pendingFinalizedListen.push(remoteListenOccurrence);
    }
  }
  remoteListenOccurrence = null;
  stopListenStatsTick();
  postListenStatsUpdates();
}

function flushListenStatsForClose() {
  tickListenStats();
  for (const player of players) {
    finalizePlayerListen(player);
  }
  finalizeRemoteListen();
  writeSession();
  if (listenPostTimer) {
    window.clearTimeout(listenPostTimer);
    listenPostTimer = 0;
  }
  return takeListenStatsUpdatesForClose();
}

window.empFlushForClose = flushListenStatsForClose;
let pendingHandoff = null;
let remoteClock = 0;
let remoteAdvanceAt = 0;
let deviceDrawerCloseTimer = 0;
let queueDrawerCloseTimer = 0;
let queueDrawerSignature = "";
let renderSeq = 0;
let focusSearchOnRender = true;
let searchHistoryIdleTimer = 0;
let searchExpand = {
  queryKey: "",
  artists: SEARCH_ARTIST_LIMIT,
  playlists: SEARCH_PLAYLIST_LIMIT,
  albums: SEARCH_ALBUM_LIMIT,
  tracks: SEARCH_TRACK_LIMIT
};
let lyricsTrackId = null;
const lyricsEntries = new Map();
let lyricsRequestTimer = 0;
let lyricsRequestKey = "";
let lyricsLines = [];
let lyricsActiveIndex = -1;
let lyricsUserScrollUntil = 0;
let deviceScanTimer = 0;
let deviceScanUntil = 0;

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalizeRepeat(value) {
  if (value === true || value === "one") {
    return "one";
  }
  if (value === "all") {
    return "all";
  }
  return "off";
}

function normalizeSort(value) {
  if (value === "title") {
    return "title";
  }
  return "recent";
}

function normalizeSidebarSort(value) {
  return value === "title" ? "title" : "recent";
}

function normalizeLayout(value) {
  return value === "list" ? "list" : "grid";
}

function normalizeSidebarWidth(value) {
  const width = Math.round(Number(value) || 300);
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width));
}

function normalizeStartupOnLogin(value) {
  if (value === "yes" || value === "minimized") {
    return value;
  }
  return "no";
}

function startupOnLoginLabel(value) {
  if (value === "yes") {
    return "Yes";
  }
  if (value === "minimized") {
    return "Minimized";
  }
  return "No";
}

function normalizeRecentsFilter(value) {
  if (value === "tracks" || value === "playlists") {
    return value;
  }
  return "albums";
}

function normalizeQueueSource(value) {
  if (!value || !QUEUE_SOURCE_KINDS.includes(value.kind)) {
    return null;
  }
  return typeof value.id === "string" ? { kind: value.kind, id: value.id } : { kind: value.kind };
}

function normalizeRecentHome(value, albumIds, playlistIds) {
  if (Array.isArray(value) && value.length) {
    return value
      .filter((item) => item && (item.kind === "album" || item.kind === "playlist") && typeof item.id === "string")
      .slice(0, MAX_RECENTS);
  }

  const albums = Array.isArray(albumIds) ? albumIds.filter((id) => typeof id === "string") : [];
  const playlists = Array.isArray(playlistIds)
    ? playlistIds.filter((id) => typeof id === "string" && id !== LIKED_PLAYLIST_ID)
    : [];
  const merged = [];
  const max = Math.max(albums.length, playlists.length);
  for (let i = 0; i < max && merged.length < MAX_RECENTS; i += 1) {
    if (albums[i]) {
      merged.push({ kind: "album", id: albums[i] });
    }
    if (playlists[i] && merged.length < MAX_RECENTS) {
      merged.push({ kind: "playlist", id: playlists[i] });
    }
  }
  return merged;
}

function normalizePlaylists(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const smartApi = window.EmpSmartPlaylists;
  return value
    .filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
    .map((item) => {
      if (item.id === LIKED_PLAYLIST_ID || item.kind === "liked") {
        return {
          id: LIKED_PLAYLIST_ID,
          name: LIKED_PLAYLIST_NAME,
          kind: "liked",
          trackIds: Array.isArray(item.trackIds) ? item.trackIds.filter((id) => typeof id === "string") : [],
          description: typeof item.description === "string" ? item.description : "",
          createdAt: Number(item.createdAt) || 0
        };
      }

      if (item.kind === "smart") {
        const smart = smartApi
          ? smartApi.normalizeSmartDefinition(item.smart || {})
          : (item.smart && typeof item.smart === "object" ? item.smart : null);
        return {
          id: item.id,
          name: item.name,
          kind: "smart",
          trackIds: [],
          description: typeof item.description === "string" ? item.description : "",
          createdAt: Number(item.createdAt) || 0,
          updatedAt: Number(item.updatedAt) || Number(item.createdAt) || 0,
          schemaVersion: Number(item.schemaVersion) || 1,
          smart
        };
      }

      return {
        id: item.id,
        name: item.name,
        kind: undefined,
        trackIds: Array.isArray(item.trackIds) ? item.trackIds.filter((id) => typeof id === "string") : [],
        description: typeof item.description === "string" ? item.description : "",
        createdAt: Number(item.createdAt) || 0
      };
    });
}

function isLikedPlaylist(playlist) {
  return playlist?.kind === "liked" || playlist?.id === LIKED_PLAYLIST_ID;
}

function isSmartPlaylist(playlist) {
  return playlist?.kind === "smart";
}

/** Ephemeral match cache — never persisted to emp.playback. */
const smartMatchCache = new Map();
let smartReevalTimer = null;
let smartEvalDayKey = "";

function albumsByIdMap() {
  const map = {};
  for (const album of [...(state.library.albums || []), ...(state.library.singles || [])]) {
    map[album.id] = album;
  }
  return map;
}

function smartEvalContext() {
  return {
    tracks: state.library.tracks || [],
    albumsById: albumsByIdMap(),
    listenStats: state.listenStats || {},
    likedIds: state.liked instanceof Set ? state.liked : new Set(),
    now: Date.now()
  };
}

function smartContextFingerprint(deps) {
  const parts = [];
  if (!deps || deps.metadata) {
    parts.push(state.library?.contentFingerprint || state.library?.tracks?.length || 0);
  }
  if (!deps || deps.stats) {
    parts.push(`stats:${Object.keys(state.listenStats || {}).length}`);
  }
  if (!deps || deps.liked) {
    parts.push(`liked:${state.liked?.size || 0}`);
  }
  if (!deps || deps.dateRelative) {
    const d = new Date();
    parts.push(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
  }
  return parts.join("|");
}

function evaluateSmartPlaylistTracks(playlist, { bypassCache = false } = {}) {
  if (!isSmartPlaylist(playlist) || !playlist.smart || !window.EmpSmartPlaylists) {
    return [];
  }
  if (playlist.smart.loadError) {
    return [];
  }
  const deps = window.EmpSmartPlaylists.definitionDependencies(playlist.smart);
  const fingerprint = `${playlist.id}|${playlist.updatedAt || 0}|${smartContextFingerprint(deps)}|${JSON.stringify(playlist.smart.sort)}|${playlist.smart.limit}|${playlist.smart.randomSeed}`;
  if (!bypassCache) {
    const cached = smartMatchCache.get(playlist.id);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.trackIds.map(trackById).filter(Boolean);
    }
  }
  const result = window.EmpSmartPlaylists.evaluateSmartPlaylist(playlist.smart, smartEvalContext());
  smartMatchCache.set(playlist.id, { fingerprint, trackIds: result.trackIds });
  return result.trackIds.map(trackById).filter(Boolean);
}

function invalidateSmartMatches(filterDeps) {
  if (!filterDeps) {
    smartMatchCache.clear();
    return;
  }
  for (const playlist of state.playlists) {
    if (!isSmartPlaylist(playlist) || !playlist.smart || !window.EmpSmartPlaylists) {
      continue;
    }
    const deps = window.EmpSmartPlaylists.definitionDependencies(playlist.smart);
    if ((filterDeps.metadata && deps.metadata)
      || (filterDeps.stats && deps.stats)
      || (filterDeps.liked && deps.liked)
      || (filterDeps.dateRelative && deps.dateRelative)) {
      smartMatchCache.delete(playlist.id);
    }
  }
}

function scheduleSmartReevaluation(filterDeps) {
  invalidateSmartMatches(filterDeps);
  clearTimeout(smartReevalTimer);
  smartReevalTimer = setTimeout(() => {
    // Reevaluation must not write emp.playback — membership is derived.
    if (state.view === "playlist" && isSmartPlaylist(playlistById(state.playlistId))) {
      renderPlaylist(state.playlistId);
    }
    if (state.recentsFilter === "playlists" || state.view === "playlists" || state.view === "search") {
      renderLibraryList();
      if (state.view === "playlists" || state.view === "search") {
        render(historyStack[historyIndex]);
      }
    }
  }, 300);
}

function localDayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function ensureSmartDateRelativeFreshness() {
  const key = localDayKey();
  if (key === smartEvalDayKey) {
    return;
  }
  smartEvalDayKey = key;
  scheduleSmartReevaluation({ dateRelative: true, metadata: true, stats: true, liked: true });
}

function likedPlaylist() {
  return state.playlists.find((playlist) => isLikedPlaylist(playlist)) ?? null;
}

function likedPlaylistWithSongs() {
  const playlist = likedPlaylist();
  if (!playlist || !playlistTracks(playlist).length) {
    return null;
  }
  return playlist;
}

function syncLikedFromPlaylist() {
  const playlist = likedPlaylist();
  state.liked = new Set(playlist?.trackIds ?? []);
}

function isStorageQuotaError(error) {
  return error instanceof DOMException
    && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22);
}

function queueMatchesFullLibrary(ids = state.queue) {
  const libraryIds = state.library.tracks.map((track) => track.id);
  if (!ids?.length || ids.length !== libraryIds.length) {
    return false;
  }
  const wanted = new Set(libraryIds);
  return ids.every((id) => wanted.has(id));
}

function canCompactSessionQueue() {
  const kind = state.queueSource?.kind;
  return (kind === "library" || kind === "songs") && queueMatchesFullLibrary();
}

function buildSessionPayload({ compactQueue = false } = {}) {
  const track = currentTrack();
  const compact = compactQueue && canCompactSessionQueue();
  return {
    trackId: track?.id ?? null,
    queue: compact ? [] : state.queue,
    queueSource: state.queueSource,
    queueCompact: compact ? true : undefined,
    shuffleBag: compact ? [] : state.shuffleBag,
    index: state.index,
    position: Number.isFinite(playbackPosition()) ? playbackPosition() : 0,
    volume: state.volume,
    lastVolume: state.lastVolume,
    muted: state.muted,
    shuffle: state.shuffle,
    repeat: state.repeat,
    librarySort: state.librarySort,
    libraryLayout: state.libraryLayout,
    sidebarSort: state.sidebarSort,
    sidebarWidth: state.sidebarWidth,
    sidebarCollapsed: state.sidebarCollapsed,
    recentAlbumIds: state.recentAlbumIds,
    recentTrackIds: state.recentTrackIds,
    recentPlaylistIds: state.recentPlaylistIds,
    recentHome: state.recentHome,
    recentsFilter: state.recentsFilter,
    playlists: state.playlists,
    personalizedMixes: state.personalizedMixes !== false,
    crossfade: state.crossfade,
    gapless: state.gapless,
    crossfadeSeconds: state.crossfadeSeconds,
    normalizeVolume: state.normalizeVolume,
    normalizeMode: state.normalizeMode,
    preventClipping: state.preventClipping !== false,
    audioOutputId: typeof state.audioOutputId === "string" ? state.audioOutputId : "",
    audioOutputLabel: typeof state.audioOutputLabel === "string" ? state.audioOutputLabel : "",
    equalizerEnabled: state.equalizerEnabled,
    equalizerPreset: state.equalizerPreset,
    equalizerGains: cloneEqGains(state.equalizerGains),
    startupOnLogin: state.startupOnLogin,
    closeMinimizes: state.closeMinimizes,
    automaticUpdateChecks: state.automaticUpdateChecks !== false
  };
}

function persistSessionPayload(payload) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  lastSessionWrite = Date.now();
  sessionSaveFailed = false;
}

function writeSession() {
  try {
    persistSessionPayload(buildSessionPayload());
  } catch (error) {
    if (isStorageQuotaError(error) && canCompactSessionQueue()) {
      try {
        persistSessionPayload(buildSessionPayload({ compactQueue: true }));
        return;
      } catch (compactError) {
        sessionSaveFailed = true;
        console.error("EMP session save failed after compacting full-library queue.", compactError);
        return;
      }
    }
    sessionSaveFailed = true;
    console.error("EMP session save failed.", error);
  }
}

function writeSessionThrottled() {
  if (Date.now() - lastSessionWrite < 2000) {
    return;
  }

  writeSession();
}

window.empSaveSession = writeSession;

function restoreEqualizerState(session) {
  try {
    const gains = sanitizeEqGains(session?.equalizerGains);
    state.equalizerEnabled = session?.equalizerEnabled === true;
    state.equalizerGains = gains;
    state.equalizerPreset = resolveEqPresetId(session?.equalizerPreset, gains);
  } catch {
    state.equalizerEnabled = false;
    state.equalizerGains = cloneEqGains(EQ_FLAT_GAINS);
    state.equalizerPreset = "flat";
  }
}

(function applySavedPreferences() {
  const session = readSession();
  if (!session) {
    return;
  }

  if (typeof session.volume === "number") {
    state.volume = Math.max(0, Math.min(100, session.volume));
  }
  if (typeof session.lastVolume === "number") {
    state.lastVolume = Math.max(0, Math.min(100, session.lastVolume));
  }
  state.muted = Boolean(session.muted);
  state.shuffle = Boolean(session.shuffle);
  state.repeat = normalizeRepeat(session.repeat);
  state.librarySort = normalizeSort(session.librarySort);
  state.libraryLayout = normalizeLayout(session.libraryLayout);
  state.sidebarSort = normalizeSidebarSort(session.sidebarSort);
  state.sidebarWidth = normalizeSidebarWidth(session.sidebarWidth);
  state.sidebarCollapsed = Boolean(session.sidebarCollapsed);
  state.playlists = normalizePlaylists(session.playlists);
  invalidateSearchIndex();
  if (Array.isArray(session.recentAlbumIds)) {
    state.recentAlbumIds = session.recentAlbumIds.filter((id) => typeof id === "string");
  }
  if (Array.isArray(session.recentTrackIds)) {
    state.recentTrackIds = session.recentTrackIds.filter((id) => typeof id === "string");
  }
  if (Array.isArray(session.recentPlaylistIds)) {
    state.recentPlaylistIds = session.recentPlaylistIds.filter((id) => typeof id === "string");
  }
  state.recentHome = normalizeRecentHome(session.recentHome, state.recentAlbumIds, state.recentPlaylistIds);
  state.recentsFilter = normalizeRecentsFilter(session.recentsFilter);
  // Restore before any Home/mix generation so disabled installs never flash Your Mixes.
  state.personalizedMixes = session.personalizedMixes !== false;
  state.crossfade = Boolean(session.crossfade);
  state.gapless = Boolean(session.gapless);
  if (state.crossfade && state.gapless) {
    state.gapless = false;
  }
  state.crossfadeSeconds = clampCrossfadeSeconds(session.crossfadeSeconds);
  state.normalizeVolume = Boolean(session.normalizeVolume);
  state.normalizeMode = ReplayGain?.normalizeMode?.(session.normalizeMode) || "track";
  state.preventClipping = session.preventClipping !== false;
  state.audioOutputId = typeof session.audioOutputId === "string" ? session.audioOutputId : "";
  state.audioOutputLabel = typeof session.audioOutputLabel === "string" ? session.audioOutputLabel : "";
  state.startupOnLogin = normalizeStartupOnLogin(session.startupOnLogin);
  state.closeMinimizes = Boolean(session.closeMinimizes);
  if (typeof session.automaticUpdateChecks === "boolean") {
    state.automaticUpdateChecks = session.automaticUpdateChecks;
  }
  try {
    restoreEqualizerState(session);
  } catch {
    state.equalizerEnabled = false;
    state.equalizerGains = cloneEqGains(EQ_FLAT_GAINS);
    state.equalizerPreset = "flat";
  }
  syncLikedFromPlaylist();
  volumeBar.value = state.muted ? "0" : String(state.volume);
  applyVolume();
  syncRecentsChips();
})();

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 18) {
    return "Good afternoon";
  }
  return "Good evening";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base" });
}

function artistsMatch(left, right) {
  return compareText(left, right) === 0;
}

function allAlbums() {
  return [...state.library.albums, ...state.library.singles];
}

function albumById(id) {
  return allAlbums().find((album) => album.id === id);
}

function trackById(id) {
  return state.library.tracks.find((track) => track.id === id) || state.heldTracks.get(id) || null;
}

function musicFolders() {
  return Array.isArray(state.library.folders) ? state.library.folders : [];
}

function playerMediaHost(player) {
  const src = player?.el?.currentSrc || player?.el?.src;
  if (!src) {
    return "";
  }

  try {
    return new URL(src, window.location.href).hostname || "";
  } catch {
    return "";
  }
}

function activeMediaHosts() {
  return [...new Set([
    playerMediaHost(currentPlayer()),
    playerMediaHost(incomingPlayer())
  ].filter(Boolean))];
}

function captureActiveTracks() {
  const keepIds = new Set([
    currentPlayer().trackId,
    incomingPlayer().trackId,
    state.queue[state.index]
  ].filter(Boolean));
  const kept = [];
  for (const id of keepIds) {
    const track = trackById(id);
    if (track) {
      kept.push(track);
    }
  }
  return kept;
}

function retainActiveTracks(previousTracks) {
  const kept = new Map();
  for (const track of previousTracks) {
    if (!state.library.tracks.some((item) => item.id === track.id)) {
      kept.set(track.id, track);
    }
  }
  state.heldTracks = kept;
}

function playlistById(id) {
  return state.playlists.find((playlist) => playlist.id === id) ?? null;
}

function playlistTracks(playlist) {
  if (isSmartPlaylist(playlist)) {
    return evaluateSmartPlaylistTracks(playlist);
  }
  return (playlist?.trackIds ?? []).map(trackById).filter(Boolean);
}

function playlistCoverItem(playlist) {
  if (isLikedPlaylist(playlist)) {
    return { kind: "liked", title: playlist.name, color: "#450af5" };
  }

  const tracks = playlistTracks(playlist);
  const withCover = tracks.find((track) => track.coverUrl);
  if (withCover) {
    return withCover;
  }

  const first = tracks[0];
  if (first) {
    const album = albumById(first.albumId);
    return album || first;
  }

  return { title: playlist?.name, color: "#282828" };
}

function newPlaylistId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `pl_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function defaultPlaylistName() {
  const used = new Set();
  for (const playlist of state.playlists) {
    const match = /^My Playlist #(\d+)$/i.exec(playlist.name);
    if (match) {
      used.add(Number(match[1]));
    }
  }

  let number = 1;
  while (used.has(number)) {
    number += 1;
  }
  return `My Playlist #${number}`;
}

function albumsByArtist(name) {
  return allAlbums().filter((album) => artistsMatch(album.artist, name));
}

function tracksByArtist(name) {
  return state.library.tracks.filter((track) => artistsMatch(track.artist, name));
}

function activeOrder() {
  return state.shuffle && state.shuffleBag.length ? state.shuffleBag : state.queue;
}

function currentTrack() {
  return trackById(activeOrder()[state.index]) ?? null;
}

function isRemotePlayback() {
  return Boolean(state.playbackTarget && state.playbackTarget !== "local");
}

function isConnectingPlayback() {
  return Boolean(state.connectingDeviceId);
}

function playbackPosition() {
  if (isRemotePlayback()) {
    const base = Number(state.remotePosition) || 0;
    if (!state.playing || state.seeking) {
      return base;
    }
    return Math.max(0, base + (performance.now() - (state.remoteStatusAt || performance.now())) / 1000);
  }
  return currentAudio().currentTime || 0;
}

function playbackDuration() {
  const local = currentTrack()?.duration || 0;
  if (isRemotePlayback()) {
    return preferRemoteDuration(state.remoteDuration, local);
  }
  return currentAudio().duration || local;
}

function preferRemoteDuration(remoteValue, localValue) {
  const remote = Number(remoteValue) || 0;
  const local = Number(localValue) || 0;
  if (local > 1 && (remote <= 0 || !isPlausibleRemoteDuration(remote, local))) {
    return local;
  }
  return remote || local;
}

function isPlausibleRemoteDuration(remote, local) {
  if (remote <= 0) {
    return false;
  }
  if (local <= 1) {
    return remote > 1;
  }
  const floor = Math.max(30, local * 0.5);
  if (remote + 0.5 < Math.min(local, floor) && remote + 2 < local) {
    return false;
  }
  return remote <= local * 1.5 + 5;
}

function consumeRemoteAdvance() {
  const now = Date.now();
  if (now - remoteAdvanceAt < 1500) {
    return false;
  }
  remoteAdvanceAt = now;
  return true;
}

function nextCastTrackId() {
  return peekNextId({ wrap: state.repeat === "all" });
}

function stopLocalOutput() {
  cancelTransition();
  currentAudio().pause();
  incomingPlayer().el.pause();
  finalizePlayerListen(currentPlayer());
  finalizePlayerListen(incomingPlayer());
}

function postCastDiscovery(enabled) {
  window.chrome?.webview?.postMessage({ type: "castDiscovery", enabled: Boolean(enabled) });
}

function postCastSelect(deviceId) {
  window.chrome?.webview?.postMessage({
    type: "castSelect",
    deviceId,
    trackId: currentTrack()?.id ?? null,
    nextTrackId: nextCastTrackId(),
    position: playbackPosition(),
    playing: Boolean(state.playing),
    volume: state.volume,
    muted: state.muted
  });
}

function postCastCommand(action, extra = {}) {
  window.chrome?.webview?.postMessage({
    type: "castCommand",
    action,
    trackId: extra.trackId ?? currentTrack()?.id ?? null,
    nextTrackId: extra.nextTrackId ?? nextCastTrackId(),
    position: extra.position ?? playbackPosition(),
    playing: extra.playing ?? Boolean(state.playing),
    volume: extra.volume ?? state.volume,
    muted: extra.muted ?? state.muted
  });
}

function stopRemoteClock() {
  if (remoteClock) {
    cancelAnimationFrame(remoteClock);
    remoteClock = 0;
  }
}

function startRemoteClock() {
  stopRemoteClock();
  if (!isRemotePlayback()) {
    return;
  }
  const tick = () => {
    if (!isRemotePlayback()) {
      remoteClock = 0;
      return;
    }
    if (!state.seeking) {
      const duration = playbackDuration() || 1;
      const position = Math.min(playbackPosition(), duration);
      elapsedEl.textContent = formatTime(position);
      seekBar.value = String(Math.round((position / duration) * 1000));
      updateSlider(seekBar);
      syncLyricsPosition();
    }
    remoteClock = requestAnimationFrame(tick);
  };
  remoteClock = requestAnimationFrame(tick);
}

function applyVolumeControls() {
  const remoteNoVolume = isRemotePlayback() && !state.castVolumeAvailable;
  volumeBar.disabled = remoteNoVolume;
  muteBtn.disabled = remoteNoVolume;
  volumeBar.title = remoteNoVolume ? "Volume is controlled on the device" : "";
  muteBtn.title = remoteNoVolume ? "Volume is controlled on the device" : "";
}

function updateDeviceButton() {
  if (!deviceBtn) {
    return;
  }
  const connected = isRemotePlayback();
  const connecting = isConnectingPlayback();
  deviceBtn.classList.toggle("active", connected);
  deviceBtn.classList.toggle("is-connecting", connecting && !connected);
  const title = connecting
    ? "Connecting to a device"
    : connected
      ? "Connected to a device"
      : "Connect to a device";
  setTooltipTitle(deviceBtn, title);
}

function deviceDrawerIsOpen() {
  return Boolean(deviceDrawerRoot && !deviceDrawerRoot.hidden);
}

function deviceScanActive() {
  return deviceScanUntil > Date.now();
}

function beginDeviceScan() {
  deviceScanUntil = Date.now() + DEVICE_SCAN_MS;
  window.clearTimeout(deviceScanTimer);
  deviceScanTimer = window.setTimeout(() => {
    deviceScanTimer = 0;
    renderDeviceDrawer();
  }, DEVICE_SCAN_MS + 150);
}

function deviceRowMarkup(options) {
  const classes = ["device-row"];
  if (options.active) {
    classes.push("is-active");
  }
  if (options.offline) {
    classes.push("is-offline");
  }

  let mark = "";
  if (options.connecting) {
    mark = '<span class="device-spinner" aria-hidden="true"></span>';
  } else if (options.active) {
    mark = state.playing ? nowEqMarkup() : '<i class="bi bi-check-lg" aria-hidden="true"></i>';
  }

  const tag = options.tag ? `<span class="device-row-tag">${escapeHtml(options.tag)}</span>` : "";
  const status = options.status ? `<span>${escapeHtml(options.status)}</span>` : "";

  return `
    <button class="${classes.join(" ")}" type="button" data-cast-device="${escapeHtml(options.id)}"
      aria-pressed="${options.active ? "true" : "false"}"${options.offline ? " disabled" : ""}>
      <span class="device-row-icon" aria-hidden="true"><i class="bi ${options.icon}"></i></span>
      <span class="device-row-copy">
        <span class="device-row-name">${escapeHtml(options.name)}</span>
        <span class="device-row-meta">${tag}${status}</span>
      </span>
      <span class="device-row-mark">${mark}</span>
    </button>
  `;
}

function deviceSkeletonMarkup(count) {
  const row = `
    <div class="device-skeleton" aria-hidden="true">
      <span class="device-skeleton-icon"></span>
      <div class="device-skeleton-copy">
        <span class="device-skeleton-name"></span>
        <span class="device-skeleton-meta"></span>
      </div>
    </div>
  `;
  return row.repeat(count);
}

function renderDeviceDrawerChrome(devices, scanning) {
  if (deviceDrawerAlert) {
    // Pinned outside the scrolling list so a connection failure stays visible.
    deviceDrawerAlert.innerHTML = state.castError
      ? `<div class="device-error">
           <i class="bi bi-exclamation-circle-fill" aria-hidden="true"></i>
           <span>${escapeHtml(state.castError)}</span>
         </div>`
      : "";
    deviceDrawerAlert.hidden = !state.castError;
  }

  if (deviceDrawerStatus) {
    let text = "Choose where to play";
    if (isConnectingPlayback()) {
      text = "Connecting…";
    } else if (isRemotePlayback()) {
      const active = devices.find((device) => device.id === state.playbackTarget);
      text = active ? `Playing on ${active.name}` : "Playing on a remote device";
    } else if (scanning && !devices.length) {
      text = "Looking for devices…";
    }
    const dot = scanning && !isRemotePlayback()
      ? '<span class="device-scan-dot" aria-hidden="true"></span>'
      : "";
    deviceDrawerStatus.innerHTML = `${dot}<span>${escapeHtml(text)}</span>`;
  }

  if (deviceDrawerNote) {
    deviceDrawerNote.innerHTML = isRemotePlayback()
      ? '<i class="bi bi-info-circle" aria-hidden="true"></i><span>Equalizer and sound processing stay on this computer.</span>'
      : "";
  }

  if (deviceRescanBtn) {
    // Left enabled so it keeps its place in the tab order; rescanDevices ignores
    // the click while a scan is already running.
    deviceRescanBtn.classList.toggle("is-scanning", scanning);
    deviceRescanBtn.setAttribute("aria-disabled", scanning ? "true" : "false");
  }
}

function renderDeviceDrawer() {
  if (!deviceDrawerBody || !deviceDrawerIsOpen()) {
    return;
  }

  const devices = Array.isArray(state.castDevices) ? state.castDevices : [];
  const scanning = deviceScanActive();
  const localActive = !isRemotePlayback() && !isConnectingPlayback();

  const local = deviceRowMarkup({
    id: "local",
    name: "This computer",
    icon: "bi-pc-display",
    active: localActive,
    status: localActive ? "Playing here" : "Local playback"
  });

  let discovered;
  if (devices.length) {
    const rows = devices.map((device) => {
      const active = state.playbackTarget === device.id;
      const connecting = state.connectingDeviceId === device.id;
      let status = "";
      if (connecting) {
        status = "Connecting…";
      } else if (active) {
        status = "Connected";
      } else if (device.available === false) {
        status = "Unavailable";
      }
      return deviceRowMarkup({
        id: device.id,
        name: device.name || "Device",
        icon: device.kind === "tv" ? "bi-tv" : "bi-speaker",
        tag: device.protocolLabel,
        active,
        connecting,
        offline: device.available === false && !active && !connecting,
        status
      });
    }).join("");
    discovered = `<div class="device-section-label">Available devices</div>${rows}`;
  } else if (scanning) {
    discovered = `<div class="device-section-label">Available devices</div>${deviceSkeletonMarkup(3)}`;
  } else {
    discovered = `
      <div class="device-empty">
        <div class="device-empty-icon" aria-hidden="true"><i class="bi bi-wifi-off"></i></div>
        <h3>No devices found</h3>
        <p>Make sure your speaker or TV is switched on and joined to this network, then try again.</p>
      </div>
    `;
  }

  deviceDrawerBody.innerHTML = `${local}${discovered}`;
  renderDeviceDrawerChrome(devices, scanning);
}

function openDeviceDrawer() {
  if (!deviceDrawerRoot) {
    return;
  }
  closeQueueDrawer();
  window.clearTimeout(deviceDrawerCloseTimer);
  deviceDrawerCloseTimer = 0;
  deviceDrawerRoot.hidden = false;
  requestAnimationFrame(() => deviceDrawerRoot.classList.add("is-open"));
  state.castError = null;
  postCastDiscovery(true);
  beginDeviceScan();
  renderDeviceDrawer();
  const first = deviceDrawerBody?.querySelector(".device-row:not([disabled])");
  first?.focus({ preventScroll: true });
}

function closeDeviceDrawer() {
  if (!deviceDrawerRoot || deviceDrawerRoot.hidden) {
    return;
  }
  window.clearTimeout(deviceScanTimer);
  deviceScanTimer = 0;
  deviceScanUntil = 0;
  deviceDrawerRoot.classList.remove("is-open");
  window.clearTimeout(deviceDrawerCloseTimer);
  deviceDrawerCloseTimer = window.setTimeout(() => {
    deviceDrawerCloseTimer = 0;
    deviceDrawerRoot.hidden = true;
  }, DEVICE_DRAWER_EXIT_MS);
  if (!isRemotePlayback() && !isConnectingPlayback()) {
    postCastDiscovery(false);
  }
  if (deviceDrawerRoot.contains(document.activeElement)) {
    deviceBtn?.focus({ preventScroll: true });
  }
}

function trapDrawerFocus(root, event) {
  if (event.key !== "Tab") {
    return;
  }
  const focusable = [...root.querySelectorAll("button:not([disabled])")];
  if (!focusable.length) {
    return;
  }
  const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
  if (document.activeElement === edge) {
    event.preventDefault();
    (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
  }
}

function queueSourceLabel(source) {
  switch (source?.kind) {
    case "album":
      return albumById(source.id)?.title ?? "";
    case "playlist":
    case "smart":
      return playlistById(source.id)?.name ?? "";
    case "artist":
      return source.id ?? "";
    case "recents":
      return "Recently played";
    case "library":
      return "All tracks";
    case "mix":
      return mixById(source.id)?.title ?? "";
    default:
      return "";
  }
}

function upcomingQueueIds() {
  if (!currentTrack()) {
    return [];
  }
  const order = activeOrder();
  const after = order.slice(state.index + 1);
  return state.repeat === "all" ? [...after, ...order.slice(0, state.index)] : after;
}

function queueRowMarkup(track, current = false) {
  const mark = current && state.playing ? nowEqMarkup() : "";
  return `
    <button class="device-row queue-row${current ? " is-current" : ""}" type="button"
      data-queue-track="${escapeHtml(track.id)}"${current ? " data-queue-current" : ""}>
      ${coverMarkup(track, "queue-row-cover")}
      <span class="device-row-copy">
        <span class="device-row-name">${escapeHtml(track.title)}</span>
        <span class="device-row-meta"><span>${escapeHtml(track.artist)}</span></span>
      </span>
      <span class="device-row-mark">${mark}</span>
    </button>
  `;
}

function queueDrawerIsOpen() {
  return Boolean(queueDrawerRoot && !queueDrawerRoot.hidden);
}

function renderQueueDrawer() {
  if (!queueDrawerBody || !queueDrawerIsOpen()) {
    return;
  }

  const track = currentTrack();
  const upcoming = upcomingQueueIds().map(trackById).filter(Boolean);
  const shown = upcoming.slice(0, QUEUE_DRAWER_LIMIT);
  const source = queueSourceLabel(state.queueSource);
  // updateNowPlaying runs on every remote status poll, so skip redraws that
  // would change nothing and reset hover and focus.
  const signature = JSON.stringify([
    track?.id ?? null,
    state.playing,
    state.shuffle,
    source,
    upcoming.length,
    shown.map((item) => item.id)
  ]);
  if (signature === queueDrawerSignature) {
    return;
  }
  queueDrawerSignature = signature;

  if (queueDrawerStatus) {
    let text = "Nothing playing";
    if (track) {
      text = upcoming.length ? `${songLabel(upcoming.length)} up next` : "Nothing up next";
      if (state.shuffle) {
        text += " · Shuffle on";
      }
    }
    queueDrawerStatus.innerHTML = `<span>${escapeHtml(text)}</span>`;
  }

  if (!track) {
    queueDrawerBody.innerHTML = `
      <div class="device-empty">
        <div class="device-empty-icon" aria-hidden="true"><i class="bi bi-music-note-list"></i></div>
        <h3>Your queue is empty</h3>
        <p>Play an album, playlist, or song to see what's coming up next.</p>
      </div>
    `;
    return;
  }

  const active = document.activeElement;
  const hadFocus = queueDrawerBody.contains(active);
  const focusedId = hadFocus && !active.hasAttribute("data-queue-current") ? active.dataset.queueTrack : "";

  const heading = source ? `Next from: ${source}` : "Next up";
  const rows = shown.length
    ? shown.map((item) => queueRowMarkup(item)).join("")
    : `<p class="queue-empty-note">You've reached the end of the queue.</p>`;
  const hidden = upcoming.length - shown.length;
  const more = hidden > 0 ? `<p class="queue-more">And ${songLabel(hidden)} more</p>` : "";

  queueDrawerBody.innerHTML = `
    <div class="queue-section-label">Now playing</div>
    ${queueRowMarkup(track, true)}
    <div class="queue-section-label">${escapeHtml(heading)}</div>
    ${rows}
    ${more}
  `;
  syncCoverImages(queueDrawerBody);

  if (hadFocus) {
    const target = (focusedId && queueDrawerBody.querySelector(`[data-queue-track="${CSS.escape(focusedId)}"]:not([data-queue-current])`))
      || queueDrawerBody.querySelector("[data-queue-current]");
    target?.focus({ preventScroll: true });
  }
}

function openQueueDrawer() {
  if (!queueDrawerRoot) {
    return;
  }
  closeDeviceDrawer();
  window.clearTimeout(queueDrawerCloseTimer);
  queueDrawerCloseTimer = 0;
  queueDrawerRoot.hidden = false;
  queueBtn?.classList.add("active");
  queueBtn?.setAttribute("aria-expanded", "true");
  queueDrawerSignature = "";
  renderQueueDrawer();
  queueDrawerBody.scrollTop = 0;
  requestAnimationFrame(() => {
    if (queueDrawerCloseTimer) {
      return;
    }
    queueDrawerRoot.classList.add("is-open");
    // The root is visibility: hidden until is-open applies, which blocks focus.
    requestAnimationFrame(() => {
      if (queueDrawerCloseTimer) {
        return;
      }
      const first = queueDrawerBody.querySelector("[data-queue-current]")
        ?? queueDrawerRoot.querySelector("button:not([disabled])");
      first?.focus({ preventScroll: true });
    });
  });
}

function closeQueueDrawer() {
  if (!queueDrawerRoot || queueDrawerRoot.hidden) {
    return;
  }
  queueDrawerRoot.classList.remove("is-open");
  queueBtn?.classList.remove("active");
  queueBtn?.setAttribute("aria-expanded", "false");
  window.clearTimeout(queueDrawerCloseTimer);
  queueDrawerCloseTimer = window.setTimeout(() => {
    queueDrawerCloseTimer = 0;
    queueDrawerRoot.hidden = true;
  }, DEVICE_DRAWER_EXIT_MS);
  if (queueDrawerRoot.contains(document.activeElement)) {
    queueBtn?.focus({ preventScroll: true });
  }
}

function playQueuedTrack(trackId, isCurrent) {
  if (isCurrent) {
    togglePlay();
    return;
  }
  if (trackById(trackId)) {
    playTrack(trackId, null, { keepBag: true });
  }
}

function rescanDevices() {
  if (deviceScanActive()) {
    return;
  }
  state.castError = null;
  // Cycling discovery restarts the SSDP and Cast searches straight away instead
  // of waiting out the current polling interval.
  postCastDiscovery(false);
  postCastDiscovery(true);
  beginDeviceScan();
  renderDeviceDrawer();
}

function selectPlaybackDevice(deviceId) {
  if (deviceId === "local") {
    const position = playbackPosition();
    const playing = state.playing;
    pendingHandoff = null;
    state.connectingDeviceId = null;
    state.playbackTarget = "local";
    state.castVolumeAvailable = false;
    stopRemoteClock();
    postCastSelect("local");
    const track = currentTrack();
    if (track) {
      playTrack(track.id, null, { position, autoplay: playing, keepBag: true, recordRecent: false });
    }
    updateDeviceButton();
    applyVolumeControls();
    renderDeviceDrawer();
    updateNowPlaying();
    return;
  }

  if (state.playbackTarget === deviceId || state.connectingDeviceId === deviceId) {
    return;
  }

  pendingHandoff = {
    position: playbackPosition(),
    playing: Boolean(state.playing)
  };
  state.connectingDeviceId = deviceId;
  state.castError = null;
  stopLocalOutput();
  postCastSelect(deviceId);
  updateDeviceButton();
  renderDeviceDrawer();
  updateNowPlaying();
}

function restoreLocalAfterCastFailure(message) {
  const position = pendingHandoff?.position ?? state.remotePosition ?? 0;
  const playing = pendingHandoff?.playing ?? false;
  pendingHandoff = null;
  state.connectingDeviceId = null;
  const wasRemote = isRemotePlayback();
  state.playbackTarget = "local";
  state.castVolumeAvailable = false;
  state.castError = message || state.castError;
  stopRemoteClock();
  if (wasRemote || playing || currentTrack()) {
    const track = currentTrack();
    if (track) {
      playTrack(track.id, null, { position, autoplay: playing, keepBag: true, recordRecent: false });
    }
  }
  if (!deviceDrawerIsOpen()) {
    postCastDiscovery(false);
  }
  updateDeviceButton();
  applyVolumeControls();
  renderDeviceDrawer();
  updateNowPlaying();
}

function handleCastMessage(detail) {
  if (!detail || !detail.type) {
    return;
  }

  if (detail.type === "castDevices") {
    state.castDevices = Array.isArray(detail.devices) ? detail.devices : [];
    renderDeviceDrawer();
    return;
  }

  if (detail.type === "castError") {
    if (detail.fatal) {
      restoreLocalAfterCastFailure(detail.message || "Couldn't connect to that device.");
    } else {
      state.castError = detail.message || null;
      renderDeviceDrawer();
    }
    return;
  }

  if (detail.type !== "castStatus") {
    return;
  }

  if (detail.state === "connecting") {
    state.connectingDeviceId = detail.deviceId || state.connectingDeviceId;
    updateDeviceButton();
    renderDeviceDrawer();
    return;
  }

  if (detail.state === "local") {
    finalizeRemoteListen();
    if (isRemotePlayback() || isConnectingPlayback()) {
      restoreLocalAfterCastFailure(state.castError);
    }
    return;
  }

  if (detail.state !== "connected") {
    return;
  }

  pendingHandoff = null;
  state.connectingDeviceId = null;
  state.playbackTarget = detail.deviceId || state.playbackTarget;
  state.remotePosition = Math.max(0, Number(detail.position) || 0);
  if (detail.skip === "applied" && detail.trackId) {
    advanceQueueTo(detail.trackId);
  }
  state.remoteDuration = preferRemoteDuration(detail.duration, currentTrack()?.duration);
  state.remoteStatusAt = performance.now();
  state.playing = Boolean(detail.playing);
  {
    const remoteTrack = currentTrack();
    if (remoteTrack
      && (!remoteListenOccurrence
        || remoteListenOccurrence.finalized
        || remoteListenOccurrence.trackId !== remoteTrack.id)) {
      beginRemoteListen(remoteTrack);
    }
  }
  state.castVolumeAvailable = Boolean(detail.volumeAvailable);
  if (detail.volumeAvailable && typeof detail.volume === "number") {
    state.volume = Math.max(0, Math.min(100, detail.volume));
    state.muted = state.volume === 0;
    volumeBar.value = String(state.muted ? 0 : state.volume);
  }
  if (detail.skip === "applied") {
    if (consumeRemoteAdvance()) {
      postCastCommand("sync");
    }
    startRemoteClock();
    applyVolumeControls();
    updateDeviceButton();
    renderDeviceDrawer();
    updateNowPlaying();
    writeSession();
    return;
  }
  if (detail.skip === "next" || detail.skip === "previous") {
    if (!consumeRemoteAdvance()) {
      return;
    }
    if (detail.skip === "previous") {
      previousTrack();
    } else {
      nextTrack({ wrap: state.repeat === "all" });
    }
    return;
  }
  if (detail.ended) {
    if (!consumeRemoteAdvance()) {
      return;
    }
    nextTrack({ wrap: state.repeat === "all" });
    return;
  }
  startRemoteClock();
  applyVolumeControls();
  updateDeviceButton();
  renderDeviceDrawer();
  updateNowPlaying();
}

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function queueStartId(ids, startId) {
  return startId && ids.includes(startId) ? startId : ids[0];
}

function randomQueueId(ids) {
  return ids[Math.floor(Math.random() * ids.length)];
}

function rebuildShuffleBag(currentId) {
  const rest = state.queue.filter((id) => id !== currentId);
  shuffleInPlace(rest);
  state.shuffleBag = currentId ? [currentId, ...rest] : [...rest];
  state.index = currentId && state.shuffleBag[0] === currentId ? 0 : Math.max(0, state.shuffleBag.indexOf(currentId));
}

function setShuffle(enabled) {
  const currentId = currentTrack()?.id;
  state.shuffle = enabled;
  if (enabled) {
    rebuildShuffleBag(currentId);
  } else {
    state.shuffleBag = [];
    state.index = currentId ? Math.max(0, state.queue.indexOf(currentId)) : state.index;
  }
  invalidateIncomingPreload();
  updateNowPlaying();
  writeSession();
}

function recentAlbums(limit = MAX_RECENTS) {
  return state.recentAlbumIds
    .map((id) => albumById(id))
    .filter(Boolean)
    .slice(0, limit);
}

function recentTracks(limit = MAX_RECENTS) {
  return state.recentTrackIds
    .map((id) => trackById(id))
    .filter(Boolean)
    .slice(0, limit);
}

function recentPlaylists(limit = MAX_RECENTS) {
  return state.recentPlaylistIds
    .map((id) => playlistById(id))
    .filter(Boolean)
    .slice(0, limit);
}

function recentHomeItems(limit = MAX_RECENTS) {
  const items = [];
  for (const entry of state.recentHome) {
    if (items.length >= limit) {
      break;
    }
    if (entry.kind === "album") {
      const album = albumById(entry.id);
      if (album) {
        items.push({ kind: "album", album });
      }
    } else if (entry.kind === "playlist") {
      const playlist = playlistById(entry.id);
      if (playlist && !isLikedPlaylist(playlist)) {
        items.push({ kind: "playlist", playlist });
      }
    }
  }
  return items;
}

function playlistsForMenu(query) {
  const needle = String(query ?? "").trim().toLowerCase();
  const rank = new Map(state.recentPlaylistIds.map((id, index) => [id, index]));
  return state.playlists
    .filter((playlist) => playlist.id !== contextMenuState.playlistId)
    .filter((playlist) => !isSmartPlaylist(playlist))
    .filter((playlist) => !needle || playlist.name.toLowerCase().includes(needle))
    .sort((left, right) => {
      const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return compareText(left.name, right.name);
    });
}

function albumsByRecency(list) {
  const rank = new Map(state.recentAlbumIds.map((id, index) => [id, index]));
  return [...list].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const artist = compareText(left.artist, right.artist);
    if (artist !== 0) {
      return artist;
    }

    return compareText(left.title, right.title);
  });
}

function sortAlbums(list) {
  const items = [...list];
  if (state.librarySort === "title") {
    return items.sort((left, right) => compareText(left.title, right.title) || compareText(left.artist, right.artist));
  }
  return albumsByRecency(items);
}

function sortTracks(list) {
  const items = [...list];
  const rank = new Map(state.recentAlbumIds.map((id, index) => [id, index]));
  if (state.librarySort === "title") {
    return items.sort((left, right) => compareText(left.title, right.title) || compareText(left.artist, right.artist));
  }
  return items.sort((left, right) => {
    const leftRank = rank.get(left.albumId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.albumId) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return (left.trackNumber || 0) - (right.trackNumber || 0);
  });
}

function catalogArtists() {
  const byName = new Map();
  for (const album of allAlbums()) {
    const key = String(album.artist ?? "").toLowerCase();
    let entry = byName.get(key);
    if (!entry) {
      entry = {
        name: album.artist,
        albums: [],
        coverUrl: album.coverUrl,
        color: album.color
      };
      byName.set(key, entry);
    }
    entry.albums.push(album);
    if (!entry.coverUrl && album.coverUrl) {
      entry.coverUrl = album.coverUrl;
    }
  }
  return [...byName.values()];
}

function sortArtists(list) {
  if (state.librarySort === "title") {
    return [...list].sort((left, right) => compareText(left.name, right.name));
  }

  const rank = new Map(state.recentAlbumIds.map((id, index) => [id, index]));
  return [...list].sort((left, right) => {
    const leftRank = Math.min(...left.albums.map((album) => rank.get(album.id) ?? Number.MAX_SAFE_INTEGER));
    const rightRank = Math.min(...right.albums.map((album) => rank.get(album.id) ?? Number.MAX_SAFE_INTEGER));
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return compareText(left.name, right.name);
  });
}

function recordRecentId(key, id) {
  if (!id) {
    return;
  }

  state[key] = [id, ...state[key].filter((item) => item !== id)].slice(0, MAX_RECENTS);
}

function recordRecentHome(kind, id) {
  if (!id || (kind !== "album" && kind !== "playlist")) {
    return;
  }
  if (kind === "playlist" && (id === LIKED_PLAYLIST_ID || isLikedPlaylist(playlistById(id)))) {
    return;
  }

  state.recentHome = [{ kind, id }, ...state.recentHome.filter((item) => item.kind !== kind || item.id !== id)]
    .slice(0, MAX_RECENTS);
}

function recordRecentAlbum(albumId) {
  recordRecentId("recentAlbumIds", albumId);
  recordRecentHome("album", albumId);
  renderLibraryList();
}

function recordRecentTrack(trackId) {
  recordRecentId("recentTrackIds", trackId);
  renderLibraryList();
}

function recordRecentPlaylist(playlistId) {
  recordRecentId("recentPlaylistIds", playlistId);
  recordRecentHome("playlist", playlistId);
  renderLibraryList();
}

function createPlaylist(name, trackId) {
  const trimmed = String(name ?? "").trim() || defaultPlaylistName();
  const playlist = {
    id: newPlaylistId(),
    name: trimmed,
    description: "",
    trackIds: trackId ? [trackId] : [],
    createdAt: Date.now()
  };
  state.playlists = [...state.playlists, playlist];
  invalidateSearchIndex();
  recordRecentPlaylist(playlist.id);
  writeSession();
  if (state.view === "playlists" || state.view === "search") {
    if (state.view === "search") {
      focusSearchOnRender = false;
    }
    render(historyStack[historyIndex]);
    focusSearchOnRender = true;
  }
  return playlist;
}

function defaultSmartPlaylistName() {
  const used = new Set();
  for (const playlist of state.playlists) {
    const match = /^Smart Playlist #(\d+)$/i.exec(playlist.name);
    if (match) {
      used.add(Number(match[1]));
    }
  }
  let number = 1;
  while (used.has(number)) {
    number += 1;
  }
  return `Smart Playlist #${number}`;
}

function createSmartPlaylist({ name, description, smart }) {
  const now = Date.now();
  const playlist = {
    id: newPlaylistId(),
    name: String(name ?? "").trim() || defaultSmartPlaylistName(),
    kind: "smart",
    description: String(description ?? "").trim(),
    trackIds: [],
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    smart: window.EmpSmartPlaylists.normalizeSmartDefinition(smart)
  };
  state.playlists = [...state.playlists, playlist];
  smartMatchCache.delete(playlist.id);
  invalidateSearchIndex();
  recordRecentPlaylist(playlist.id);
  writeSession();
  return playlist;
}

function updateSmartPlaylist(playlistId, { name, description, smart }) {
  const playlist = playlistById(playlistId);
  if (!playlist || !isSmartPlaylist(playlist)) {
    return null;
  }
  playlist.name = String(name ?? "").trim() || playlist.name;
  playlist.description = String(description ?? "").trim();
  playlist.smart = window.EmpSmartPlaylists.normalizeSmartDefinition(smart);
  playlist.updatedAt = Date.now();
  smartMatchCache.delete(playlist.id);
  invalidateSearchIndex();
  writeSession();
  refreshAfterPlaylistChange(playlist.id);
  return playlist;
}

function duplicateSmartPlaylist(playlistId) {
  const source = playlistById(playlistId);
  if (!source || !isSmartPlaylist(source)) {
    return null;
  }
  const smart = window.EmpSmartPlaylists.cloneDefinition(source.smart);
  if (smart.sort?.field === "random") {
    smart.randomSeed = window.EmpSmartPlaylists.newRandomSeed(source.name);
  }
  return createSmartPlaylist({
    name: `${source.name} Copy`,
    description: source.description,
    smart
  });
}

function reshuffleSmartPlaylist(playlistId) {
  const playlist = playlistById(playlistId);
  if (!playlist || !isSmartPlaylist(playlist) || playlist.smart?.sort?.field !== "random") {
    return;
  }
  playlist.smart.randomSeed = window.EmpSmartPlaylists.newRandomSeed(playlist.name);
  playlist.updatedAt = Date.now();
  smartMatchCache.delete(playlist.id);
  writeSession();
  refreshAfterPlaylistChange(playlist.id);
}

function convertSmartPlaylistToRegular(playlistId) {
  const source = playlistById(playlistId);
  if (!source || !isSmartPlaylist(source)) {
    return null;
  }
  const trackIds = playlistTracks(source).map((track) => track.id);
  const playlist = {
    id: newPlaylistId(),
    name: source.name,
    description: source.description || "",
    trackIds,
    createdAt: Date.now()
  };
  state.playlists = [...state.playlists, playlist];
  invalidateSearchIndex();
  recordRecentPlaylist(playlist.id);
  writeSession();
  return playlist;
}

function addTrackToPlaylist(playlistId, trackId) {
  const playlist = playlistById(playlistId);
  if (!playlist || !trackId || isSmartPlaylist(playlist)) {
    return false;
  }

  if (!playlist.trackIds.includes(trackId)) {
    playlist.trackIds = [...playlist.trackIds, trackId];
  }

  if (isLikedPlaylist(playlist)) {
    state.liked.add(trackId);
    updateNowPlaying();
  }

  recordRecentPlaylist(playlist.id);
  writeSession();
  refreshAfterPlaylistChange(playlist.id);
  return true;
}

function likeTrack(trackId) {
  if (!trackId) {
    return;
  }

  state.liked.add(trackId);
  let playlist = likedPlaylist();
  if (!playlist) {
    playlist = {
      id: LIKED_PLAYLIST_ID,
      name: LIKED_PLAYLIST_NAME,
      kind: "liked",
      description: "",
      trackIds: [trackId],
      createdAt: Date.now()
    };
    state.playlists = [...state.playlists, playlist];
    recordRecentPlaylist(playlist.id);
    writeSession();
    refreshAfterPlaylistChange(playlist.id);
    scheduleSmartReevaluation({ liked: true });
    return;
  }

  addTrackToPlaylist(playlist.id, trackId);
  scheduleSmartReevaluation({ liked: true });
}

function unlikeTrack(trackId) {
  if (!trackId) {
    return;
  }

  state.liked.delete(trackId);
  const playlist = likedPlaylist();
  if (!playlist) {
    writeSession();
    scheduleSmartReevaluation({ liked: true });
    return;
  }

  playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
  writeSession();
  refreshAfterPlaylistChange(playlist.id);
  scheduleSmartReevaluation({ liked: true });
}

function removeTrackFromPlaylist(playlistId, trackId) {
  const playlist = playlistById(playlistId);
  if (!playlist || !trackId || isSmartPlaylist(playlist)) {
    return;
  }

  if (isLikedPlaylist(playlist)) {
    unlikeTrack(trackId);
    return;
  }

  playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
  writeSession();
  refreshAfterPlaylistChange(playlist.id);
}

function playPlaylist(playlistId, startId) {
  const playlist = playlistById(playlistId);
  const ids = playlistTracks(playlist).map((track) => track.id);
  if (!ids.length) {
    return;
  }

  recordRecentPlaylist(playlistId);
  const sourceKind = isSmartPlaylist(playlist) ? "smart" : "playlist";
  playTrack(queueStartId(ids, startId), ids, { source: { kind: sourceKind, id: playlistId } });
}

function setRecentsFilter(filter) {
  state.recentsFilter = normalizeRecentsFilter(filter);
  writeSession();
  syncRecentsChips();
  renderLibraryList();
}

function syncRecentsChips() {
  document.querySelectorAll("[data-recents-filter]").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.recentsFilter === state.recentsFilter);
  });
  updateLibraryChipsScroll();
}

function isLibraryView(view = state.view) {
  return view === "albums" || view === "album" || view === "artist" || view === "tracks" || view === "playlist" || view === "playlists";
}

function refreshAfterPlaylistChange(playlistId) {
  invalidateSearchIndex();
  renderLibraryList();
  if (
    state.view === "playlists"
    || state.view === "search"
    || (state.view === "playlist" && (!playlistId || state.playlistId === playlistId))
  ) {
    if (state.view === "search") {
      focusSearchOnRender = false;
    }
    render(historyStack[historyIndex]);
    focusSearchOnRender = true;
  }
}

function syncNavIcons(entry) {
  const homeIcon = document.querySelector('.nav-stack [data-nav="home"] i');
  if (homeIcon) {
    homeIcon.className = entry.view === "home" ? "bi bi-house-fill" : "bi bi-house";
  }

  const songsIcon = document.querySelector('.nav-stack [data-nav="songs"] i');
  if (songsIcon) {
    songsIcon.className = entry.view === "songs" ? "bi bi-music-note-beamed" : "bi bi-music-note-beamed";
  }

  const settingsIcon = document.querySelector('.nav-stack [data-nav="settings"] i');
  if (settingsIcon) {
    settingsIcon.className = entry.view === "settings" ? "bi bi-gear-fill" : "bi bi-gear";
  }

  const libraryIcon = document.querySelector(".library-title-btn i");
  if (libraryIcon) {
    libraryIcon.className = isLibraryView(entry.view) ? "bi bi-collection-play-fill" : "bi bi-collection-play";
  }
}

function libraryQueryNeedle() {
  return String(state.libraryQuery || "").trim().toLowerCase();
}

function matchesLibraryQuery(...parts) {
  const needle = libraryQueryNeedle();
  if (!needle) {
    return true;
  }
  return parts.some((part) => String(part || "").toLowerCase().includes(needle));
}

function sortSidebarItems(items, getTitle) {
  const list = [...items];
  if (state.sidebarSort === "title") {
    return list.sort((left, right) => compareText(getTitle(left), getTitle(right)));
  }
  return list;
}

function queueMatchesIds(ids) {
  return sameCollection(state.queue, ids) && Boolean(currentTrack());
}

function isSidebarTrackPlaying(trackId) {
  return Boolean(state.playing && currentTrack()?.id === trackId);
}

function isSidebarAlbumPlaying(albumId) {
  return Boolean(state.playing && queueMatchesIds(albumQueueIds(albumById(albumId))));
}

function isSidebarPlaylistPlaying(playlistId) {
  return Boolean(state.playing && queueMatchesIds(playlistTracks(playlistById(playlistId)).map((track) => track.id)));
}

function nowEqMarkup(className = "now-eq") {
  return `<span class="${className}" aria-hidden="true"><span></span><span></span><span></span></span>`;
}

function sidebarPlayOverlay(attrs, label, playing) {
  return `
    <button class="playlist-play${playing ? " is-playing" : ""}" type="button" tabindex="-1" ${attrs} title="Play" aria-label="Play ${escapeHtml(label)}">
      <i class="bi bi-play-fill"></i>
      ${nowEqMarkup()}
    </button>
  `;
}

function syncSidebarSortUi() {
  if (sidebarSortLabel) {
    sidebarSortLabel.textContent = state.sidebarSort === "title" ? "A–Z" : "Recents";
  }
  if (sidebarSortBtn) {
    const icon = sidebarSortBtn.querySelector("i");
    if (icon) {
      icon.className = state.sidebarSort === "title" ? "bi bi-sort-alpha-down" : "bi bi-clock-history";
    }
    sidebarSortBtn.setAttribute("aria-label", state.sidebarSort === "title" ? "Sorted A to Z" : "Sorted by recents");
  }
}

function ensureTooltip(element, options = {}) {
  let tooltip = bootstrap.Tooltip.getInstance(element);
  if (tooltip) {
    return tooltip;
  }

  tooltip = new bootstrap.Tooltip(element, {
    trigger: "hover",
    delay: { show: 250, hide: 0 },
    ...options
  });

  const hideTooltip = () => tooltip.hide();
  element.addEventListener("click", hideTooltip);
  element.addEventListener("mouseleave", hideTooltip);
  element.addEventListener("blur", hideTooltip);
  return tooltip;
}

function syncSidebarRailTooltips() {
  document.querySelectorAll("[data-sidebar-rail-tooltip]").forEach((element) => {
    const title = element.getAttribute("data-sidebar-rail-tooltip") || element.getAttribute("aria-label") || "";
    element.setAttribute("data-bs-title", title);

    let tooltip = bootstrap.Tooltip.getInstance(element);
    if (state.sidebarCollapsed) {
      if (!tooltip) {
        tooltip = ensureTooltip(element, { title });
      } else {
        tooltip.setContent({ ".tooltip-inner": title });
        tooltip.enable();
      }
    } else if (tooltip) {
      tooltip.hide();
      tooltip.disable();
    }
  });
}

function applySidebarLayout(options = {}) {
  if (!sidebar) {
    return;
  }

  const animate = options.animate !== false;
  if (!animate) {
    document.documentElement.classList.add("is-sidebar-resizing");
  } else {
    document.documentElement.classList.remove("is-sidebar-resizing");
  }

  const width = state.sidebarCollapsed ? SIDEBAR_COLLAPSED : state.sidebarWidth;
  document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  sidebar.classList.toggle("is-collapsed", state.sidebarCollapsed);
  sidebar.classList.toggle("is-resizing", false);

  if (sidebarCollapseBtn) {
    const icon = sidebarCollapseBtn.querySelector("i");
    const label = state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
    if (icon) {
      icon.className = state.sidebarCollapsed ? "bi bi-chevron-bar-right" : "bi bi-chevron-bar-left";
    }
    setTooltipTitle(sidebarCollapseBtn, label);
  }

  syncSidebarRailTooltips();

  if (!animate) {
    void document.documentElement.offsetWidth;
    document.documentElement.classList.remove("is-sidebar-resizing");
  }
  scheduleCollectionViewportSync();
}

function updateLibraryChipsScroll() {
  const scroller = document.querySelector("[data-chips-scroll]");
  const row = scroller?.querySelector(".library-chips");
  if (!scroller || !row) {
    return;
  }

  const max = row.scrollWidth - row.clientWidth;
  scroller.classList.toggle("can-scroll-left", row.scrollLeft > 2);
  scroller.classList.toggle("can-scroll-right", max - row.scrollLeft > 2);
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = Boolean(collapsed);
  applySidebarLayout();
  writeSession();
  updateLibraryChipsScroll();
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!state.sidebarCollapsed);
}

function cycleSidebarSort() {
  state.sidebarSort = state.sidebarSort === "title" ? "recent" : "title";
  syncSidebarSortUi();
  writeSession();
  renderLibraryList();
}

function createPlaylistFromSidebar() {
  const playlist = createPlaylist();
  state.recentsFilter = "playlists";
  syncRecentsChips();
  writeSession();
  navigate({ view: "playlist", playlistId: playlist.id });
}

let createMenuRoot = null;

function ensureCreateMenu() {
  if (createMenuRoot) {
    return createMenuRoot;
  }
  createMenuRoot = document.createElement("div");
  createMenuRoot.className = "create-menu-root";
  createMenuRoot.hidden = true;
  createMenuRoot.innerHTML = `
    <div class="create-menu" role="menu">
      <button class="create-menu-item" type="button" role="menuitem" data-create-regular>
        <i class="bi bi-music-note-list"></i>
        <span>
          <span class="create-menu-item-title">Create playlist</span>
          <span class="create-menu-item-desc">Add songs manually.</span>
        </span>
      </button>
      <button class="create-menu-item" type="button" role="menuitem" data-create-smart>
        <i class="bi bi-funnel"></i>
        <span>
          <span class="create-menu-item-title">Create smart playlist</span>
          <span class="create-menu-item-desc">Automatically add matching songs.</span>
        </span>
      </button>
    </div>
  `;
  document.body.appendChild(createMenuRoot);
  createMenuRoot.addEventListener("click", (event) => {
    if (event.target === createMenuRoot) {
      closeCreateMenu();
      return;
    }
    if (event.target.closest("[data-create-regular]")) {
      closeCreateMenu();
      createPlaylistFromSidebar();
      return;
    }
    if (event.target.closest("[data-create-smart]")) {
      closeCreateMenu();
      openSmartPlaylistEditorCreate();
    }
  });
  createMenuRoot.addEventListener("keydown", (event) => {
    const items = [...createMenuRoot.querySelectorAll(".create-menu-item")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) {
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = index < 0 ? 0 : (index + delta + items.length) % items.length;
      items[next].focus();
    }
  });
  return createMenuRoot;
}

function positionCreateMenu(anchor) {
  const root = ensureCreateMenu();
  const menu = root.querySelector(".create-menu");
  const rect = anchor.getBoundingClientRect();
  root.hidden = false;
  // Measure after showing so size is accurate.
  const box = menu.getBoundingClientRect();
  const gap = 4;
  const pad = 8;
  let left = rect.left;
  let top = rect.bottom + gap;

  // Prefer staying near the + button / sidebar; flip if clipped.
  if (left + box.width > window.innerWidth - pad) {
    left = Math.max(pad, rect.right - box.width);
  }
  if (top + box.height > window.innerHeight - pad) {
    top = Math.max(pad, rect.top - box.height - gap);
  }
  left = Math.min(Math.max(pad, left), window.innerWidth - box.width - pad);
  top = Math.min(Math.max(pad, top), window.innerHeight - box.height - pad);

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openCreateMenu(anchor) {
  closeContextMenu();
  closeOverflowMenu();
  ensureCreateMenu();
  positionCreateMenu(anchor);
  createMenuRoot.querySelector("[data-create-regular]")?.focus();
}

function closeCreateMenu() {
  if (createMenuRoot) {
    createMenuRoot.hidden = true;
  }
}

function openSmartPlaylistEditorCreate() {
  window.EmpSmartPlaylistEditor?.openCreate({ name: defaultSmartPlaylistName() });
}

function openSmartPlaylistEditorEdit(playlistId) {
  const playlist = playlistById(playlistId || state.playlistId);
  if (!playlist || !isSmartPlaylist(playlist)) {
    return;
  }
  window.EmpSmartPlaylistEditor?.openEdit(playlist);
}

function sidebarPlaylists() {
  const liked = likedPlaylistWithSongs();
  const rank = new Map(state.recentPlaylistIds.map((id, index) => [id, index]));
  const others = state.playlists
    .filter((playlist) => !isLikedPlaylist(playlist))
    .filter((playlist) => matchesLibraryQuery(playlist.name));

  let ordered;
  if (state.sidebarSort === "title") {
    ordered = others.sort((left, right) => compareText(left.name, right.name));
  } else {
    ordered = others.sort((left, right) => {
      const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return compareText(left.name, right.name);
    });
  }

  if (liked && matchesLibraryQuery(liked.name)) {
    return [liked, ...ordered];
  }
  return ordered;
}

function libraryFilterChips() {
  return `
    <div class="library-chips">
      <button class="chip${state.view === "albums" && state.albumFilter === "all" ? " active" : ""}" type="button" data-nav="albums" data-filter="all">All</button>
      <button class="chip${state.view === "albums" && state.albumFilter === "albums" ? " active" : ""}" type="button" data-nav="albums" data-filter="albums">Albums</button>
      <button class="chip${state.view === "albums" && state.albumFilter === "singles" ? " active" : ""}" type="button" data-nav="albums" data-filter="singles">Singles</button>
      <button class="chip${state.view === "albums" && state.albumFilter === "artists" ? " active" : ""}" type="button" data-nav="albums" data-filter="artists">Artist</button>
      <button class="chip${state.view === "tracks" ? " active" : ""}" type="button" data-nav="tracks">Tracks</button>
      <button class="chip${state.view === "playlists" ? " active" : ""}" type="button" data-nav="playlists">Playlists</button>
    </div>
  `;
}

function teardownTrackVirtual() {
  if (!trackVirtual) {
    return;
  }

  viewArea.removeEventListener("scroll", trackVirtual.onScroll);
  trackVirtual = null;
}

function libraryPerfLog(label, startedAt, extra = "") {
  if (!LIBRARY_PERF_ENABLED) {
    return;
  }
  const ms = Math.round(performance.now() - startedAt);
  const cards = viewArea?.querySelectorAll(".media-card, .playlist-row.library-row, .virtual-collection-row .playlist-row")?.length ?? 0;
  const nodes = viewArea?.querySelectorAll("*")?.length ?? 0;
  console.info(`[EMP library] ${label} ${ms}ms${extra ? ` ${extra}` : ""} (cards/rows≈${cards}, nodes=${nodes})`);
}

function teardownCollectionVirtual() {
  if (!collectionVirtual) {
    return;
  }
  if (document.activeElement && collectionVirtual.container?.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  closeContextMenu();
  closeOverflowMenu();
  viewArea.removeEventListener("scroll", collectionVirtual.onScroll);
  collectionVirtual = null;
}

function computeCollectionColumns(width) {
  const w = Math.max(0, Number(width) || 0);
  return Math.max(1, Math.floor((w + COLLECTION_GRID_GAP) / (COLLECTION_GRID_MIN + COLLECTION_GRID_GAP)));
}

function measureCollectionGridCardHeight(container, columns) {
  const width = Math.max(1, container.clientWidth || 1);
  const colWidth = Math.max(
    COLLECTION_GRID_MIN,
    (width - COLLECTION_GRID_GAP * Math.max(0, columns - 1)) / columns
  );
  const host = document.createElement("div");
  host.className = "virtual-collection-measure";
  host.style.width = `${colWidth}px`;
  host.innerHTML = albumCard({
    id: "__measure__",
    title: "Measurement Title",
    artist: "Measurement Artist",
    color: "#282828",
    isSingle: false
  });
  container.appendChild(host);
  const card = host.firstElementChild;
  const height = Math.max(1, Math.ceil(card?.getBoundingClientRect().height || (colWidth + 72)));
  host.remove();
  return height;
}

function captureCollectionScrollAnchor() {
  if (!collectionVirtual?.items?.length) {
    return { anchorIndex: 0, anchorOffset: 0 };
  }
  const { container, metrics, items } = collectionVirtual;
  const columns = Math.max(1, metrics.columns);
  const rowHeight = Math.max(1, metrics.rowHeight);
  const containerTop = container.offsetTop;
  const relative = Math.max(0, viewArea.scrollTop - containerTop);
  const rowCount = Math.max(1, Math.ceil(items.length / columns));
  const safeRow = Math.max(0, Math.min(rowCount - 1, Math.floor(relative / rowHeight)));
  const anchorIndex = Math.min(items.length - 1, safeRow * columns);
  const itemTop = containerTop + Math.floor(anchorIndex / columns) * rowHeight;
  return {
    anchorIndex,
    anchorOffset: itemTop - viewArea.scrollTop
  };
}

function applyCollectionScrollAnchor(anchor) {
  if (!collectionVirtual || !anchor || !collectionVirtual.items.length) {
    return;
  }
  const { container, metrics, items } = collectionVirtual;
  const columns = Math.max(1, metrics.columns);
  const rowHeight = Math.max(1, metrics.rowHeight);
  const anchorIndex = Math.max(0, Math.min(items.length - 1, Number(anchor.anchorIndex) || 0));
  const itemTop = container.offsetTop + Math.floor(anchorIndex / columns) * rowHeight;
  const nextTop = itemTop - (Number(anchor.anchorOffset) || 0);
  const maxScroll = Math.max(0, viewArea.scrollHeight - viewArea.clientHeight);
  viewArea.scrollTop = Math.max(0, Math.min(maxScroll, nextTop));
}

function saveBrowseScrollForHistory() {
  if (state.view !== "albums") {
    return;
  }
  const anchor = collectionVirtual
    ? captureCollectionScrollAnchor()
    : {
      anchorIndex: 0,
      anchorOffset: -Math.max(0, viewArea.scrollTop)
    };
  // For non-virtual (small) libraries, store raw scroll via negative offset sentinel on index 0.
  if (!collectionVirtual) {
    browseScrollByHistoryIndex.set(historyIndex, {
      filter: state.albumFilter,
      layout: state.libraryLayout,
      sort: state.librarySort,
      anchorIndex: 0,
      anchorOffset: -viewArea.scrollTop,
      rawScrollTop: viewArea.scrollTop
    });
    return;
  }
  browseScrollByHistoryIndex.set(historyIndex, {
    filter: state.albumFilter,
    layout: state.libraryLayout,
    sort: state.librarySort,
    anchorIndex: anchor.anchorIndex,
    anchorOffset: anchor.anchorOffset
  });
}

function clearBrowseScrollForHistory(index = historyIndex) {
  browseScrollByHistoryIndex.delete(index);
}

function restoreBrowseScrollForHistory() {
  if (state.view !== "albums") {
    return;
  }
  const stash = browseScrollByHistoryIndex.get(historyIndex);
  if (!stash) {
    return;
  }
  if (
    stash.filter !== state.albumFilter
    || stash.layout !== state.libraryLayout
    || stash.sort !== state.librarySort
  ) {
    return;
  }

  const apply = () => {
    if (typeof stash.rawScrollTop === "number") {
      viewArea.scrollTop = stash.rawScrollTop;
      return;
    }
    if (collectionVirtual) {
      applyCollectionScrollAnchor(stash);
      collectionVirtual.paint();
    }
  };

  // Wait until spacer height is in the layout before restoring.
  requestAnimationFrame(() => {
    requestAnimationFrame(apply);
  });
}

function scheduleCollectionViewportSync() {
  if (collectionResizeRaf) {
    return;
  }
  collectionResizeRaf = requestAnimationFrame(() => {
    collectionResizeRaf = 0;
    trackVirtual?.paint();
    if (!collectionVirtual) {
      return;
    }
    const anchor = captureCollectionScrollAnchor();
    collectionVirtual.remeasure();
    applyCollectionScrollAnchor(anchor);
    collectionVirtual.paint();
  });
}

function mountCollectionVirtual({ items, mode, showingArtists, renderItem }) {
  const container = document.getElementById("virtualCollection");
  const spacer = document.getElementById("virtualCollectionSpacer");
  if (!container || !spacer || !items.length) {
    return;
  }

  const metrics = {
    columns: 1,
    rowHeight: COLLECTION_LIST_ROW_HEIGHT,
    cardHeight: COLLECTION_LIST_ROW_HEIGHT
  };

  const remeasure = () => {
    if (mode === "list") {
      metrics.columns = 1;
      metrics.cardHeight = COLLECTION_LIST_ROW_HEIGHT;
      metrics.rowHeight = COLLECTION_LIST_ROW_HEIGHT;
    } else {
      metrics.columns = computeCollectionColumns(container.clientWidth);
      metrics.cardHeight = measureCollectionGridCardHeight(container, metrics.columns);
      metrics.rowHeight = metrics.cardHeight + COLLECTION_GRID_GAP;
    }
    const rowCount = Math.ceil(items.length / metrics.columns);
    const total = Math.max(0, rowCount * metrics.rowHeight - (mode === "grid" && rowCount > 0 ? COLLECTION_GRID_GAP : 0));
    spacer.style.height = `${total}px`;
  };

  const paint = () => {
    const paintStarted = LIBRARY_PERF_ENABLED ? performance.now() : 0;
    if (document.activeElement && container.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    closeContextMenu();
    closeOverflowMenu();

    const columns = Math.max(1, metrics.columns);
    const rowHeight = Math.max(1, metrics.rowHeight);
    const rowCount = Math.ceil(items.length / columns);
    const containerTop = container.offsetTop;
    const relative = Math.max(0, viewArea.scrollTop - containerTop);
    const firstRow = Math.max(0, Math.floor(relative / rowHeight) - COLLECTION_OVERSCAN_ROWS);
    const visibleRows = Math.ceil(viewArea.clientHeight / rowHeight) + COLLECTION_OVERSCAN_ROWS * 2;
    const lastRow = Math.min(rowCount, firstRow + visibleRows);

    container.querySelectorAll(".virtual-collection-row").forEach((row) => row.remove());

    const chunks = [];
    for (let row = firstRow; row < lastRow; row += 1) {
      const start = row * columns;
      const slice = items.slice(start, start + columns);
      if (!slice.length) {
        continue;
      }
      const cells = slice.map((item, offset) => renderItem(item, start + offset)).join("");
      if (mode === "list") {
        chunks.push(`
          <div class="virtual-collection-row is-list" style="top:${row * rowHeight}px;height:${metrics.cardHeight}px">
            ${cells}
          </div>
        `);
      } else {
        chunks.push(`
          <div class="virtual-collection-row is-grid" style="top:${row * rowHeight}px;height:${metrics.cardHeight}px;grid-template-columns:repeat(${columns}, minmax(0, 1fr));gap:${COLLECTION_GRID_GAP}px">
            ${cells}
          </div>
        `);
      }
    }
    spacer.insertAdjacentHTML("afterend", chunks.join(""));
    syncCoverImages(container);
    libraryPerfLog("collection paint", paintStarted, `rows ${firstRow}-${lastRow} / ${rowCount}`);
  };

  remeasure();
  const onScroll = () => paint();
  viewArea.addEventListener("scroll", onScroll, { passive: true });
  collectionVirtual = {
    items,
    mode,
    showingArtists,
    container,
    spacer,
    metrics,
    renderItem,
    remeasure,
    paint,
    onScroll
  };
  paint();

  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (collectionVirtual?.container !== container) {
        return;
      }
      const anchor = captureCollectionScrollAnchor();
      remeasure();
      applyCollectionScrollAnchor(anchor);
      paint();
    }).catch(() => {});
  }
}

function coverBackground(item) {
  if (item?.coverUrl) {
    return `background-image: url("${item.coverUrl}");`;
  }
  const color = item?.color || "#282828";
  return `background: linear-gradient(135deg, ${color}, #121212);`;
}

function coverPlaceholderStyle(item) {
  const color = item?.color || "#282828";
  return `background: linear-gradient(135deg, ${color}, #121212);`;
}

/** Browser cover URLs may include ?v=; collage identity uses the path only. */
function coverUrlIdentity(coverUrl) {
  const raw = typeof coverUrl === "string" ? coverUrl.trim() : "";
  if (!raw) {
    return "";
  }
  const query = raw.indexOf("?");
  return query < 0 ? raw : raw.slice(0, query);
}

/**
 * First distinct album artworks in track order.
 * Dedupes by albumId AND cover path (ignoring ?v=) so same-album tracks and shared artwork
 * files cannot fill multiple collage tiles.
 */
function selectDistinctCoverUrls(tracks, max = 4) {
  const urls = [];
  const seenAlbums = new Set();
  const seenCovers = new Set();
  const list = Array.isArray(tracks) ? tracks : [];
  for (const track of list) {
    const coverUrl = typeof track?.coverUrl === "string" ? track.coverUrl.trim() : "";
    if (!coverUrl) {
      continue;
    }
    const identity = coverUrlIdentity(coverUrl);
    const albumId = typeof track?.albumId === "string" ? track.albumId.trim() : "";
    if (albumId && seenAlbums.has(albumId)) {
      continue;
    }
    if (identity && seenCovers.has(identity)) {
      continue;
    }
    if (albumId) {
      seenAlbums.add(albumId);
    }
    if (identity) {
      seenCovers.add(identity);
    }
    urls.push(coverUrl);
    if (urls.length >= max) {
      break;
    }
  }
  return urls;
}

function playlistArtworkUrls(playlist) {
  return selectDistinctCoverUrls(playlistTracks(playlist), 4);
}

function coverMosaicMarkup(urls, className) {
  const tiles = [];
  for (let i = 0; i < 4; i += 1) {
    const url = urls[i];
    if (url) {
      tiles.push(`<div class="cover-mosaic-tile">
        <div class="cover-mosaic-fallback" aria-hidden="true"></div>
        <img class="cover-img" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">
      </div>`);
    } else {
      tiles.push(`<div class="cover-mosaic-fallback" aria-hidden="true"></div>`);
    }
  }
  return `<div class="${className} cover-mosaic">${tiles.join("")}</div>`;
}

function playlistCoverMarkup(playlist, className) {
  if (isLikedPlaylist(playlist)) {
    return coverMarkup({ kind: "liked", title: playlist?.name }, className);
  }

  const urls = playlistArtworkUrls(playlist);
  if (urls.length >= 2) {
    return coverMosaicMarkup(urls, className);
  }
  if (urls.length === 1) {
    return coverMarkup({ coverUrl: urls[0], title: playlist?.name, color: playlist?.color }, className);
  }

  return coverMarkup(playlistCoverItem(playlist), className);
}

function coverMarkup(item, className) {
  if (item?.kind === "liked") {
    return `<div class="${className} cover-fallback liked-cover"><i class="bi bi-heart-fill"></i></div>`;
  }

  if (item?.coverUrl) {
    return `<div class="${className} cover-slot">
      <div class="cover-slot-fallback cover-fallback" aria-hidden="true" style="${coverPlaceholderStyle(item)}"><i class="bi bi-music-note-beamed"></i></div>
      <img class="cover-img" src="${escapeHtml(item.coverUrl)}" alt="" loading="lazy" decoding="async">
    </div>`;
  }

  return `<div class="${className} cover-fallback" style="${coverBackground(item)}"><i class="bi bi-music-note-beamed"></i></div>`;
}

function markCoverImageReady(img) {
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("cover-img")) {
    return;
  }
  img.classList.add("is-ready");
  img.closest(".cover-slot, .cover-mosaic-tile")?.classList.remove("is-failed");
}

function markCoverImageFailed(img) {
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("cover-img")) {
    return;
  }
  img.classList.remove("is-ready");
  const slot = img.closest(".cover-slot, .cover-mosaic-tile");
  if (slot) {
    slot.classList.add("is-failed");
  }
  img.removeAttribute("src");
  img.remove();
}

function syncCoverImages(root) {
  if (!root?.querySelectorAll) {
    return;
  }
  root.querySelectorAll("img.cover-img").forEach((img) => {
    if (img.complete) {
      if (img.naturalWidth > 0) {
        markCoverImageReady(img);
      } else {
        markCoverImageFailed(img);
      }
    }
  });
}

function onCoverImageLifecycleEvent(event) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("cover-img")) {
    return;
  }
  if (event.type === "load") {
    markCoverImageReady(img);
    return;
  }
  if (event.type === "error") {
    markCoverImageFailed(img);
  }
}

function bindCoverImageLifecycle(root) {
  if (!root || root.dataset.coverLifecycleBound === "1") {
    return;
  }
  root.dataset.coverLifecycleBound = "1";
  root.addEventListener("load", onCoverImageLifecycleEvent, true);
  root.addEventListener("error", onCoverImageLifecycleEvent, true);
}

function songLabel(count) {
  return `${count} ${count === 1 ? "song" : "songs"}`;
}

function formatCollectionDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours} hr ${minutes} min`;
  }
  if (minutes > 0) {
    return `${minutes} min ${secs} sec`;
  }
  return `${secs} sec`;
}

const accentColorCache = new Map();

function extractVibrantColor(imgSrc) {
  if (accentColorCache.has(imgSrc)) {
    return Promise.resolve(accentColorCache.get(imgSrc));
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const size = 64;
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      const pixels = [];
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const lightness = (max + min) / 2;
        const saturation = max === 0 ? 0 : (max - min) / max;
        if (saturation > 0.15 && lightness > 30 && lightness < 220) {
          pixels.push([r, g, b]);
        }
      }

      if (pixels.length === 0) {
        for (let i = 0; i < data.length; i += 4) {
          pixels.push([data[i], data[i + 1], data[i + 2]]);
        }
      }

      const color = medianCutPalette(pixels, 4)[0];
      const boost = boostSaturation(color, 1.35);
      const result = `rgb(${boost[0]}, ${boost[1]}, ${boost[2]})`;
      accentColorCache.set(imgSrc, result);
      resolve(result);
    };
    img.onerror = () => resolve(null);
    img.src = imgSrc;
  });
}

function medianCutPalette(pixels, depth) {
  if (depth === 0 || pixels.length <= 1) {
    const avg = [0, 0, 0];
    for (const p of pixels) {
      avg[0] += p[0]; avg[1] += p[1]; avg[2] += p[2];
    }
    const n = pixels.length || 1;
    return [[Math.round(avg[0] / n), Math.round(avg[1] / n), Math.round(avg[2] / n)]];
  }

  let maxRange = 0, maxChannel = 0;
  for (let ch = 0; ch < 3; ch++) {
    let lo = 255, hi = 0;
    for (const p of pixels) {
      if (p[ch] < lo) lo = p[ch];
      if (p[ch] > hi) hi = p[ch];
    }
    if (hi - lo > maxRange) {
      maxRange = hi - lo;
      maxChannel = ch;
    }
  }

  pixels.sort((a, b) => a[maxChannel] - b[maxChannel]);
  const mid = Math.floor(pixels.length / 2);
  const left = medianCutPalette(pixels.slice(0, mid), depth - 1);
  const right = medianCutPalette(pixels.slice(mid), depth - 1);
  const all = [...left, ...right];

  all.sort((a, b) => {
    const satA = (Math.max(...a) - Math.min(...a)) / (Math.max(...a) || 1);
    const satB = (Math.max(...b) - Math.min(...b)) / (Math.max(...b) || 1);
    return satB - satA;
  });
  return all;
}

function boostSaturation([r, g, b], factor) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0) return [r, g, b];
  const mid = (max + min) / 2;
  return [
    Math.round(Math.min(255, Math.max(0, mid + (r - mid) * factor))),
    Math.round(Math.min(255, Math.max(0, mid + (g - mid) * factor))),
    Math.round(Math.min(255, Math.max(0, mid + (b - mid) * factor))),
  ];
}

function parseColor(color) {
  if (typeof color !== "string") {
    return null;
  }

  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const value = hex[1].length === 3
      ? hex[1].split("").map((part) => part + part).join("")
      : hex[1];
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16)
    ];
  }

  const rgb = color.match(/rgba?\(([^)]+)\)/i);
  if (!rgb) {
    return null;
  }

  const parts = rgb[1].split(",").slice(0, 3).map((part) => Number.parseFloat(part));
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
}

function darkenColor(color, factor) {
  const rgb = parseColor(color);
  if (!rgb) {
    return null;
  }

  const [r, g, b] = rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel * factor))));
  return `rgb(${r}, ${g}, ${b})`;
}

function setStageAccent(color, depth = 320) {
  mainStage.style.background = color
    ? `linear-gradient(180deg, ${color} 0%, var(--emp-bg) ${depth}px)`
    : "";
  mainStage.style.setProperty("--stage-accent-bar", (color && darkenColor(color, 0.55)) || "");
}

async function setStageAccentFromArt(coverUrl, fallbackColor, depth = 320) {
  const seq = renderSeq;
  if (coverUrl) {
    const color = await extractVibrantColor(coverUrl);
    if (seq !== renderSeq) {
      return;
    }
    if (color) {
      setStageAccent(color, depth);
      return;
    }
  }
  setStageAccent(fallbackColor, depth);
}

/** Soften an accent for Home only — does not mutate extractVibrantColor / cache. */
function softenHomeAccent(color) {
  const rgb = parseColor(color);
  if (!rgb) {
    return color;
  }
  let [h, s, l] = rgbToHsl(rgb);
  s = Math.min(s * 0.7, 0.52);
  l = Math.min(0.38, Math.max(0.16, l * 0.82));
  const out = hslToRgb([h, s, l]);
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}

function mixRgbColors(left, right, amount) {
  const a = parseColor(left);
  const b = parseColor(right);
  if (!a || !b) {
    return left;
  }
  const t = Math.min(1, Math.max(0, amount));
  return `rgb(${a.map((channel, index) => Math.round(channel + (b[index] - channel) * t)).join(", ")})`;
}

function setHomeStageAccent(color, depth = 400) {
  const soft = softenHomeAccent(color);
  if (!soft) {
    mainStage.style.background = "";
    mainStage.style.setProperty("--stage-accent-bar", "");
    return;
  }
  const mid = mixRgbColors(soft, "#121212", 0.58);
  const midStop = Math.round(depth * 0.52);
  mainStage.style.background =
    `linear-gradient(180deg, ${soft} 0%, ${mid} ${midStop}px, var(--emp-bg) ${depth}px)`;
  mainStage.style.setProperty("--stage-accent-bar", darkenColor(soft, 0.5) || "");
}

function setStageSolid(color) {
  mainStage.style.background = color;
  mainStage.style.setProperty("--stage-accent-bar", color);
}

function rgbToHsl([r, g, b]) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((value) => Math.round(value * 255));
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function lyricsBackgroundColor(color) {
  const rgb = parseColor(color) ?? parseColor(LYRICS_FALLBACK_COLOR);
  let [h, s, l] = rgbToHsl(rgb);
  // Near-grey artwork stays grey rather than picking up an invented hue.
  if (s >= 0.08) {
    s = Math.min(0.8, Math.max(0.35, s));
  }
  l = Math.min(0.4, Math.max(0.2, l));
  let out = hslToRgb([h, s, l]);
  while (relativeLuminance(out) > LYRICS_MAX_LUMINANCE && l > 0.08) {
    l -= 0.02;
    out = hslToRgb([h, s, l]);
  }
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}

function matchesQuery(text, query) {
  return normalizeSearchText(text).includes(query);
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchQuery(raw) {
  return normalizeSearchText(raw);
}

function scoreNormalizedField(normalized, query) {
  if (!query || !normalized) {
    return 0;
  }
  if (normalized === query) {
    return 100;
  }
  if (normalized.startsWith(query)) {
    return 80;
  }
  if (normalized.includes(` ${query}`) || normalized.includes(query)) {
    return normalized.includes(` ${query}`) ? 60 : 50;
  }
  return 0;
}

function scoreField(text, query) {
  return scoreNormalizedField(normalizeSearchText(text), query);
}

function scoreEntity(primary, secondaries, query) {
  const primaryScore = scoreField(primary, query);
  let secondaryScore = 0;
  for (const field of secondaries || []) {
    secondaryScore = Math.max(secondaryScore, scoreField(field, query));
  }
  if (!primaryScore && !secondaryScore) {
    return 0;
  }
  if (primaryScore) {
    return primaryScore;
  }
  return Math.max(0, secondaryScore - 25);
}

function scoreIndexedEntity(primaryNorm, secondaryNorms, query) {
  const primaryScore = scoreNormalizedField(primaryNorm, query);
  let secondaryScore = 0;
  for (const field of secondaryNorms || []) {
    secondaryScore = Math.max(secondaryScore, scoreNormalizedField(field, query));
  }
  if (!primaryScore && !secondaryScore) {
    return 0;
  }
  if (primaryScore) {
    return primaryScore;
  }
  return Math.max(0, secondaryScore - 25);
}

function invalidateSearchIndex() {
  searchIndex = null;
}

function ensureSearchIndex() {
  if (searchIndex) {
    return searchIndex;
  }

  const trackCountByArtist = new Map();
  for (const track of state.library.tracks) {
    const key = String(track.artist ?? "").toLowerCase();
    if (!key) {
      continue;
    }
    trackCountByArtist.set(key, (trackCountByArtist.get(key) || 0) + 1);
  }

  const artistsByName = new Map();
  for (const artist of catalogArtists()) {
    const key = String(artist.name ?? "").toLowerCase();
    artistsByName.set(key, {
      artist: {
        ...artist,
        trackCount: trackCountByArtist.get(key) || 0
      },
      nameNorm: normalizeSearchText(artist.name)
    });
  }
  for (const track of state.library.tracks) {
    const key = String(track.artist ?? "").toLowerCase();
    if (!key || artistsByName.has(key)) {
      continue;
    }
    artistsByName.set(key, {
      artist: {
        name: track.artist,
        albums: [],
        coverUrl: track.coverUrl,
        color: track.color,
        trackCount: trackCountByArtist.get(key) || 0
      },
      nameNorm: normalizeSearchText(track.artist)
    });
  }

  searchIndex = {
    artists: [...artistsByName.values()],
    playlists: state.playlists.map((playlist) => ({
      playlist,
      nameNorm: normalizeSearchText(playlist.name)
    })),
    albums: allAlbums().map((album) => ({
      album,
      titleNorm: normalizeSearchText(album.title),
      artistNorm: normalizeSearchText(album.artist)
    })),
    songs: state.library.tracks.map((track) => ({
      track,
      titleNorm: normalizeSearchText(track.title),
      artistNorm: normalizeSearchText(track.artist),
      albumNorm: normalizeSearchText(track.album),
      // Simple lowercasing for All Songs filter — same semantics as toLowerCase().includes.
      // Do not use *Norm fields there (punctuation folding would change matches).
      titleLower: String(track.title || "").toLowerCase(),
      artistLower: String(track.artist || "").toLowerCase(),
      albumLower: String(track.album || "").toLowerCase()
    }))
  };
  return searchIndex;
}

const SEARCH_TYPE_TIEBREAK = {
  artist: 4,
  playlist: 3,
  album: 2,
  song: 1
};

function compareScored(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  const typeDelta = (SEARCH_TYPE_TIEBREAK[right.type] || 0) - (SEARCH_TYPE_TIEBREAK[left.type] || 0);
  if (typeDelta) {
    return typeDelta;
  }
  const nameCmp = compareText(left.sortName, right.sortName);
  if (nameCmp) {
    return nameCmp;
  }
  return left.index - right.index;
}

function searchArtists(query, index = ensureSearchIndex()) {
  return index.artists
    .map((entry, indexPos) => {
      const score = scoreIndexedEntity(entry.nameNorm, [], query);
      if (!score) {
        return null;
      }
      return {
        type: "artist",
        score,
        sortName: entry.artist.name,
        index: indexPos,
        artist: entry.artist
      };
    })
    .filter(Boolean)
    .sort(compareScored);
}

function searchPlaylists(query, index = ensureSearchIndex()) {
  return index.playlists
    .map((entry, indexPos) => {
      if (isLikedPlaylist(entry.playlist) && !likedPlaylistWithSongs()) {
        return null;
      }
      const score = scoreIndexedEntity(entry.nameNorm, [], query);
      if (!score) {
        return null;
      }
      return {
        type: "playlist",
        score,
        sortName: entry.playlist.name,
        index: indexPos,
        playlist: entry.playlist
      };
    })
    .filter(Boolean)
    .sort(compareScored);
}

function searchAlbums(query, index = ensureSearchIndex()) {
  return index.albums
    .map((entry, indexPos) => {
      const score = scoreIndexedEntity(entry.titleNorm, [entry.artistNorm], query);
      if (!score) {
        return null;
      }
      return {
        type: "album",
        score,
        sortName: entry.album.title,
        index: indexPos,
        album: entry.album
      };
    })
    .filter(Boolean)
    .sort(compareScored);
}

function searchSongs(query, index = ensureSearchIndex()) {
  return index.songs
    .map((entry, indexPos) => {
      const score = scoreIndexedEntity(entry.titleNorm, [entry.artistNorm, entry.albumNorm], query);
      if (!score) {
        return null;
      }
      return {
        type: "song",
        score,
        sortName: entry.track.title,
        index: indexPos,
        track: entry.track
      };
    })
    .filter(Boolean)
    .sort(compareScored);
}

function buildSearchResults(rawQuery) {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) {
    return {
      query,
      artists: [],
      playlists: [],
      albums: [],
      songs: [],
      top: null,
      total: 0
    };
  }

  const matchStarted = SEARCH_PERF_ENABLED ? performance.now() : 0;
  const index = ensureSearchIndex();
  const artists = searchArtists(query, index);
  const playlists = searchPlaylists(query, index);
  const albums = searchAlbums(query, index);
  const songs = searchSongs(query, index);
  const top = [...artists, ...playlists, ...albums, ...songs].sort(compareScored)[0] ?? null;
  if (SEARCH_PERF_ENABLED) {
    console.info(
      `[EMP search] match/rank ${Math.round(performance.now() - matchStarted)}ms`,
      `(artists ${artists.length}, playlists ${playlists.length}, albums ${albums.length}, songs ${songs.length})`
    );
  }

  return {
    query,
    artists,
    playlists,
    albums,
    songs,
    top,
    total: artists.length + playlists.length + albums.length + songs.length
  };
}

function resetSearchExpand(queryKey) {
  if (searchExpand.queryKey === queryKey) {
    return;
  }
  searchExpand = {
    queryKey,
    artists: SEARCH_ARTIST_LIMIT,
    playlists: SEARCH_PLAYLIST_LIMIT,
    albums: SEARCH_ALBUM_LIMIT,
    tracks: SEARCH_TRACK_LIMIT
  };
}

function readSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim())
      .slice(0, SEARCH_HISTORY_MAX);
  } catch {
    return [];
  }
}

function writeSearchHistory(entries) {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(entries.slice(0, SEARCH_HISTORY_MAX)));
  } catch {
    // Ignore quota / private mode failures.
  }
}

function isMeaningfulSearchQuery(raw, { forIdle = false } = {}) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length < SEARCH_HISTORY_MIN_LEN) {
    return false;
  }
  if (forIdle) {
    return trimmed.length >= 3 || /\s/.test(trimmed);
  }
  return true;
}

function commitSearchHistory(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!isMeaningfulSearchQuery(trimmed)) {
    return;
  }
  const existing = readSearchHistory();
  const next = [
    trimmed,
    ...existing.filter((item) => item.toLowerCase() !== trimmed.toLowerCase())
  ].slice(0, SEARCH_HISTORY_MAX);
  writeSearchHistory(next);
}

function removeSearchHistoryEntry(term) {
  const needle = String(term ?? "").trim().toLowerCase();
  writeSearchHistory(readSearchHistory().filter((item) => item.toLowerCase() !== needle));
}

function clearSearchHistory() {
  writeSearchHistory([]);
}

function scheduleSearchHistoryIdleCommit() {
  window.clearTimeout(searchHistoryIdleTimer);
  searchHistoryIdleTimer = window.setTimeout(() => {
    if (state.view !== "search") {
      return;
    }
    if (!isMeaningfulSearchQuery(state.query, { forIdle: true })) {
      return;
    }
    commitSearchHistory(state.query);
  }, SEARCH_HISTORY_IDLE_MS);
}

function clearSearchHistoryIdleCommit() {
  window.clearTimeout(searchHistoryIdleTimer);
  searchHistoryIdleTimer = 0;
}

function updateSearchQuery(query, { focus = false, commit = false } = {}) {
  state.query = query;
  const entry = { view: "search", query: state.query };
  historyStack[historyIndex] = entry;
  focusSearchOnRender = focus;
  if (commit) {
    commitSearchHistory(state.query);
    clearSearchHistoryIdleCommit();
  }
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = 0;
  const requestId = ++searchRequestId;
  if (state.view === "search") {
    renderSearch({ preserveFocus: false, requestId });
    searchInput.value = state.query;
    if (focus) {
      searchInput.focus();
    }
  } else {
    render(entry);
  }
  focusSearchOnRender = true;
}

function sortChips({ showLayout = false } = {}) {
  return `
    <div class="library-chips sort-chips">
      <button class="chip${state.librarySort === "recent" ? " active" : ""}" type="button" data-sort="recent">Recents</button>
      <button class="chip${state.librarySort === "title" ? " active" : ""}" type="button" data-sort="title">A–Z</button>
      ${showLayout ? `
        <button class="icon-btn layout-btn${state.libraryLayout === "grid" ? " active" : ""}" type="button" data-layout="grid" aria-label="Grid view" title="Grid view">
          <i class="bi bi-grid-3x3-gap-fill"></i>
        </button>
        <button class="icon-btn layout-btn${state.libraryLayout === "list" ? " active" : ""}" type="button" data-layout="list" aria-label="List view" title="List view">
          <i class="bi bi-list-ul"></i>
        </button>
      ` : ""}
    </div>
  `;
}

function navigate(entry, { push = true } = {}) {
  if (push) {
    historyStack.splice(historyIndex + 1);
    historyStack.push(entry);
    historyIndex = historyStack.length - 1;
  }
  render(entry);
}

function render(entry) {
  renderSeq += 1;
  const nextFilter = entry.view === "albums" ? (entry.filter ?? "all") : null;
  if (state.view === "albums" && entry.view !== "albums") {
    saveBrowseScrollForHistory();
  }
  let resetBrowseScroll = false;
  if (
    state.view === "albums"
    && entry.view === "albums"
    && nextFilter !== null
    && nextFilter !== state.albumFilter
  ) {
    clearBrowseScrollForHistory();
    resetBrowseScroll = true;
  }
  teardownTrackVirtual();
  teardownCollectionVirtual();
  closeContextMenu();
  closeOverflowMenu();
  closeDetailsModal();
  clearTrackSelection();
  state.view = entry.view;
  state.albumId = entry.albumId ?? null;
  state.playlistId = entry.playlistId ?? null;
  state.mixId = entry.mixId ?? null;
  state.artist = entry.artist ?? null;
  state.query = entry.query ?? state.query;
  if (entry.view === "albums") {
    state.albumFilter = entry.filter ?? "all";
  }

  const libraryViews = isLibraryView(entry.view);
  document.querySelectorAll("[data-nav]").forEach((item) => {
    const nav = item.dataset.nav;
    const active = nav === entry.view
      || (libraryViews && nav === "albums" && !item.classList.contains("chip"));
    item.classList.toggle("active", active);
  });
  syncNavIcons(entry);
  syncRecentsChips();
  syncSidebarSortUi();

  topSearch.classList.toggle("d-none", entry.view !== "search");
  if (entry.view === "search") {
    searchInput.value = state.query;
    if (focusSearchOnRender) {
      searchInput.focus();
    }
  }

  if (entry.view === "home") {
    setHomeStageAccent("#1e3b2a");
    renderHome();
  } else if (entry.view === "songs") {
    setStageAccent("#121826");
    ensureListenStatsForSongs();
    renderSongs();
  } else if (entry.view === "search") {
    setStageAccent("#1f1f1f");
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = 0;
    renderSearch({ requestId: ++searchRequestId });
  } else if (entry.view === "albums") {
    setStageAccent("#3a1f12");
    renderAlbumGrid();
    if (resetBrowseScroll) {
      viewArea.scrollTop = 0;
    }
  } else if (entry.view === "tracks") {
    setStageAccent("#121826");
    renderAllTracks();
  } else if (entry.view === "playlists") {
    setStageAccent("#2a1a3a");
    renderPlaylistsLibrary();
  } else if (entry.view === "album") {
    renderAlbum(entry.albumId);
  } else if (entry.view === "playlist") {
    renderPlaylist(entry.playlistId);
  } else if (entry.view === "mix") {
    renderMix(entry.mixId);
  } else if (entry.view === "mixes") {
    renderMixes();
  } else if (entry.view === "artist") {
    renderArtist(entry.artist);
  } else if (entry.view === "settings") {
    setStageAccent("#1f1f1f");
    renderSettings();
    refreshAudioOutputDevices();
    const durationSlider = viewArea.querySelector("[data-crossfade-seconds]");
    if (durationSlider) {
      updateSlider(durationSlider);
    }
  } else if (entry.view === "lyrics") {
    renderLyrics();
  }
  mainStage.classList.toggle("is-lyrics", entry.view === "lyrics");
  syncLyricsButton();

  renderLibraryList();
  mountTopCollection();
  updateCollectionControls();
  syncTopBarScroll();
  syncCoverImages(viewArea);
  syncCoverImages(libraryList);
}

function renderLibraryList() {
  if (!libraryList) {
    return;
  }

  if (state.recentsFilter === "tracks") {
    let recents = recentTracks(SIDEBAR_RECENTS)
      .filter((track) => matchesLibraryQuery(track.title, track.artist, track.album));
    recents = sortSidebarItems(recents, (track) => track.title);
    if (!recents.length) {
      libraryList.innerHTML = `<li class="playlist-sub px-3 py-2">${libraryQueryNeedle() ? "No matching tracks" : "Play something to see recents"}</li>`;
      return;
    }

    const currentId = currentTrack()?.id;
    libraryList.innerHTML = recents.map((track) => {
      const playing = isSidebarTrackPlaying(track.id);
      return `
      <li>
        <div class="playlist-row${playing ? " is-playing" : ""}">
          <button class="playlist-item${currentId === track.id ? " active" : ""}" type="button" data-play-id="${track.id}">
            <span class="playlist-cover-wrap">
              ${coverMarkup(track, "playlist-cover")}
            </span>
            <span class="playlist-meta">
              <span class="playlist-title">${escapeHtml(track.title)}</span>
              <span class="playlist-sub">Song • ${escapeHtml(track.artist)}</span>
            </span>
          </button>
          ${sidebarPlayOverlay(`data-play-id="${track.id}"`, track.title, playing)}
        </div>
      </li>
`;
    }).join("");
    syncCoverImages(libraryList);
    return;
  }

  if (state.recentsFilter === "playlists") {
    const recents = sidebarPlaylists();
    if (!recents.length) {
      libraryList.innerHTML = `<li class="playlist-sub px-3 py-2">${libraryQueryNeedle() ? "No matching playlists" : "Create a playlist to see it here"}</li>`;
      return;
    }

    libraryList.innerHTML = recents.map((playlist) => {
      const tracks = playlistTracks(playlist);
      const playing = isSidebarPlaylistPlaying(playlist.id);
      const pinned = isLikedPlaylist(playlist);
      const smart = isSmartPlaylist(playlist);
      const kindLabel = smart
        ? `<span class="playlist-sub-smart"><i class="bi bi-funnel playlist-smart-icon" aria-hidden="true"></i>Smart Playlist</span>`
        : "Playlist";
      return `
        <li>
          <div class="playlist-row${playing ? " is-playing" : ""}${pinned ? " is-pinned" : ""}">
            <button class="playlist-item${state.view === "playlist" && state.playlistId === playlist.id ? " active" : ""}" type="button" data-open-playlist="${playlist.id}">
              <span class="playlist-cover-wrap">
                ${playlistCoverMarkup(playlist, "playlist-cover")}
              </span>
              <span class="playlist-meta">
                <span class="playlist-title">${escapeHtml(playlist.name)}</span>
                <span class="playlist-sub">${kindLabel} • ${songLabel(tracks.length)}</span>
              </span>
            </button>
            ${sidebarPlayOverlay(`data-play-playlist="${playlist.id}"`, playlist.name, playing)}
          </div>
        </li>
      `;
    }).join("");
    syncCoverImages(libraryList);
    return;
  }

  let recents = recentAlbums(SIDEBAR_RECENTS)
    .filter((album) => matchesLibraryQuery(album.title, album.artist));
  recents = sortSidebarItems(recents, (album) => album.title);
  if (!recents.length) {
    libraryList.innerHTML = `<li class="playlist-sub px-3 py-2">${libraryQueryNeedle() ? "No matching albums" : "Play something to see recents"}</li>`;
    return;
  }

  libraryList.innerHTML = recents.map((album) => {
    const playing = isSidebarAlbumPlaying(album.id);
    return `
    <li>
      <div class="playlist-row${playing ? " is-playing" : ""}">
        <button class="playlist-item${state.view === "album" && state.albumId === album.id ? " active" : ""}" type="button" data-open-album="${album.id}">
          <span class="playlist-cover-wrap">
            ${coverMarkup(album, "playlist-cover")}
          </span>
          <span class="playlist-meta">
            <span class="playlist-title">${escapeHtml(album.title)}</span>
            <span class="playlist-sub">${album.isSingle ? "Single" : "Album"} • ${escapeHtml(album.artist)}</span>
          </span>
        </button>
        ${sidebarPlayOverlay(`data-play-album="${album.id}"`, album.title, playing)}
      </div>
    </li>
  `;
  }).join("");
  syncCoverImages(libraryList);
}

function albumCard(album, options) {
  const subtitleMode = options && typeof options === "object" && options.subtitleMode === "artist"
    ? "artist"
    : "type";
  const sub = subtitleMode === "artist"
    ? `<button class="inline-link" type="button" data-open-artist="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</button>`
    : `${album.isSingle ? "Single" : "Album"} • <button class="inline-link" type="button" data-open-artist="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</button>`;
  const playing = isSidebarAlbumPlaying(album.id);
  return `
    <article class="media-card${playing ? " is-playing" : ""}" data-open-album="${album.id}">
      <div class="media-cover-wrap">
        ${coverMarkup(album, "media-cover")}
        <button class="play-fab${playing ? " is-playing" : ""}" type="button" data-play-album="${album.id}" title="${playing ? "Pause" : "Play"}" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(album.title)}">
          <i class="bi ${playing ? "bi-pause-fill" : "bi-play-fill"}"></i>
        </button>
      </div>
      <div class="media-title">${escapeHtml(album.title)}</div>
      <div class="media-sub">${sub}</div>
    </article>
  `;
}

function playlistKindLabel(playlist) {
  return isSmartPlaylist(playlist) ? "Smart Playlist" : "Playlist";
}

function playlistCard(playlist) {
  const playing = isSidebarPlaylistPlaying(playlist.id);
  const count = playlistTracks(playlist).length;
  return `
    <article class="media-card${playing ? " is-playing" : ""}" data-open-playlist="${playlist.id}">
      <div class="media-cover-wrap">
        ${playlistCoverMarkup(playlist, "media-cover")}
        <button class="play-fab${playing ? " is-playing" : ""}" type="button" data-play-playlist="${playlist.id}" title="${playing ? "Pause" : "Play"}" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(playlist.name)}">
          <i class="bi ${playing ? "bi-pause-fill" : "bi-play-fill"}"></i>
        </button>
      </div>
      <div class="media-title">${escapeHtml(playlist.name)}</div>
      <div class="media-sub">${playlistKindLabel(playlist)} • ${songLabel(count)}</div>
    </article>
  `;
}

function artistCard(artist) {
  return `
    <article class="media-card" data-open-artist="${escapeHtml(artist.name)}">
      <div class="media-cover-wrap">
        ${coverMarkup(artist, "media-cover artist-cover")}
        <button class="play-fab" type="button" data-play-artist="${escapeHtml(artist.name)}" title="Play" aria-label="Play ${escapeHtml(artist.name)}">
          <i class="bi bi-play-fill"></i>
        </button>
      </div>
      <div class="media-title">${escapeHtml(artist.name)}</div>
      <div class="media-sub">Artist</div>
    </article>
  `;
}

function libraryAlbumRow(album) {
  return `
    <div class="playlist-row">
      <button class="playlist-item library-row" type="button" data-open-album="${album.id}">
        <span class="playlist-cover-wrap">
          ${coverMarkup(album, "playlist-cover")}
        </span>
        <span class="playlist-meta">
          <span class="playlist-title">${escapeHtml(album.title)}</span>
          <span class="playlist-sub">${album.isSingle ? "Single" : "Album"} • ${escapeHtml(album.artist)}</span>
        </span>
      </button>
      <button class="playlist-play" type="button" tabindex="-1" data-play-album="${album.id}" title="Play" aria-label="Play ${escapeHtml(album.title)}">
        <i class="bi bi-play-fill"></i>
      </button>
    </div>
  `;
}

function libraryArtistRow(artist) {
  const count = artist.albums.length;
  return `
    <div class="playlist-row">
      <button class="playlist-item library-row" type="button" data-open-artist="${escapeHtml(artist.name)}">
        <span class="playlist-cover-wrap artist-cover">
          ${coverMarkup(artist, "playlist-cover artist-cover")}
        </span>
        <span class="playlist-meta">
          <span class="playlist-title">${escapeHtml(artist.name)}</span>
          <span class="playlist-sub">Artist • ${count} ${count === 1 ? "release" : "releases"}</span>
        </span>
      </button>
      <button class="playlist-play artist-cover" type="button" tabindex="-1" data-play-artist="${escapeHtml(artist.name)}" title="Play" aria-label="Play ${escapeHtml(artist.name)}">
        <i class="bi bi-play-fill"></i>
      </button>
    </div>
  `;
}

function libraryPlaylistRow(playlist) {
  const playing = isSidebarPlaylistPlaying(playlist.id);
  const count = playlistTracks(playlist).length;
  return `
    <div class="playlist-row${playing ? " is-playing" : ""}">
      <button class="playlist-item library-row${state.view === "playlist" && state.playlistId === playlist.id ? " active" : ""}" type="button" data-open-playlist="${playlist.id}">
        <span class="playlist-cover-wrap">
          ${playlistCoverMarkup(playlist, "playlist-cover")}
        </span>
        <span class="playlist-meta">
          <span class="playlist-title">${escapeHtml(playlist.name)}</span>
          <span class="playlist-sub">${playlistKindLabel(playlist)} • ${songLabel(count)}</span>
        </span>
      </button>
      <button class="playlist-play${playing ? " is-playing" : ""}" type="button" tabindex="-1" data-play-playlist="${playlist.id}" title="${playing ? "Pause" : "Play"}" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(playlist.name)}">
        <i class="bi ${playing ? "bi-pause-fill" : "bi-play-fill"}"></i>
      </button>
    </div>
  `;
}

function catalogPlaylists() {
  const liked = likedPlaylistWithSongs();
  const rank = new Map(state.recentPlaylistIds.map((id, index) => [id, index]));
  const others = state.playlists.filter((playlist) => !isLikedPlaylist(playlist));
  let ordered;
  if (state.librarySort === "title") {
    ordered = [...others].sort((left, right) => compareText(left.name, right.name));
  } else {
    ordered = [...others].sort((left, right) => {
      const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return compareText(left.name, right.name);
    });
  }
  return liked ? [liked, ...ordered] : ordered;
}

function renderPlaylistsLibrary() {
  const playlists = catalogPlaylists();
  const userPlaylists = playlists.filter((playlist) => !isLikedPlaylist(playlist));
  const list = state.libraryLayout === "list";
  const body = playlists.length
    ? (list
      ? `<div class="library-list">${playlists.map(libraryPlaylistRow).join("")}</div>`
      : `<div class="card-grid">${playlists.map(playlistCard).join("")}</div>`)
    : "";
  const emptyHint = !userPlaylists.length
    ? `<p class="text-secondary mt-3">Create a playlist from the sidebar to organize your library.</p>`
    : "";

  if (!playlists.length) {
    viewArea.innerHTML = `
      <h1 class="greeting">Playlists</h1>
      <div class="library-toolbar">
        ${libraryFilterChips()}
        ${sortChips({ showLayout: true })}
      </div>
      <div class="empty-state">
        <h2>No playlists yet</h2>
        <p>Create a playlist from the sidebar to start organizing your music.</p>
      </div>
    `;
    return;
  }

  viewArea.innerHTML = `
    <h1 class="greeting">Playlists</h1>
    <div class="library-toolbar">
      ${libraryFilterChips()}
      ${sortChips({ showLayout: true })}
    </div>
    <p class="collection-stat">${playlists.length} ${playlists.length === 1 ? "playlist" : "playlists"}</p>
    ${body}
    ${emptyHint}
  `;
}

function quickCard(album) {
  const playing = isSidebarAlbumPlaying(album.id);
  return `
    <div class="quick-card-wrap${playing ? " is-playing" : ""}">
      <button class="quick-card" type="button" data-open-album="${album.id}">
        <span class="quick-cover-wrap">
          ${coverMarkup(album, "playlist-cover")}
        </span>
        ${playing ? nowEqMarkup("now-eq quick-eq") : ""}
        <span class="quick-title">${escapeHtml(album.title)}</span>
      </button>
      <button class="play-fab quick-play-fab${playing ? " is-playing" : ""}" type="button" data-play-album="${album.id}" title="${playing ? "Pause" : "Play"}" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(album.title)}">
        <i class="bi ${playing ? "bi-pause-fill" : "bi-play-fill"}"></i>
      </button>
    </div>
  `;
}

function quickPlaylistCard(playlist) {
  const playing = isSidebarPlaylistPlaying(playlist.id);
  return `
    <div class="quick-card-wrap${playing ? " is-playing" : ""}">
      <button class="quick-card" type="button" data-open-playlist="${playlist.id}">
        <span class="quick-cover-wrap">
          ${playlistCoverMarkup(playlist, "playlist-cover")}
        </span>
        ${playing ? nowEqMarkup("now-eq quick-eq") : ""}
        <span class="quick-title">${escapeHtml(playlist.name)}</span>
      </button>
      <button class="play-fab quick-play-fab${playing ? " is-playing" : ""}" type="button" data-play-playlist="${playlist.id}" title="${playing ? "Pause" : "Play"}" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(playlist.name)}">
        <i class="bi ${playing ? "bi-pause-fill" : "bi-play-fill"}"></i>
      </button>
    </div>
  `;
}

function homeQuickItems() {
  const items = [];
  const seenAlbums = new Set();
  const seenPlaylists = new Set();
  const liked = likedPlaylistWithSongs();
  if (liked) {
    items.push({ kind: "playlist", playlist: liked });
    seenPlaylists.add(liked.id);
  }

  for (const item of recentHomeItems(MAX_RECENTS)) {
    if (items.length >= HOME_QUICK_SIZE) {
      break;
    }
    if (item.kind === "album") {
      if (seenAlbums.has(item.album.id)) {
        continue;
      }
      items.push(item);
      seenAlbums.add(item.album.id);
    } else if (item.kind === "playlist") {
      if (seenPlaylists.has(item.playlist.id)) {
        continue;
      }
      items.push(item);
      seenPlaylists.add(item.playlist.id);
    }
  }

  if (items.length < HOME_QUICK_SIZE) {
    for (const album of albumsByRecency(allAlbums())) {
      if (items.length >= HOME_QUICK_SIZE) {
        break;
      }
      if (seenAlbums.has(album.id)) {
        continue;
      }
      items.push({ kind: "album", album });
      seenAlbums.add(album.id);
    }
  }

  return items;
}

function renderQuickCard(item) {
  if (item.kind === "playlist") {
    return quickPlaylistCard(item.playlist);
  }
  return quickCard(item.album);
}

function shelfCard(item, subtitleMode) {
  if (item?.kind === "playlist") {
    return playlistCard(item.playlist);
  }
  const album = item?.kind === "album" ? item.album : item;
  return albumCard(album, { subtitleMode });
}

function homeShelfColumns() {
  const rootStyles = getComputedStyle(document.documentElement);
  const min = parseFloat(rootStyles.getPropertyValue("--home-card-min")) || 160;
  const gap = parseFloat(rootStyles.getPropertyValue("--home-card-gap")) || 18;
  const viewStyles = getComputedStyle(viewArea);
  const pad = (parseFloat(viewStyles.paddingLeft) || 0) + (parseFloat(viewStyles.paddingRight) || 0);
  const width = Math.max(0, viewArea.clientWidth - pad);
  return Math.max(2, Math.floor((width + gap) / (min + gap)));
}

function syncHomeLayout() {
  const cols = homeShelfColumns();
  document.documentElement.style.setProperty("--home-cols", String(cols));
  viewArea.querySelectorAll(".home-shelf").forEach((shelf) => {
    const btn = shelf.querySelector(".see-all");
    if (!btn) {
      return;
    }
    const total = Number(shelf.dataset.total || 0);
    btn.hidden = total <= cols;
  });
  return cols;
}

function shelfSection(title, items, filter, { subtitleMode = "type", shelf = "" } = {}) {
  if (!items.length) {
    return "";
  }

  const cols = homeShelfColumns();
  const shown = items.slice(0, HOME_SHELF_SIZE);
  const showAll = items.length > cols;
  const shelfClass = shelf ? ` home-shelf-${shelf}` : "";
  const shelfAttr = shelf ? ` data-shelf="${shelf}"` : "";
  return `
    <section class="home-shelf${shelfClass}"${shelfAttr} data-total="${items.length}">
      <div class="section-head">
        <button class="section-title-btn" type="button" data-nav="albums" data-filter="${filter}">
          <h2>${title}</h2>
        </button>
        ${items.length > 2 ? `<button class="see-all" type="button" data-nav="albums" data-filter="${filter}"${showAll ? "" : " hidden"}>See all</button>` : ""}
      </div>
      <div class="shelf-row">${shown.map((item) => shelfCard(item, subtitleMode)).join("")}</div>
    </section>
  `;
}

function renderHome() {
  const { singles, tracks } = state.library;
  if (!tracks.length) {
    renderEmpty();
    return;
  }

  const recents = recentHomeItems();
  const quick = homeQuickItems();
  // Fixed Home accent — do not derive from recently played / album art.
  setHomeStageAccent("#1e3b2a");

  const canShuffleLibrary = tracks.length > 0;
  const mixes = state.personalizedMixes !== false ? ensurePersonalizedMixes() : [];
  const homeAlbums = albumsForHomeShelf(recents);
  viewArea.innerHTML = `
    <div class="home-page">
      <div class="home-greeting-row">
        <h1 class="greeting">${greeting()}</h1>
        <button class="home-shuffle-library" type="button" data-shuffle-library${canShuffleLibrary ? "" : " disabled"} aria-label="Shuffle Library"${canShuffleLibrary ? "" : " title=\"No playable songs\""}>
          <i class="bi bi-shuffle" aria-hidden="true"></i>
          <span>Shuffle Library</span>
        </button>
      </div>
      ${quick.length ? `<div class="quick-grid">${quick.map(renderQuickCard).join("")}</div>` : ""}
      ${recents.length > HOME_QUICK_SIZE ? shelfSection("Recently played", recents, "all", { subtitleMode: "artist", shelf: "recent" }) : ""}
      ${mixesShelfSection(mixes)}
      ${shelfSection("Albums", homeAlbums, "albums", { subtitleMode: "artist" })}
      ${shelfSection("Singles", albumsByRecency(singles), "singles", { subtitleMode: "artist" })}
    </div>
  `;
  syncHomeLayout();
  syncCoverImages(viewArea);
}

function catalogAlbums() {
  if (state.albumFilter === "albums") {
    return state.library.albums;
  }
  if (state.albumFilter === "singles") {
    return state.library.singles;
  }
  return allAlbums();
}

function renderAlbumGrid() {
  const started = LIBRARY_PERF_ENABLED ? performance.now() : 0;
  const showingArtists = state.albumFilter === "artists";
  const albums = showingArtists ? [] : sortAlbums(catalogAlbums());
  const artists = showingArtists ? sortArtists(catalogArtists()) : [];
  const items = showingArtists ? artists : albums;
  if (!items.length) {
    renderEmpty();
    return;
  }

  const heading = state.albumFilter === "singles"
    ? "Singles"
    : state.albumFilter === "albums"
      ? "Albums"
      : state.albumFilter === "artists"
        ? "Artists"
        : "Your Library";
  const label = showingArtists
    ? "artists"
    : state.albumFilter === "singles"
      ? "singles"
      : state.albumFilter === "albums"
        ? "albums"
        : "albums & singles";
  const list = state.libraryLayout === "list";
  const useVirtual = items.length > COLLECTION_VIRTUAL_THRESHOLD;
  let body;
  if (useVirtual) {
    body = `
      <div class="virtual-collection${list ? " is-list" : " is-grid"}" id="virtualCollection">
        <div class="virtual-collection-spacer" id="virtualCollectionSpacer"></div>
      </div>
    `;
  } else if (showingArtists) {
    body = list
      ? `<div class="library-list">${artists.map(libraryArtistRow).join("")}</div>`
      : `<div class="card-grid">${artists.map(artistCard).join("")}</div>`;
  } else {
    body = list
      ? `<div class="library-list">${albums.map(libraryAlbumRow).join("")}</div>`
      : `<div class="card-grid">${albums.map(albumCard).join("")}</div>`;
  }

  viewArea.innerHTML = `
    <h1 class="greeting">${heading}</h1>
    <div class="library-toolbar">
      ${libraryFilterChips()}
      ${sortChips({ showLayout: true })}
    </div>
    <p class="collection-stat">${items.length} ${label}</p>
    ${body}
  `;

  if (useVirtual) {
    const renderItem = showingArtists
      ? (item) => (list ? libraryArtistRow(item) : artistCard(item))
      : (item) => (list ? libraryAlbumRow(item) : albumCard(item));
    mountCollectionVirtual({
      items,
      mode: list ? "list" : "grid",
      showingArtists,
      renderItem
    });
  }

  restoreBrowseScrollForHistory();
  libraryPerfLog(
    "renderAlbumGrid",
    started,
    `${items.length} items ${list ? "list" : "grid"}${useVirtual ? " virtual" : " full"}`
  );
}

function renderAllTracks() {
  if (!state.library.tracks.length) {
    renderEmpty();
    return;
  }

  const tracks = sortTracks(state.library.tracks);
  viewArea.innerHTML = `
    <h1 class="greeting">All tracks</h1>
    <div class="library-toolbar">
      ${libraryFilterChips()}
      ${sortChips()}
    </div>
    <p class="collection-stat">${songLabel(tracks.length)}</p>
    <div class="track-table virtual-track-table" id="virtualTrackTable">
      <div class="virtual-spacer" id="virtualTrackSpacer"></div>
    </div>
  `;
  mountTrackVirtual(tracks, true);
}

function songsQueryNeedle() {
  return String(state.songsQuery || "").trim().toLowerCase();
}

function trackMatchesSongsQuery(track, needle = songsQueryNeedle(), lowerFields = null) {
  if (!needle) {
    return true;
  }
  if (lowerFields) {
    return lowerFields.titleLower.includes(needle)
      || lowerFields.artistLower.includes(needle)
      || lowerFields.albumLower.includes(needle);
  }
  return [track.title, track.artist, track.album]
    .some((part) => String(part || "").toLowerCase().includes(needle));
}

function trackYear(track) {
  const year = albumById(track.albumId)?.year;
  return Number.isFinite(year) && year > 0 ? year : 0;
}

function compareSongsTracks(left, right) {
  const dir = state.songsSortDir === "desc" ? -1 : 1;
  let primary = 0;
  let applyDir = true;

  switch (state.songsSort) {
    case "artist":
      primary = compareText(left.artist, right.artist) || compareText(left.title, right.title);
      break;
    case "album":
      primary = compareText(left.album, right.album)
        || ((left.trackNumber || 0) - (right.trackNumber || 0))
        || compareText(left.title, right.title);
      break;
    case "duration":
      primary = (left.duration || 0) - (right.duration || 0);
      break;
    case "year": {
      const leftYear = trackYear(left);
      const rightYear = trackYear(right);
      const leftMissing = leftYear <= 0;
      const rightMissing = rightYear <= 0;
      if (leftMissing !== rightMissing) {
        primary = leftMissing ? 1 : -1;
        applyDir = false;
      } else if (!leftMissing) {
        primary = leftYear - rightYear;
      }
      break;
    }
    case "mostPlayed":
      primary = trackPlayCount(right.id) - trackPlayCount(left.id);
      applyDir = false;
      break;
    case "leastPlayed":
      primary = trackPlayCount(left.id) - trackPlayCount(right.id);
      applyDir = false;
      break;
    case "recentlyPlayed": {
      const leftPlayed = trackLastPlayedAt(left.id);
      const rightPlayed = trackLastPlayedAt(right.id);
      if (!leftPlayed && rightPlayed) {
        primary = 1;
      } else if (leftPlayed && !rightPlayed) {
        primary = -1;
      } else {
        primary = rightPlayed - leftPlayed;
      }
      applyDir = false;
      break;
    }
    case "title":
    default:
      primary = compareText(left.title, right.title) || compareText(left.artist, right.artist);
      break;
  }

  if (primary !== 0) {
    return (applyDir ? primary * dir : primary)
      || compareText(left.title, right.title)
      || compareText(left.id, right.id);
  }
  return compareText(left.title, right.title) || compareText(left.id, right.id);
}

function songsHasActiveFilter() {
  return Boolean(songsQueryNeedle()) || state.songsNeverPlayed;
}

function songsLibraryTracks() {
  return state.library.tracks;
}

function getSongsTracks() {
  const needle = songsQueryNeedle();
  let tracks;
  if (needle) {
    const index = ensureSearchIndex();
    tracks = index.songs
      .filter((entry) => trackMatchesSongsQuery(entry.track, needle, entry))
      .map((entry) => entry.track);
  } else {
    tracks = songsLibraryTracks();
  }
  if (state.songsNeverPlayed) {
    tracks = tracks.filter((track) => trackPlayCount(track.id) <= 0);
  }
  return [...tracks].sort(compareSongsTracks);
}

function songsCountLabel(matched, total = songsLibraryTracks().length) {
  if (songsHasActiveFilter()) {
    return `${matched.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "song" : "songs"}`;
  }
  return `${total.toLocaleString()} ${total === 1 ? "song" : "songs"} in your library`;
}

function songsActionLabel(verb, count) {
  if (songsHasActiveFilter()) {
    return `${verb} ${count.toLocaleString()} ${count === 1 ? "song" : "songs"}`;
  }
  return `${verb} All`;
}

function songsTrackPanelMarkup() {
  return `
    <div class="track-panel songs-track-panel">
      <div class="track-table with-album">
        ${trackTableHead(true, true)}
        <div class="virtual-track-table" id="virtualTrackTable">
          <div class="virtual-spacer" id="virtualTrackSpacer"></div>
        </div>
      </div>
    </div>
  `;
}

function songsSortLabel(sort = state.songsSort) {
  return SONGS_SORT_OPTIONS.find((option) => option.id === sort)?.label || "Title";
}

function songsSortMenuMarkup() {
  return SONGS_SORT_OPTIONS.map((option) => {
    const active = state.songsSort === option.id;
    return `
      <button class="songs-sort-item${active ? " active" : ""}" type="button" role="menuitemradio" aria-checked="${active ? "true" : "false"}" data-songs-sort="${option.id}">
        <span>${option.label}</span>
        ${active ? '<i class="bi bi-check-lg" aria-hidden="true"></i>' : ""}
      </button>
    `;
  }).join("");
}

function closeSongsSortMenu() {
  const wrap = document.querySelector(".songs-sort-wrap");
  const menu = document.getElementById("songsSortMenu");
  const button = document.getElementById("songsSortButton");
  if (!wrap || !menu || !button) {
    return;
  }
  wrap.classList.remove("is-open");
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

function setSongsSort(sort) {
  state.songsSort = normalizeSongsSort(sort);
  if (["mostPlayed", "leastPlayed", "recentlyPlayed"].includes(state.songsSort)) {
    state.songsSortDir = "asc";
  }
  closeSongsSortMenu();
  const label = document.getElementById("songsSortLabel");
  if (label) {
    label.textContent = songsSortLabel();
  }
  refreshSongsResults({ preserveScroll: true });
}

function renderSongs() {
  if (!songsLibraryTracks().length) {
    renderEmpty();
    return;
  }

  const tracks = getSongsTracks();
  songsResultIds = tracks.map((track) => track.id);
  const count = tracks.length;
  const total = songsLibraryTracks().length;
  const playLabel = songsActionLabel("Play", count);
  const shuffleLabel = songsActionLabel("Shuffle", count);
  const dirIcon = state.songsSortDir === "desc" ? "bi-sort-down" : "bi-sort-up";
  const showDir = !["mostPlayed", "leastPlayed", "recentlyPlayed"].includes(state.songsSort);

  viewArea.innerHTML = `
    <div class="songs-page" id="songsPage">
      <header class="songs-header">
        <div class="songs-header-text">
          <h1>Songs</h1>
          <p class="songs-subtitle" id="songsStat">${escapeHtml(songsCountLabel(count, total))}</p>
        </div>
        <div class="songs-actions">
          <button class="play-fab-lg" type="button" data-songs-play${count ? "" : " disabled"} aria-label="${escapeHtml(playLabel)}" title="${escapeHtml(playLabel)}">
            <i class="bi bi-play-fill"></i>
          </button>
          <button class="collection-shuffle songs-shuffle" type="button" data-songs-shuffle${count ? "" : " disabled"} aria-label="${escapeHtml(shuffleLabel)}" title="${escapeHtml(shuffleLabel)}">
            <i class="bi bi-shuffle"></i>
          </button>
        </div>
      </header>
      <div class="songs-toolbar">
        <label class="songs-filter">
          <i class="bi bi-search" aria-hidden="true"></i>
          <input type="search" id="songsFilterInput" placeholder="Filter songs..." aria-label="Filter songs" autocomplete="off" value="${escapeHtml(state.songsQuery)}">
          <button class="songs-filter-clear${state.songsQuery ? "" : " d-none"}" type="button" data-songs-filter-clear aria-label="Clear filter" title="Clear filter">
            <i class="bi bi-x-lg"></i>
          </button>
        </label>
        <div class="songs-sort">
          <div class="songs-sort-wrap">
            <button class="songs-sort-button" type="button" id="songsSortButton" data-songs-sort-toggle aria-haspopup="menu" aria-expanded="false" aria-controls="songsSortMenu">
              <span id="songsSortLabel">${escapeHtml(songsSortLabel())}</span>
              <i class="bi bi-chevron-down" aria-hidden="true"></i>
            </button>
            <div class="songs-sort-menu" id="songsSortMenu" role="menu" aria-label="Sort songs" hidden>
              ${songsSortMenuMarkup()}
            </div>
          </div>
          <button class="songs-sort-dir${showDir ? "" : " d-none"}" type="button" data-songs-sort-dir aria-label="Toggle sort direction" title="Toggle sort direction">
            <i class="bi ${dirIcon}"></i>
          </button>
        </div>
        <button class="chip songs-never-played${state.songsNeverPlayed ? " active" : ""}" type="button" data-songs-never-played aria-pressed="${state.songsNeverPlayed ? "true" : "false"}">Never Played</button>
      </div>
      ${count ? songsTrackPanelMarkup() : `
        <div class="empty-state songs-empty-filter">
          <h2>No songs match</h2>
          <p>Try a different filter or turn off Never Played.</p>
          <button class="pill-btn empty-cta" type="button" data-songs-reset-filters>Clear filters</button>
        </div>
      `}
    </div>
  `;

  if (count) {
    mountTrackVirtual(tracks, true);
  }
  updateSongsCollectionControls();
}

function refreshSongsResults({ preserveScroll = false } = {}) {
  const page = document.getElementById("songsPage");
  if (!page || state.view !== "songs") {
    return;
  }

  const scrollTop = preserveScroll ? viewArea.scrollTop : 0;
  const filterInput = document.getElementById("songsFilterInput");
  const selectionStart = filterInput?.selectionStart ?? null;
  const selectionEnd = filterInput?.selectionEnd ?? null;
  const filterFocused = document.activeElement === filterInput;

  const tracks = getSongsTracks();
  songsResultIds = tracks.map((track) => track.id);
  const count = tracks.length;
  const total = songsLibraryTracks().length;

  const stat = document.getElementById("songsStat");
  if (stat) {
    stat.textContent = songsCountLabel(count, total);
  }

  const playBtnEl = page.querySelector(".songs-actions [data-songs-play]");
  const shuffleBtnEl = page.querySelector("[data-songs-shuffle]");
  const playLabel = songsActionLabel("Play", count);
  const shuffleLabel = songsActionLabel("Shuffle", count);
  if (playBtnEl) {
    playBtnEl.disabled = !count;
    playBtnEl.setAttribute("aria-label", playLabel);
    playBtnEl.title = playLabel;
  }
  if (shuffleBtnEl) {
    shuffleBtnEl.disabled = !count;
    shuffleBtnEl.setAttribute("aria-label", shuffleLabel);
    shuffleBtnEl.title = shuffleLabel;
  }

  const clearBtn = page.querySelector("[data-songs-filter-clear]");
  clearBtn?.classList.toggle("d-none", !state.songsQuery);

  const dirBtn = page.querySelector("[data-songs-sort-dir]");
  const showDir = !["mostPlayed", "leastPlayed", "recentlyPlayed"].includes(state.songsSort);
  if (dirBtn) {
    dirBtn.classList.toggle("d-none", !showDir);
    dirBtn.innerHTML = `<i class="bi ${state.songsSortDir === "desc" ? "bi-sort-down" : "bi-sort-up"}"></i>`;
  }

  const neverBtn = page.querySelector("[data-songs-never-played]");
  if (neverBtn) {
    neverBtn.classList.toggle("active", state.songsNeverPlayed);
    neverBtn.setAttribute("aria-pressed", state.songsNeverPlayed ? "true" : "false");
  }

  teardownTrackVirtual();
  const toolbar = page.querySelector(".songs-toolbar");
  const existingPanel = page.querySelector(".songs-track-panel");
  const existingEmpty = page.querySelector(".songs-empty-filter");
  if (count) {
    existingEmpty?.remove();
    if (!existingPanel) {
      toolbar?.insertAdjacentHTML("afterend", songsTrackPanelMarkup());
    }
    mountTrackVirtual(tracks, true);
  } else {
    existingPanel?.remove();
    if (!existingEmpty) {
      toolbar?.insertAdjacentHTML("afterend", `
        <div class="empty-state songs-empty-filter">
          <h2>No songs match</h2>
          <p>Try a different filter or turn off Never Played.</p>
          <button class="pill-btn empty-cta" type="button" data-songs-reset-filters>Clear filters</button>
        </div>
      `);
    }
  }

  if (preserveScroll) {
    viewArea.scrollTop = scrollTop;
  }

  if (filterFocused && filterInput) {
    filterInput.focus();
    if (selectionStart != null && selectionEnd != null) {
      try {
        filterInput.setSelectionRange(selectionStart, selectionEnd);
      } catch {
        // Some search inputs reject selection ranges.
      }
    }
  }

  updateSongsCollectionControls();
}

function updateSongsCollectionControls() {
  if (state.view !== "songs") {
    return;
  }
  const play = viewArea.querySelector(".songs-actions [data-songs-play]");
  const topPlay = document.getElementById("topCollectionPlay");
  if (!play && !topPlay) {
    return;
  }
  const current = sameCollection(state.queue, songsResultIds) && Boolean(currentTrack());
  const playing = current && state.playing;
  const icon = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
  const label = playing ? "Pause" : songsActionLabel("Play", songsResultIds.length);
  const canPlay = songsResultIds.length > 0;

  if (play) {
    play.disabled = !canPlay;
    play.innerHTML = icon;
    play.setAttribute("aria-label", label);
    play.title = label;
  }

  if (topPlay) {
    topPlay.disabled = !canPlay;
    topPlay.innerHTML = icon;
    topPlay.setAttribute("aria-label", label);
    topPlay.title = label;
  }

  const shuffle = viewArea.querySelector("[data-songs-shuffle]");
  if (shuffle) {
    const on = current && state.shuffle;
    shuffle.classList.toggle("active", on);
  }
}

function scheduleSongsFilterRefresh() {
  window.clearTimeout(songsFilterTimer);
  songsFilterTimer = window.setTimeout(() => {
    refreshSongsResults({ preserveScroll: true });
  }, SONGS_FILTER_DEBOUNCE_MS);
}

function resetSongsFilters() {
  state.songsQuery = "";
  state.songsNeverPlayed = false;
  const input = document.getElementById("songsFilterInput");
  if (input) {
    input.value = "";
  }
  refreshSongsResults();
}

function playLibraryTracks(ids, { shuffle = false, source = { kind: "library" }, startId = null } = {}) {
  const queueIds = (ids || []).filter((id) => trackById(id));
  if (!queueIds.length) {
    return;
  }

  if (shuffle) {
    if (!state.shuffle) {
      setShuffle(true);
    }
    playTrack(startId && queueIds.includes(startId) ? startId : randomQueueId(queueIds), queueIds, { source });
    return;
  }

  if (state.shuffle) {
    setShuffle(false);
  }
  playTrack(queueStartId(queueIds, startId), queueIds, { source });
}

function playSongsFromView(startId, { shuffle = false } = {}) {
  const ids = songsResultIds.length ? songsResultIds : getSongsTracks().map((track) => track.id);
  playLibraryTracks(ids, { shuffle, source: { kind: "songs" }, startId });
}

function shuffleFullLibrary() {
  const ids = state.library.tracks.map((track) => track.id).filter((id) => trackById(id));
  playLibraryTracks(ids, { shuffle: true, source: { kind: "library" } });
}

function searchShowMoreButton(kind, label, shown, total) {
  if (shown >= total) {
    return "";
  }
  const remaining = total - shown;
  const next = Math.min(SEARCH_SHOW_MORE_BATCH, remaining);
  return `
    <button class="search-show-more" type="button" data-search-more="${kind}">
      Show more ${label} (${next})
    </button>
  `;
}

function searchRecentMarkup() {
  const recent = readSearchHistory();
  if (!recent.length) {
    return "";
  }
  return `
    <section class="search-recent" aria-label="Recent searches">
      <div class="section-head">
        <h2>Recent searches</h2>
        <button class="see-all" type="button" data-search-clear-history>Clear history</button>
      </div>
      <ul class="search-recent-list">
        ${recent.map((term) => `
          <li class="search-recent-item">
            <button class="search-recent-query" type="button" data-search-recent="${escapeHtml(term)}">
              <i class="bi bi-clock-history" aria-hidden="true"></i>
              <span>${escapeHtml(term)}</span>
            </button>
            <button class="search-recent-remove" type="button" data-search-remove="${escapeHtml(term)}" aria-label="Remove ${escapeHtml(term)} from recent searches">
              <i class="bi bi-x-lg" aria-hidden="true"></i>
            </button>
          </li>
        `).join("")}
      </ul>
    </section>
  `;
}

function searchBrowseMarkup() {
  return `
    <section class="search-browse" aria-label="Browse your library">
      <div class="section-head">
        <h2>Browse your library</h2>
      </div>
      <div class="search-browse-grid">
        <button class="search-browse-tile search-browse-artists" type="button" data-nav="albums" data-filter="artists">
          <i class="bi bi-people-fill" aria-hidden="true"></i>
          <span>Artists</span>
        </button>
        <button class="search-browse-tile search-browse-albums" type="button" data-nav="albums" data-filter="albums">
          <i class="bi bi-disc-fill" aria-hidden="true"></i>
          <span>Albums</span>
        </button>
        <button class="search-browse-tile search-browse-songs" type="button" data-nav="tracks">
          <i class="bi bi-music-note-beamed" aria-hidden="true"></i>
          <span>Songs</span>
        </button>
        <button class="search-browse-tile search-browse-playlists" type="button" data-nav="playlists">
          <i class="bi bi-music-note-list" aria-hidden="true"></i>
          <span>Playlists</span>
        </button>
      </div>
    </section>
  `;
}

function searchTopResultMarkup(top) {
  if (!top) {
    return "";
  }

  if (top.type === "song") {
    const track = top.track;
    return `
      <section class="search-results-section search-top-section" aria-label="Top result">
        <div class="section-head"><h2>Top result</h2></div>
        <div class="search-top-result search-top-song">
          <button class="search-top-main" type="button" data-play-id="${track.id}" aria-label="Play ${escapeHtml(track.title)}">
            ${coverMarkup(track, "search-top-cover")}
            <span class="search-top-copy">
              <span class="search-top-title">${escapeHtml(track.title)}</span>
              <span class="search-top-meta">Song • ${escapeHtml(track.artist)}${track.album ? ` • ${escapeHtml(track.album)}` : ""}</span>
            </span>
          </button>
        </div>
      </section>
    `;
  }

  if (top.type === "artist") {
    const artist = top.artist;
    const releases = artist.albums?.length || 0;
    const songs = artist.trackCount || tracksByArtist(artist.name).length;
    const meta = releases
      ? `${releases} ${releases === 1 ? "release" : "releases"}`
      : songLabel(songs);
    return `
      <section class="search-results-section search-top-section" aria-label="Top result">
        <div class="section-head"><h2>Top result</h2></div>
        <div class="search-top-result">
          <button class="search-top-main" type="button" data-open-artist="${escapeHtml(artist.name)}">
            ${coverMarkup(artist, "search-top-cover artist-cover")}
            <span class="search-top-copy">
              <span class="search-top-title">${escapeHtml(artist.name)}</span>
              <span class="search-top-meta">Artist • ${meta}</span>
            </span>
          </button>
          <button class="play-fab search-top-play" type="button" data-play-artist="${escapeHtml(artist.name)}" title="Play" aria-label="Play ${escapeHtml(artist.name)}">
            <i class="bi bi-play-fill"></i>
          </button>
        </div>
      </section>
    `;
  }

  if (top.type === "album") {
    const album = top.album;
    return `
      <section class="search-results-section search-top-section" aria-label="Top result">
        <div class="section-head"><h2>Top result</h2></div>
        <div class="search-top-result">
          <button class="search-top-main" type="button" data-open-album="${album.id}">
            ${coverMarkup(album, "search-top-cover")}
            <span class="search-top-copy">
              <span class="search-top-title">${escapeHtml(album.title)}</span>
              <span class="search-top-meta">${album.isSingle ? "Single" : "Album"} • ${escapeHtml(album.artist)}</span>
            </span>
          </button>
          <button class="play-fab search-top-play" type="button" data-play-album="${album.id}" title="Play" aria-label="Play ${escapeHtml(album.title)}">
            <i class="bi bi-play-fill"></i>
          </button>
        </div>
      </section>
    `;
  }

  if (top.type === "playlist") {
    const playlist = top.playlist;
    const count = playlistTracks(playlist).length;
    return `
      <section class="search-results-section search-top-section" aria-label="Top result">
        <div class="section-head"><h2>Top result</h2></div>
        <div class="search-top-result">
          <button class="search-top-main" type="button" data-open-playlist="${playlist.id}">
            ${playlistCoverMarkup(playlist, "search-top-cover")}
            <span class="search-top-copy">
              <span class="search-top-title">${escapeHtml(playlist.name)}</span>
              <span class="search-top-meta">${playlistKindLabel(playlist)} • ${songLabel(count)}</span>
            </span>
          </button>
          <button class="play-fab search-top-play" type="button" data-play-playlist="${playlist.id}" title="Play" aria-label="Play ${escapeHtml(playlist.name)}">
            <i class="bi bi-play-fill"></i>
          </button>
        </div>
      </section>
    `;
  }

  return "";
}

function searchArtistCard(artist) {
  const releases = artist.albums?.length || 0;
  const sub = releases
    ? `Artist • ${releases} ${releases === 1 ? "release" : "releases"}`
    : `Artist • ${songLabel(artist.trackCount || tracksByArtist(artist.name).length)}`;
  return `
    <article class="media-card" data-open-artist="${escapeHtml(artist.name)}">
      <div class="media-cover-wrap">
        ${coverMarkup(artist, "media-cover artist-cover")}
        <button class="play-fab" type="button" data-play-artist="${escapeHtml(artist.name)}" title="Play" aria-label="Play ${escapeHtml(artist.name)}">
          <i class="bi bi-play-fill"></i>
        </button>
      </div>
      <div class="media-title">${escapeHtml(artist.name)}</div>
      <div class="media-sub">${sub}</div>
    </article>
  `;
}

function renderSearchLanding() {
  const emptyLibrary = !state.library.tracks.length;
  if (emptyLibrary && !musicFolders().length) {
    return `
      <div class="search-landing">
        <p class="search-tagline text-secondary">Find your next favorite song in your library.</p>
        ${searchBrowseMarkup()}
        <div class="empty-state search-empty-library">
          <h2>No music found</h2>
          <p>Add a music folder to start building your library.</p>
          <button class="pill-btn empty-cta" type="button" data-add-folder>Add music folder</button>
        </div>
      </div>
    `;
  }
  if (emptyLibrary) {
    return `
      <div class="search-landing">
        <p class="search-tagline text-secondary">Find your next favorite song in your library.</p>
        ${searchBrowseMarkup()}
        <div class="empty-state search-empty-library">
          <h2>No music found</h2>
          <p>EMP couldn’t find tracks in your music folders. Add albums there, then refresh your library.</p>
          <button class="pill-btn empty-cta" type="button" data-nav="settings">Open Settings</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="search-landing">
      <p class="search-tagline text-secondary">Find your next favorite song in your library.</p>
      ${searchRecentMarkup()}
      ${searchBrowseMarkup()}
    </div>
  `;
}

function renderSearchResultsBody(results) {
  if (!state.library.tracks.length && !state.playlists.length) {
    return `
      <div class="search-results">
        <div class="empty-state">
          <h2>No music found</h2>
          <p>Add a music folder to start building your library.</p>
          <button class="pill-btn empty-cta" type="button" data-add-folder>Add music folder</button>
        </div>
      </div>
    `;
  }

  if (!results.total) {
    return `
      <div class="search-results search-no-results">
        <h2 class="search-no-results-title">No results for “${escapeHtml(state.query)}”</h2>
        <p class="text-secondary">Try a different song, artist, album, or playlist name.</p>
      </div>
    `;
  }

  resetSearchExpand(results.query);
  const shownArtists = results.artists.slice(0, searchExpand.artists);
  const shownPlaylists = results.playlists.slice(0, searchExpand.playlists);
  const shownAlbums = results.albums.slice(0, searchExpand.albums);
  const shownSongs = results.songs.slice(0, searchExpand.tracks);

  const artistSection = shownArtists.length ? `
    <section class="search-results-section" aria-label="Artists">
      <div class="section-head"><h2>Artists</h2></div>
      <div class="card-grid">${shownArtists.map((item) => searchArtistCard(item.artist)).join("")}</div>
      ${searchShowMoreButton("artists", "artists", shownArtists.length, results.artists.length)}
    </section>
  ` : "";

  const playlistSection = shownPlaylists.length ? `
    <section class="search-results-section" aria-label="Playlists">
      <div class="section-head"><h2>Playlists</h2></div>
      <div class="card-grid">${shownPlaylists.map((item) => playlistCard(item.playlist)).join("")}</div>
      ${searchShowMoreButton("playlists", "playlists", shownPlaylists.length, results.playlists.length)}
    </section>
  ` : "";

  const albumSection = shownAlbums.length ? `
    <section class="search-results-section" aria-label="Albums and singles">
      <div class="section-head"><h2>Albums &amp; singles</h2></div>
      <div class="card-grid search-album-grid">${shownAlbums.map((item) => albumCard(item.album)).join("")}</div>
      ${searchShowMoreButton("albums", "albums", shownAlbums.length, results.albums.length)}
    </section>
  ` : "";

  const songSection = shownSongs.length ? `
    <section class="search-results-section" aria-label="Songs">
      <div class="section-head"><h2>Songs</h2></div>
      ${trackTable(shownSongs.map((item) => item.track), { showAlbum: true })}
      ${searchShowMoreButton("tracks", "songs", shownSongs.length, results.songs.length)}
    </section>
  ` : "";

  return `
    <div class="search-results">
      <div class="visually-hidden" aria-live="polite">${results.total} ${results.total === 1 ? "result" : "results"}</div>
      ${searchTopResultMarkup(results.top)}
      ${artistSection}
      ${playlistSection}
      ${albumSection}
      ${songSection}
    </div>
  `;
}

function renderSearch({ preserveFocus = false, requestId = null } = {}) {
  if (requestId != null && requestId !== searchRequestId) {
    return;
  }

  const queryKey = normalizeSearchQuery(state.query);
  const scrollTop = preserveFocus ? viewArea.scrollTop : 0;
  const activeMore = preserveFocus
    ? document.activeElement?.getAttribute?.("data-search-more") || null
    : null;

  const renderStarted = SEARCH_PERF_ENABLED ? performance.now() : 0;
  let body;
  if (!queryKey) {
    body = renderSearchLanding();
  } else {
    const results = buildSearchResults(state.query);
    const domStarted = SEARCH_PERF_ENABLED ? performance.now() : 0;
    body = renderSearchResultsBody(results);
    if (SEARCH_PERF_ENABLED) {
      console.info(`[EMP search] results markup ${Math.round(performance.now() - domStarted)}ms`);
    }
  }

  viewArea.innerHTML = `
    <div class="search-page">
      <h1 class="greeting">Search</h1>
      ${body}
    </div>
  `;
  if (SEARCH_PERF_ENABLED) {
    console.info(`[EMP search] DOM commit ${Math.round(performance.now() - renderStarted)}ms`);
  }

  if (preserveFocus) {
    viewArea.scrollTop = scrollTop;
    if (activeMore) {
      const button = viewArea.querySelector(`[data-search-more="${activeMore}"]`);
      if (button) {
        button.focus();
      } else {
        const heading = viewArea.querySelector(".search-results-section h2");
        if (heading) {
          heading.setAttribute("tabindex", "-1");
          heading.focus({ preventScroll: true });
        }
      }
    }
  }
}

function expandSearchResults(kind) {
  const key = normalizeSearchQuery(state.query);
  resetSearchExpand(key);
  if (kind === "artists") {
    searchExpand.artists += SEARCH_SHOW_MORE_BATCH;
  } else if (kind === "playlists") {
    searchExpand.playlists += SEARCH_SHOW_MORE_BATCH;
  } else if (kind === "albums") {
    searchExpand.albums += SEARCH_SHOW_MORE_BATCH;
  } else if (kind === "tracks") {
    searchExpand.tracks += SEARCH_SHOW_MORE_BATCH;
  }
  renderSearch({ preserveFocus: true });
}

function renderEqualizerPanel() {
  const presetItems = EQ_PRESET_ORDER.map((id) => {
    const preset = EQ_PRESETS[id];
    const available = isEqPresetAvailable(id);
    const selected = state.equalizerPreset === id;
    return `
      <button class="eq-preset-item${available ? "" : " is-unavailable"}${selected ? " is-selected" : ""}" type="button" role="option" data-eq-preset="${id}" ${available ? "" : "aria-disabled=\"true\" disabled"} title="${available ? escapeHtml(preset.name) : "No verified gain values"}" aria-selected="${selected ? "true" : "false"}">
        ${escapeHtml(preset.name)}${available ? "" : "<span class=\"eq-preset-note\">Unavailable</span>"}
      </button>
    `;
  }).join("");

  const bands = EQ_BANDS.map((band, index) => {
    const gain = state.equalizerGains[index] ?? 0;
    return `
      <div class="eq-band" data-eq-band="${index}">
        <input class="eq-band-input" type="range" min="${EQ_MIN_DB}" max="${EQ_MAX_DB}" step="0.05" value="${gain}" aria-label="${escapeHtml(band.label)}" data-eq-band-input="${index}">
        <button class="eq-handle" type="button" data-eq-handle="${index}" aria-hidden="true" tabindex="-1"></button>
      </div>
    `;
  }).join("");

  const labels = EQ_BANDS.map((band) => `<span class="eq-band-label">${escapeHtml(band.label)}</span>`).join("");

  return `
    <div class="eq-panel">
      <div class="eq-panel-head">
        <span class="eq-presets-label">Presets</span>
        <div class="eq-preset-wrap">
          <button class="eq-preset-button" type="button" data-eq-preset-toggle aria-haspopup="listbox" aria-expanded="false">
            <span data-eq-preset-label>${escapeHtml(eqPresetLabel(state.equalizerPreset))}</span>
            <i class="bi bi-chevron-down" aria-hidden="true"></i>
          </button>
          <div class="eq-preset-menu" hidden role="listbox">${presetItems}</div>
        </div>
      </div>
      <div class="eq-graph" data-eq-graph>
        <span class="eq-scale eq-scale-top">+12dB</span>
        <span class="eq-scale eq-scale-bottom">-12dB</span>
        <svg class="eq-svg" viewBox="0 0 600 220" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="emp-eq-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#1db954" stop-opacity="0.38"></stop>
              <stop offset="100%" stop-color="#1db954" stop-opacity="0.02"></stop>
            </linearGradient>
          </defs>
          <line class="eq-grid-zero" x1="0" y1="110" x2="600" y2="110"></line>
          <g data-eq-grid></g>
          <path class="eq-fill" data-eq-fill></path>
          <path class="eq-line" data-eq-line></path>
        </svg>
        <div class="eq-bands">${bands}</div>
        <div class="eq-band-labels">${labels}</div>
      </div>
      <div class="eq-panel-foot">
        <button class="eq-reset" type="button" data-eq-reset>Reset</button>
      </div>
    </div>
  `;
}

function settingSwitch(key, checked, label) {
  return `
    <button class="emp-switch" type="button" role="switch" aria-checked="${checked ? "true" : "false"}" aria-label="${escapeHtml(label)}" data-setting="${key}"></button>
  `;
}

function audioOutputMenuOptions() {
  const options = [{ id: "", label: "System Default" }];
  const seen = new Set([""]);
  for (const device of audioOutputDevices) {
    const id = typeof device.deviceId === "string" ? device.deviceId : "";
    const label = typeof device.label === "string" ? device.label.trim() : "";
    if (!id || seen.has(id) || !label) {
      continue;
    }
    seen.add(id);
    options.push({ id, label });
  }
  if (state.audioOutputId && !seen.has(state.audioOutputId)) {
    const savedLabel = typeof state.audioOutputLabel === "string" ? state.audioOutputLabel.trim() : "";
    if (savedLabel) {
      options.push({ id: state.audioOutputId, label: savedLabel });
    }
  }
  return options;
}

function audioOutputLabelForId(deviceId) {
  const id = typeof deviceId === "string" ? deviceId : "";
  if (!id) {
    return "System Default";
  }
  const match = audioOutputMenuOptions().find((item) => item.id === id);
  if (match) {
    return match.label;
  }
  const saved = typeof state.audioOutputLabel === "string" ? state.audioOutputLabel.trim() : "";
  return saved || "System Default";
}

function renderAudioOutputSettingRow() {
  if (!audioOutputSupported && !(window.AudioContext && "setSinkId" in window.AudioContext.prototype)) {
    return `
      <div class="settings-row">
        <div class="settings-copy">
          <span class="settings-label">Audio Output</span>
          <span class="settings-desc">Output device selection is not available in this WebView2 runtime.</span>
        </div>
      </div>`;
  }
  audioOutputSupported = true;
  const options = audioOutputMenuOptions();
  const currentId = options.some((item) => item.id === state.audioOutputId) ? state.audioOutputId : "";
  const currentLabel = audioOutputLabelForId(currentId);
  const canPick = typeof navigator.mediaDevices?.selectAudioOutput === "function";
  const items = options.map((item) => {
    const active = item.id === currentId;
    return `
      <button class="songs-sort-item${active ? " active" : ""}" type="button" role="menuitemradio" aria-checked="${active ? "true" : "false"}" data-audio-output="${escapeHtml(item.id)}">
        <span>${escapeHtml(item.label)}</span>
        ${active ? '<i class="bi bi-check2" aria-hidden="true"></i>' : ""}
      </button>`;
  }).join("");
  const pickItem = canPick
    ? `
      <button class="songs-sort-item" type="button" role="menuitem" data-audio-output-pick>
        <span>Choose device…</span>
      </button>`
    : "";

  return `
    <div class="settings-row">
      <div class="settings-copy">
        <span class="settings-label">Audio Output</span>
        <span class="settings-desc">Choose a local playback device when supported.</span>
      </div>
      <div class="songs-sort-wrap settings-audio-output-wrap">
        <button class="songs-sort-button" type="button" data-audio-output-toggle aria-haspopup="menu" aria-expanded="false" aria-label="Audio Output">
          <span data-audio-output-label>${escapeHtml(currentLabel)}</span>
          <i class="bi bi-chevron-down" aria-hidden="true"></i>
        </button>
        <div class="songs-sort-menu settings-audio-output-menu" role="menu" aria-label="Audio Output" hidden>
          ${items}
          ${pickItem}
        </div>
      </div>
    </div>`;
}

let audioOutputLabelProbe = null;

async function enumerateAudioOutputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audiooutput");
}

function audioOutputHasLabels(devices) {
  return devices.some((device) => device.deviceId && String(device.label || "").trim());
}

/**
 * Chromium withholds device labels until a media permission is granted.
 * Probe once with a short-lived audio capture stream (host auto-allows mic).
 */
async function ensureAudioOutputLabels(devices) {
  if (audioOutputHasLabels(devices)) {
    return devices;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return devices;
  }
  if (!audioOutputLabelProbe) {
    audioOutputLabelProbe = (async () => {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
      } catch {
        return false;
      } finally {
        stream?.getTracks?.().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Ignore stop failures after probing.
          }
        });
      }
      return true;
    })().finally(() => {
      // Allow a later retry if the first probe failed before permission was ready.
      window.setTimeout(() => {
        audioOutputLabelProbe = null;
      }, 1500);
    });
  }
  await audioOutputLabelProbe;
  return enumerateAudioOutputDevices();
}

async function refreshAudioOutputDevices() {
  audioOutputSupported = Boolean(window.AudioContext && "setSinkId" in window.AudioContext.prototype);
  if (!audioOutputSupported || !navigator.mediaDevices?.enumerateDevices) {
    audioOutputDevices = [];
    return;
  }
  try {
    let devices = await enumerateAudioOutputDevices();
    devices = await ensureAudioOutputLabels(devices);
    audioOutputDevices = devices;
    const labeledIds = new Set(
      audioOutputDevices
        .filter((device) => device.deviceId && String(device.label || "").trim())
        .map((device) => device.deviceId)
    );
    if (state.audioOutputId
      && state.audioOutputId !== ""
      && !labeledIds.has(state.audioOutputId)
      && !(typeof state.audioOutputLabel === "string" && state.audioOutputLabel.trim())) {
      state.audioOutputId = "";
      state.audioOutputLabel = "";
      writeSession();
      applyAudioOutputDevice();
    } else if (state.audioOutputId) {
      const match = audioOutputDevices.find((device) => device.deviceId === state.audioOutputId);
      const label = match && String(match.label || "").trim();
      if (label) {
        state.audioOutputLabel = label;
      }
    }
  } catch {
    audioOutputDevices = [];
  }
  if (state.view === "settings") {
    renderSettings();
  }
}

async function pickAudioOutputDevice() {
  if (typeof navigator.mediaDevices?.selectAudioOutput !== "function") {
    return;
  }
  try {
    const device = await navigator.mediaDevices.selectAudioOutput();
    if (!device || typeof device.deviceId !== "string") {
      return;
    }
    state.audioOutputLabel = typeof device.label === "string" ? device.label.trim() : "";
    setPlaybackSetting("audioOutputId", device.deviceId);
    await refreshAudioOutputDevices();
  } catch {
    // User cancelled the system picker or the runtime denied it.
  }
}

function closeAudioOutputMenu() {
  viewArea.querySelectorAll(".settings-audio-output-wrap").forEach((wrap) => {
    const menu = wrap.querySelector(".songs-sort-menu");
    const button = wrap.querySelector("[data-audio-output-toggle]");
    if (menu) {
      menu.hidden = true;
    }
    button?.setAttribute("aria-expanded", "false");
    wrap.classList.remove("is-open");
  });
}

function settingSelect(name, value, options) {
  const items = options.map(([id, label]) => {
    const selected = value === id;
    return `
      <button class="eq-preset-item${selected ? " is-selected" : ""}" type="button" role="option" data-${name}="${id}" aria-selected="${selected ? "true" : "false"}">
        ${escapeHtml(label)}
      </button>
    `;
  }).join("");
  const current = options.find(([id]) => id === value)?.[1] ?? options[0]?.[1] ?? "";

  return `
    <div class="eq-preset-wrap">
      <button class="eq-preset-button" type="button" data-${name}-toggle aria-haspopup="listbox" aria-expanded="false">
        <span data-${name}-label>${escapeHtml(current)}</span>
        <i class="bi bi-chevron-down" aria-hidden="true"></i>
      </button>
      <div class="eq-preset-menu" hidden role="listbox">${items}</div>
    </div>
  `;
}

function renderLibrarySettingsGroup() {
  const folders = musicFolders();
  const rows = folders.length
    ? folders.map((folder) => {
        const path = folder.path ?? "";
        const unavailable = folder.available === false;
        return `
          <div class="settings-row settings-folder-row">
            <div class="settings-copy">
              <div class="settings-folder-main">
                <i class="bi bi-folder2 settings-folder-icon" aria-hidden="true"></i>
                <div class="settings-folder-text">
                  <span class="settings-label settings-folder-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
                  ${unavailable ? `<span class="settings-desc">Folder unavailable</span>` : ""}
                </div>
              </div>
            </div>
            <button class="icon-btn" type="button" data-remove-folder="${escapeHtml(path)}" aria-label="Remove folder" title="Remove folder">
              <i class="bi bi-x-lg" aria-hidden="true"></i>
            </button>
          </div>
        `;
      }).join("")
    : `
        <div class="settings-row settings-folder-empty">
          <div class="settings-copy">
            <span class="settings-label">No music folders added</span>
          </div>
        </div>
      `;

  return `
    <section class="settings-group">
      <h2>Library</h2>
      <div class="settings-folder-head">
        <span class="settings-label">Music folders</span>
        <span class="settings-desc">These folders are scanned for music and kept up to date automatically.</span>
      </div>
      ${rows}
      <div class="settings-row settings-folder-actions">
        <button class="eq-reset" type="button" data-add-folder>Add folder</button>
        <div class="settings-rescan">
          <button class="eq-reset settings-rescan-btn" type="button" data-rescan-library${folders.length ? "" : " disabled"}>
            <span class="settings-rescan-label">Rescan library</span>
            <span class="settings-rescan-icons" aria-hidden="true">
              <i class="bi bi-arrow-repeat settings-rescan-spinner"></i>
              <span class="settings-rescan-check"><i class="bi bi-check-lg"></i></span>
            </span>
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderSettings() {
  let equalizerMarkup = "";
  try {
    equalizerMarkup = renderEqualizerPanel();
  } catch {
    equalizerMarkup = "";
  }

  viewArea.innerHTML = `
    <div class="settings-page">
      <h1>Settings</h1>
      <section class="settings-group">
        <h2>Startup and window behaviour</h2>
        <div class="settings-row">
          <div class="settings-copy">
            <span class="settings-label">Open EMP automatically after you log into the computer</span>
          </div>
          ${settingSelect("startup", state.startupOnLogin, [
            ["minimized", "Minimized"],
            ["yes", "Yes"],
            ["no", "No"]
          ])}
        </div>
        <div class="settings-row">
          <div class="settings-copy">
            <span class="settings-label">Close button should minimize the EMP window</span>
          </div>
          ${settingSwitch("closeMinimizes", state.closeMinimizes, "Close button should minimize the EMP window")}
        </div>
      </section>
      ${renderLibrarySettingsGroup()}
      <section class="settings-group">
        <h2>Personalization</h2>
        <div class="settings-row">
          <div class="settings-copy">
            <span class="settings-label">Personalized mixes</span>
            <span class="settings-desc">Create music mixes from your library and listening habits.</span>
          </div>
          ${settingSwitch("personalizedMixes", state.personalizedMixes !== false, "Personalized mixes")}
        </div>
      </section>
      <section class="settings-group">
        <h2>Playback</h2>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-copy">
              <span class="settings-label">Crossfade Songs</span>
            </div>
            ${settingSwitch("crossfade", state.crossfade, "Crossfade Songs")}
          </div>
          ${state.crossfade ? `
          <div class="settings-nested" role="group" aria-label="Crossfade options">
            <div class="settings-nested-row">
              <span class="settings-nested-label">Duration</span>
              <div class="settings-duration-control">
                <input class="slider settings-duration-slider" type="range" min="1" max="12" step="1" value="${clampCrossfadeSeconds(state.crossfadeSeconds)}" aria-label="Crossfade duration" data-crossfade-seconds>
                <span class="settings-duration-value" data-crossfade-seconds-label>${clampCrossfadeSeconds(state.crossfadeSeconds)} sec</span>
              </div>
            </div>
          </div>` : ""}
        </div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-copy">
              <span class="settings-label">Gapless</span>
              <span class="settings-desc">Start the next song with minimal silence. Cannot be used with Crossfade.</span>
            </div>
            ${settingSwitch("gapless", state.gapless, "Gapless")}
          </div>
        </div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-copy">
              <span class="settings-label">Normalize volume</span>
              <span class="settings-desc">Applies ReplayGain tags when available. Songs without ReplayGain metadata play at their original level.</span>
            </div>
            ${settingSwitch("normalizeVolume", state.normalizeVolume, "Normalize volume")}
          </div>
          ${state.normalizeVolume ? `
          <div class="settings-nested" role="group" aria-label="Normalization options">
            <div class="settings-nested-row">
              <span class="settings-nested-label">Mode</span>
              <div class="settings-segmented" role="group" aria-label="Normalization mode">
                <button type="button" class="settings-segment${state.normalizeMode === "track" ? " is-selected" : ""}" data-normalize-mode="track">Track</button>
                <button type="button" class="settings-segment${state.normalizeMode === "album" ? " is-selected" : ""}" data-normalize-mode="album">Album</button>
              </div>
            </div>
            <p class="settings-nested-desc">Album mode uses album tags when present; otherwise track tags.</p>
          </div>` : ""}
        </div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-copy">
              <span class="settings-label">Prevent Clipping</span>
              <span class="settings-desc">Reduce distortion caused by volume normalization and audio enhancements.</span>
            </div>
            ${settingSwitch("preventClipping", state.preventClipping !== false, "Prevent Clipping")}
          </div>
        </div>
        <div class="settings-block">
          ${renderAudioOutputSettingRow()}
        </div>
        ${isRemotePlayback() || isConnectingPlayback() ? `
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-copy">
              <span class="settings-desc">Equalizer, ReplayGain, Prevent Clipping, and audio output apply to local playback only while casting.</span>
            </div>
          </div>
        </div>` : ""}
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-copy">
              <span class="settings-label">Equalizer</span>
            </div>
            ${settingSwitch("equalizerEnabled", state.equalizerEnabled, "Equalizer")}
          </div>
          ${equalizerMarkup}
        </div>
      </section>
      ${renderStorageSettingsGroup()}
      ${renderUpdatesSettingsGroup()}
    </div>
  `;
  try {
    syncEqualizerUi();
  } catch {
    // Settings still render if the graph overlay cannot be drawn.
  }
  window.chrome?.webview?.postMessage({ type: "storage" });
  window.chrome?.webview?.postMessage({ type: "updates", action: "status" });
}

/** Format a byte count with SI (1000) units: B, KB, MB, GB, TB, PB. */
function formatByteSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) {
    return "0 B";
  }
  if (value === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const base = 1000;
  let unitIndex = 0;
  let scaled = value;
  while (scaled >= base && unitIndex < units.length - 1) {
    scaled /= base;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${Math.round(scaled).toLocaleString()} ${units[unitIndex]}`;
  }
  if (scaled < 10) {
    return `${scaled.toFixed(1)} ${units[unitIndex]}`;
  }
  return `${Math.round(scaled).toLocaleString()} ${units[unitIndex]}`;
}

function storageValueText(key) {
  return storageUsage ? formatByteSize(storageUsage[key]) : "Calculating…";
}

function renderStorageSettingsGroup() {
  return `
    <section class="settings-group">
      <h2>Storage</h2>
      <div class="settings-row">
        <div class="settings-copy">
          <span class="settings-label">Music library</span>
          <span class="settings-desc">Audio files in your music folders</span>
        </div>
        <span class="settings-value" data-storage-value="libraryBytes">${storageValueText("libraryBytes")}</span>
      </div>
      <div class="settings-row">
        <div class="settings-copy">
          <span class="settings-label">Cache</span>
          <span class="settings-desc">Album artwork, lyrics and artist info EMP saves so it can load them faster</span>
        </div>
        <span class="settings-value" data-storage-value="cacheBytes">${storageValueText("cacheBytes")}</span>
      </div>
    </section>
  `;
}

function updateStatusCopy() {
  const status = state.updateStatus || {};
  const current = state.appVersion || "…";
  switch (status.state) {
    case "checking":
      return "Checking for updates…";
    case "upToDate":
      return "You're up to date.";
    case "updateAvailable":
      return `Update available: v${status.availableVersion}`;
    case "downloading": {
      const pct = status.progress == null ? "" : ` ${Math.round(Number(status.progress) * 100)}%`;
      return `Downloading update…${pct}`;
    }
    case "ready":
      return `v${status.availableVersion} is ready to install. EMP will restart to finish updating.`;
    case "installing":
      return "Installing update…";
    case "failed":
      return status.error || "Couldn't check for updates. Try again later.";
    default:
      return "Check for updates anytime.";
  }
}

function renderUpdatesSettingsGroup() {
  const status = state.updateStatus || {};
  const actions = [];
  if (status.state === "updateAvailable") {
    actions.push(`<button class="eq-reset" type="button" data-update-action="download">Download Update</button>`);
    actions.push(`<button class="eq-reset" type="button" data-update-action="dismiss">Not Now</button>`);
  } else if (status.state === "ready") {
    actions.push(`<button class="eq-reset" type="button" data-update-action="restartAndUpdate">Restart and Update</button>`);
    actions.push(`<button class="eq-reset" type="button" data-update-action="dismiss">Later</button>`);
  } else if (status.state !== "checking" && status.state !== "downloading" && status.state !== "installing") {
    actions.push(`<button class="eq-reset" type="button" data-update-action="check">Check for Updates</button>`);
  }

  return `
    <section class="settings-group">
      <h2>Updates</h2>
      <div class="settings-row">
        <div class="settings-copy">
          <span class="settings-label">Current version</span>
          <span class="settings-desc">The version of EMP installed on this computer.</span>
        </div>
        <span class="settings-value" data-update-version>${escapeHtml(state.appVersion || "…")}</span>
      </div>
      <div class="settings-row">
        <div class="settings-copy">
          <span class="settings-label">Automatically check for updates</span>
          <span class="settings-desc">Looks for new versions about once a day. Updates never install without asking.</span>
        </div>
        ${settingSwitch("automaticUpdateChecks", state.automaticUpdateChecks !== false, "Automatically check for updates")}
      </div>
      <div class="settings-row settings-update-status-row">
        <div class="settings-copy">
          <span class="settings-label">Status</span>
          <span class="settings-desc" data-update-status>${escapeHtml(updateStatusCopy())}</span>
        </div>
      </div>
      <div class="settings-row settings-folder-actions" data-update-actions>
        ${actions.join("\n        ")}
      </div>
    </section>
  `;
}

function postUpdateAction(action, extra = {}) {
  window.chrome?.webview?.postMessage({ type: "updates", action, ...extra });
}

function applyUpdateStatus(detail) {
  if (!detail || typeof detail !== "object") {
    return;
  }
  if (typeof detail.currentVersion === "string" && detail.currentVersion) {
    state.appVersion = detail.currentVersion;
  }
  if (typeof detail.automaticUpdateChecks === "boolean") {
    state.automaticUpdateChecks = detail.automaticUpdateChecks;
  }
  state.updateStatus = {
    state: detail.state || "idle",
    availableVersion: detail.availableVersion || null,
    progress: detail.progress == null ? null : Number(detail.progress),
    error: detail.error || null,
    dismissedUpdateVersion: detail.dismissedUpdateVersion || null
  };
  syncUpdatesSettingsUi();
  syncUpdateToast();
}

function updateSettingsNavBadge() {
  const nav = document.querySelector('[data-nav="settings"]');
  if (!nav) {
    return;
  }
  const hasUpdate = state.updateStatus?.state === "updateAvailable" || state.updateStatus?.state === "ready";
  nav.classList.toggle("has-update", Boolean(hasUpdate));
}

function shouldShowUpdateToast() {
  if (!updateUiShellReady) {
    return false;
  }
  const status = state.updateStatus || {};
  if (status.state !== "updateAvailable") {
    return false;
  }
  const version = status.availableVersion;
  if (!version) {
    return false;
  }
  if (updateToastSessionDismissedVersion && updateToastSessionDismissedVersion === version) {
    return false;
  }
  if (status.dismissedUpdateVersion && status.dismissedUpdateVersion === version) {
    return false;
  }
  return true;
}

function syncUpdateToast() {
  const toast = document.getElementById("updateToast");
  if (!toast) {
    return;
  }
  const show = shouldShowUpdateToast();
  toast.hidden = !show;
  if (!show) {
    return;
  }
  const message = toast.querySelector("[data-update-toast-message]");
  const version = state.updateStatus?.availableVersion;
  if (message && version) {
    message.textContent = `EMP v${version} is available`;
  }
}

function dismissUpdateToast() {
  const version = state.updateStatus?.availableVersion;
  if (version) {
    updateToastSessionDismissedVersion = version;
  }
  const toast = document.getElementById("updateToast");
  if (toast) {
    toast.hidden = true;
  }
  // Persist dismissal without clearing updateAvailable / Settings badge.
  postUpdateAction("dismissNotification");
}

function applyStorageUsage(detail) {
  storageUsage = {
    libraryBytes: Number(detail?.libraryBytes) || 0,
    cacheBytes: Number(detail?.cacheBytes) || 0
  };
  if (state.view !== "settings") {
    return;
  }
  viewArea.querySelectorAll("[data-storage-value]").forEach((el) => {
    el.textContent = storageValueText(el.dataset.storageValue);
  });
}

function renderAlbum(albumId) {
  const album = albumById(albumId);
  if (!album) {
    renderHome();
    return;
  }

  const tracks = album.trackIds
    .map(trackById)
    .filter(Boolean)
    .sort((left, right) => (left.trackNumber || 0) - (right.trackNumber || 0) || compareText(left.title, right.title));
  const totalDuration = tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  setStageAccent(album.color, 420);
  setStageAccentFromArt(album.coverUrl, album.color, 420);

  viewArea.innerHTML = `
    <div class="album-page">
      <div class="album-page-content">
        <div class="album-hero">
          ${coverMarkup(album, "album-hero-cover")}
          <div class="album-hero-text">
            <div class="album-kicker">${album.isSingle ? "Single" : "Album"}</div>
            <h1>${escapeHtml(album.title)}</h1>
            <div class="album-meta">
              ${coverMarkup(album, "album-meta-avatar")}
              <button class="inline-link album-artist-link" type="button" data-open-artist="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</button>
              ${album.year ? `<span class="album-meta-dot">•</span><span>${album.year}</span>` : ""}
              <span class="album-meta-dot">•</span>
              <span>${songLabel(tracks.length)}</span>
              <span class="album-meta-dot">•</span>
              <span>${formatCollectionDuration(totalDuration)}</span>
            </div>
          </div>
        </div>
        ${collectionActionsMarkup(album.title, `data-play-album="${album.id}"`, { albumMore: true })}
      </div>
      <div class="track-panel">
        ${trackTable(tracks, { showAlbum: false, showCover: false, showHeader: true })}
      </div>
    </div>
  `;
}

function renderPlaylist(playlistId) {
  const playlist = playlistById(playlistId);
  if (!playlist) {
    renderHome();
    return;
  }

  ensureSmartDateRelativeFreshness();
  const smart = isSmartPlaylist(playlist);
  const loadError = smart && playlist.smart?.loadError;
  const tracks = loadError ? [] : playlistTracks(playlist);
  const cover = playlistCoverItem(playlist);
  const totalDuration = tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  const album = albumById(tracks[0]?.albumId);
  const playlistFallback = isLikedPlaylist(playlist) ? "#450af5" : (album?.color || cover.color || "#3a1f12");
  setStageAccent(playlistFallback, 420);
  if (!isLikedPlaylist(playlist)) {
    const artUrl = cover.coverUrl || album?.coverUrl;
    setStageAccentFromArt(artUrl, playlistFallback, 420);
  }

  let emptyMarkup = "";
  if (!tracks.length) {
    if (loadError) {
      emptyMarkup = `
        <div class="smart-empty-state">
          <h3>Couldn't load these rules</h3>
          <p>This smart playlist definition couldn't be evaluated. Your playlist was kept — try editing the rules.</p>
          <button class="smart-btn-primary" type="button" data-smart-edit-rules>Edit Rules</button>
        </div>`;
    } else if (smart) {
      emptyMarkup = `
        <div class="smart-empty-state">
          <h3>No matching songs</h3>
          <p>Try adjusting your rules to include more of your library.</p>
          <button class="smart-btn-primary" type="button" data-smart-edit-rules>Edit Rules</button>
        </div>`;
    } else {
      emptyMarkup = `<p class="text-secondary">This playlist is empty. Right-click a track on an album to add songs.</p>`;
    }
  }

  const description = playlist.description
    ? `<div class="album-meta" style="margin-top:6px;opacity:.85">${escapeHtml(playlist.description)}</div>`
    : "";

  viewArea.innerHTML = `
    <div class="album-page">
      <div class="album-page-content">
        <div class="album-hero">
          ${playlistCoverMarkup(playlist, "album-hero-cover")}
          <div class="album-hero-text">
            <div class="album-kicker">${smart ? "Smart Playlist" : "Playlist"}</div>
            <h1>${escapeHtml(playlist.name)}</h1>
            <div class="album-meta">
              <span>${songLabel(tracks.length)}</span>
              <span class="album-meta-dot">•</span>
              <span>${formatCollectionDuration(totalDuration)}</span>
            </div>
            ${description}
          </div>
        </div>
        ${collectionActionsMarkup(playlist.name, `data-play-playlist="${playlist.id}"`, { more: true })}
        ${emptyMarkup}
      </div>
      ${tracks.length
        ? `<div class="track-panel">${trackTable(tracks, { showAlbum: true, showCover: true, showHeader: true })}</div>`
        : ""}
    </div>
  `;
}

function renderMix(mixId) {
  if (state.personalizedMixes === false) {
    renderHome();
    return;
  }
  ensurePersonalizedMixes();
  const mix = mixById(mixId);
  if (!mix) {
    renderHome();
    return;
  }

  const tracks = mixTracks(mix);
  const totalDuration = tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  const accentAlbum = albumById(tracks[0]?.albumId);
  const fallback = accentAlbum?.color || "#1e3b2a";
  setStageAccent(fallback, 420);
  setStageAccentFromArt(tracks[0]?.coverUrl || accentAlbum?.coverUrl, fallback, 420);

  viewArea.innerHTML = `
    <div class="album-page">
      <div class="album-page-content">
        <div class="album-hero">
          ${mixCoverMarkup(mix, "album-hero-cover")}
          <div class="album-hero-text">
            <div class="album-kicker">Mix</div>
            <h1>${escapeHtml(mix.title)}</h1>
            <p class="mix-detail-desc">${escapeHtml(mix.description || "")}</p>
            <div class="album-meta">
              <span>${songLabel(tracks.length)}</span>
              <span class="album-meta-dot">•</span>
              <span>${formatCollectionDuration(totalDuration)}</span>
            </div>
          </div>
        </div>
        ${tracks.length ? collectionActionsMarkup(mix.title, `data-play-mix="${escapeHtml(mix.id)}"`) : ""}
        ${tracks.length
          ? ""
          : `<p class="text-secondary">This mix has no playable tracks right now.</p>`}
      </div>
      ${tracks.length
        ? `<div class="track-panel">${trackTable(tracks, { showAlbum: true, showCover: true, showHeader: true })}</div>`
        : ""}
    </div>
  `;
}

function renderMixes() {
  if (state.personalizedMixes === false) {
    renderHome();
    return;
  }
  const mixes = ensurePersonalizedMixes();
  if (!mixes.length) {
    viewArea.innerHTML = `
      <div class="home-page">
        <h1 class="greeting">Your Mixes</h1>
        <p class="text-secondary">Mixes will appear as you listen to music in your library.</p>
      </div>
    `;
    return;
  }
  setStageAccent("#1e3b2a");
  viewArea.innerHTML = `
    <div class="home-page">
      <h1 class="greeting">Your Mixes</h1>
      <p class="collection-stat">${mixes.length} ${mixes.length === 1 ? "mix" : "mixes"}</p>
      <div class="card-grid">${mixes.map(mixCard).join("")}</div>
    </div>
  `;
}

function renderArtist(name) {
  if (!name) {
    renderHome();
    return;
  }

  const albums = sortAlbums(albumsByArtist(name));
  const tracks = [...tracksByArtist(name)].sort((left, right) => {
    const album = compareText(left.album, right.album);
    if (album !== 0) {
      return album;
    }
    return (left.trackNumber || 0) - (right.trackNumber || 0) || compareText(left.title, right.title);
  });
  const accent = albums[0]?.color || tracks[0]?.color || "#3a1f12";
  const artistArtUrl = albums[0]?.coverUrl || tracks[0]?.coverUrl;
  setStageAccent(accent, 420);
  setStageAccentFromArt(artistArtUrl, accent, 420);

  viewArea.innerHTML = `
    <div class="album-page">
      <div class="album-page-content">
        <div class="album-hero">
          ${coverMarkup(albums[0] || tracks[0], "album-hero-cover")}
          <div class="album-hero-text">
            <div class="album-kicker">Artist</div>
            <h1>${escapeHtml(name)}</h1>
            <div class="artist-profile" data-artist-profile aria-live="polite"></div>
            <div class="album-meta">
              <span>${albums.length} ${albums.length === 1 ? "release" : "releases"}</span>
              <span class="album-meta-dot">•</span>
              <span>${songLabel(tracks.length)}</span>
            </div>
          </div>
        </div>
        ${tracks.length ? collectionActionsMarkup(name, `data-play-artist="${escapeHtml(name)}"`) : ""}
        ${albums.length ? `
          <div class="section-head">
            <h2>Discography</h2>
          </div>
          <div class="card-grid">${albums.map(albumCard).join("")}</div>
        ` : ""}
        ${tracks.length ? `
          <div class="section-head">
            <h2>Songs</h2>
          </div>
        ` : `<p class="text-secondary">No music found for this artist.</p>`}
      </div>
      ${tracks.length ? `
        <div class="track-panel">
          ${trackTable(tracks, { showAlbum: true, showHeader: true })}
        </div>
      ` : ""}
    </div>
  `;

  requestArtistInfo(name);
}

function requestArtistInfo(name) {
  const requestId = ++artistInfoRequestId;
  const key = String(name || "").toLowerCase();
  artistInfoPendingName = name;

  const cached = artistInfoCache.get(key);
  if (cached && hasArtistProfileData(cached)) {
    applyArtistInfo(cached, { fromCache: true });
    return;
  }

  if (artistInfoEmptyCache.has(key)) {
    clearArtistProfile();
    return;
  }

  showArtistInfoLoading();
  window.chrome?.webview?.postMessage({ type: "artistInfo", name });
  window.setTimeout(() => {
    // Host does not echo request IDs — guard with local requestId + view/artist.
    if (requestId !== artistInfoRequestId) {
      return;
    }
    if (state.view !== "artist" || !artistsMatch(name, state.artist)) {
      return;
    }

    const slot = artistProfileSlot();
    if (slot?.querySelector(".artist-profile-loading")) {
      // Timeout/no response: clear skeleton only; leave retryable (no empty cache).
      clearArtistProfile();
    }
  }, ARTIST_INFO_TIMEOUT_MS);
}

function applyArtistInfo(info, { fromCache = false } = {}) {
  // Malformed host payloads: ignore without caching (remain retryable).
  if (!info?.name || typeof info.name !== "string") {
    return;
  }

  const key = info.name.toLowerCase();
  const hasData = hasArtistProfileData(info);

  // Session caches update from well-formed host replies even if the user navigated away.
  // Timeouts never call this path, so they stay retryable.
  if (!fromCache) {
    if (hasData) {
      artistInfoCache.set(key, info);
      artistInfoEmptyCache.delete(key);
    } else if (!hasArtistProfileData(artistInfoCache.get(key))) {
      // Confirmed empty lookup only — do not overwrite a prior positive cache.
      artistInfoEmptyCache.add(key);
    }
  }

  // Preserve host contract (no requestId echo). Never mutate another artist's UI.
  if (state.view !== "artist" || !artistsMatch(info.name, state.artist)) {
    return;
  }

  if (!fromCache && artistInfoPendingName && !artistsMatch(info.name, artistInfoPendingName)) {
    return;
  }

  const slot = artistProfileSlot();
  if (!slot) {
    return;
  }

  if (hasData) {
    const html = artistProfileMarkup(info);
    if (!html) {
      if (slot.querySelector(".artist-profile-loading")) {
        clearArtistProfile();
      }
      return;
    }

    const wasLoading = Boolean(slot.querySelector(".artist-profile-loading"));
    slot.classList.remove("is-loading");
    slot.setAttribute("aria-busy", "false");
    slot.innerHTML = wasLoading
      ? `<div class="artist-profile-ready">${html}</div>`
      : html;
    return;
  }

  // Empty host reply: drop skeleton only. Never clear already-rendered metadata
  // if a late empty arrives after a good response.
  if (slot.querySelector(".artist-profile-loading")) {
    clearArtistProfile();
  }
}

function showArtistInfoLoading() {
  const slot = artistProfileSlot();
  if (!slot) {
    return;
  }

  slot.classList.add("is-loading");
  slot.setAttribute("aria-busy", "true");
  slot.innerHTML = `
    <div class="artist-profile-loading" aria-hidden="true">
      <div class="artist-skeleton artist-skeleton-genres"></div>
      <div class="artist-skeleton artist-skeleton-origin"></div>
    </div>
  `;
}

function clearArtistProfile() {
  const slot = artistProfileSlot();
  if (!slot) {
    return;
  }

  slot.classList.remove("is-loading");
  slot.setAttribute("aria-busy", "false");
  slot.innerHTML = "";
}

function artistProfileSlot() {
  return viewArea.querySelector("[data-artist-profile]");
}

function hasArtistProfileData(info) {
  const genres = Array.isArray(info?.genres) ? info.genres.filter(Boolean) : [];
  return genres.length > 0 || Boolean(info?.beginYear) || Boolean(info?.area);
}

function artistProfileMarkup(info) {
  const genres = Array.isArray(info.genres) ? info.genres.filter(Boolean) : [];
  const origin = artistOriginText(info);
  const parts = [];

  if (genres.length) {
    parts.push(`<div class="artist-genres">${genres.map((genre, index) =>
      `${index ? `<span class="album-meta-dot">•</span>` : ""}<span>${escapeHtml(genre)}</span>`
    ).join("")}</div>`);
  }

  if (origin) {
    parts.push(`<div class="artist-origin">${origin}</div>`);
  }

  return parts.join("");
}

function artistOriginText(info) {
  const label = info.originLabel || "Formed";
  const year = info.beginYear;
  const area = info.area;
  if (year && area) {
    return `${escapeHtml(label)}: ${escapeHtml(year)} · ${escapeHtml(area)}`;
  }
  if (year) {
    return `${escapeHtml(label)}: ${escapeHtml(year)}`;
  }
  if (area) {
    return escapeHtml(area);
  }
  return "";
}

function renderLyrics() {
  const track = currentTrack();
  const trackId = track?.id ?? null;
  lyricsTrackId = trackId;
  const album = track ? albumById(track.albumId) : null;
  const coverUrl = track?.coverUrl || album?.coverUrl || "";
  const fallback = lyricsBackgroundColor(album?.color || LYRICS_FALLBACK_COLOR);

  setStageSolid(coverUrl ? lyricsBackgroundColor(LYRICS_FALLBACK_COLOR) : fallback);
  if (coverUrl) {
    const seq = renderSeq;
    extractVibrantColor(coverUrl).then((color) => {
      if (seq === renderSeq && lyricsTrackId === trackId) {
        setStageSolid(color ? lyricsBackgroundColor(color) : fallback);
      }
    });
  }

  // While a track change is still debouncing, syncLyricsRequests will ask for this track.
  if (track && !lyricsRequestTimer) {
    requestLyrics(track.id);
  }
  renderLyricsContent();
}

function lyricsTrackChip(track) {
  const album = albumById(track.albumId);
  const coverUrl = track.coverUrl || album?.coverUrl || "";
  return `
    <div class="lyrics-track">
      ${coverMarkup(coverUrl ? { ...track, coverUrl } : album || track, "lyrics-track-cover")}
      <div class="lyrics-track-copy">
        <span class="lyrics-track-title">${escapeHtml(track.title)}</span>
        <span class="lyrics-track-artist">${escapeHtml(track.artist)}</span>
      </div>
    </div>
  `;
}

function lyricsMessageMarkup(track, title, body) {
  return `
    <div class="lyrics-page">
      <div class="lyrics-empty">
        ${lyricsTrackChip(track)}
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(body)}</p>
      </div>
    </div>
  `;
}

function renderLyricsContent() {
  const track = currentTrack();
  lyricsLines = [];
  lyricsActiveIndex = -1;
  lyricsUserScrollUntil = 0;

  if (!track) {
    viewArea.innerHTML = `
      <div class="lyrics-page">
        <div class="lyrics-empty">
          <h1>Play a song to see lyrics</h1>
          <p>Lyrics for whatever's playing will show up here.</p>
        </div>
      </div>
    `;
    return;
  }

  const entry = lyricsEntries.get(track.id);
  if (!entry || entry.status === "loading") {
    viewArea.innerHTML = `
      <div class="lyrics-page">
        <div class="lyrics-empty" aria-busy="true">
          ${lyricsTrackChip(track)}
          <div class="lyrics-skeleton" aria-hidden="true">
            <span></span><span></span><span></span><span></span>
          </div>
          <p class="visually-hidden" role="status">Loading lyrics</p>
        </div>
      </div>
    `;
    return;
  }

  if (entry.status === "ready" && entry.synced) {
    lyricsLines = entry.lines;
    const rows = entry.lines.map((line, index) => (line.text
      ? `<p class="lyrics-line" data-lyric-index="${index}">${escapeHtml(line.text)}</p>`
      : `<p class="lyrics-line is-break" data-lyric-index="${index}" aria-label="Instrumental break">♪</p>`
    )).join("");
    viewArea.innerHTML = `
      <div class="lyrics-page has-lyrics">
        ${lyricsTrackChip(track)}
        <div class="lyrics-lines is-synced">${rows}</div>
      </div>
    `;
    viewArea.scrollTop = 0;
    syncLyricsPosition({ force: true, instant: true });
    return;
  }

  if (entry.status === "ready") {
    viewArea.innerHTML = `
      <div class="lyrics-page has-lyrics">
        ${lyricsTrackChip(track)}
        <div class="lyrics-lines is-plain">${escapeHtml(entry.plain)}</div>
      </div>
    `;
    viewArea.scrollTop = 0;
    return;
  }

  if (entry.status === "instrumental") {
    viewArea.innerHTML = lyricsMessageMarkup(track, "Instrumental", "This track doesn't have any lyrics.");
    return;
  }

  viewArea.innerHTML = lyricsMessageMarkup(
    track,
    "Lyrics aren't available for this song",
    "When lyrics are available for this song, they'll appear here."
  );
}

function setLyricsEntry(trackId, entry) {
  lyricsEntries.delete(trackId);
  lyricsEntries.set(trackId, entry);
  const currentId = currentTrack()?.id;
  for (const key of lyricsEntries.keys()) {
    if (lyricsEntries.size <= LYRICS_ENTRY_LIMIT) {
      break;
    }
    if (key !== currentId && key !== trackId) {
      lyricsEntries.delete(key);
    }
  }
}

function requestLyrics(trackId) {
  if (!trackId || !trackById(trackId)) {
    return;
  }
  const entry = lyricsEntries.get(trackId);
  // Plain-only cache may still receive a background synchronized upgrade from the host.
  // Soft-refresh without a loading skeleton so the host can schedule that check.
  if (entry?.status === "ready" && !entry.synced) {
    window.chrome?.webview?.postMessage({ type: "lyrics", trackId });
    return;
  }
  if (entry && !(entry.retryable && Date.now() - entry.at > LYRICS_RETRY_MS)) {
    return;
  }
  setLyricsEntry(trackId, { status: "loading", at: Date.now() });
  window.chrome?.webview?.postMessage({ type: "lyrics", trackId });
}

function syncLyricsRequests() {
  const currentId = currentTrack()?.id ?? null;
  let nextId = currentId && state.repeat !== "one"
    ? peekNextId({ wrap: state.repeat === "all" })
    : null;
  if (nextId === currentId) {
    nextId = null;
  }

  const key = `${currentId ?? ""}|${nextId ?? ""}`;
  if (key === lyricsRequestKey) {
    return;
  }
  lyricsRequestKey = key;
  window.clearTimeout(lyricsRequestTimer);
  lyricsRequestTimer = window.setTimeout(() => {
    lyricsRequestTimer = 0;
    requestLyrics(currentId);
    requestLyrics(nextId);
  }, LYRICS_REQUEST_DELAY_MS);
}

function trimBlankLines(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").trimEnd();
}

function applyLyricsResult(detail) {
  const trackId = typeof detail?.trackId === "string" ? detail.trackId : "";
  if (!trackId) {
    return;
  }

  const previous = lyricsEntries.get(trackId);
  const plain = trimBlankLines(detail.plainLyrics);
  let entry;
  if (!detail.available) {
    entry = { status: "unavailable", retryable: Boolean(detail.retryable) };
  } else {
    const lines = detail.synced ? parseSyncedLyrics(detail.syncedLyrics) : [];
    if (lines.length) {
      entry = { status: "ready", synced: true, lines, plain };
    } else if (plain) {
      entry = { status: "ready", synced: false, plain };
    } else if (detail.instrumental) {
      entry = { status: "instrumental" };
    } else {
      entry = { status: "unavailable", retryable: false };
    }
  }
  entry.at = Date.now();
  setLyricsEntry(trackId, entry);

  // Soft-refresh of unchanged lyrics must not reset scroll or flash the page.
  // Plain→synced upgrades fall through and re-render with the active line synced.
  const samePlain = previous?.status === "ready"
    && !previous.synced
    && entry.status === "ready"
    && !entry.synced
    && previous.plain === entry.plain;
  const sameSynced = previous?.status === "ready"
    && previous.synced
    && entry.status === "ready"
    && entry.synced;
  if (samePlain || sameSynced) {
    return;
  }

  // Responses for songs that are no longer playing only update the cache, never the page.
  if (state.view === "lyrics" && currentTrack()?.id === trackId && lyricsTrackId === trackId) {
    renderLyricsContent();
  }
}

function parseLrcTime(minutes, seconds, fraction) {
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs >= 60) {
    return null;
  }
  return Number(minutes) * 60 + secs + (fraction ? Number(`0.${fraction}`) : 0);
}

function parseSyncedLyrics(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }

  const timeTag = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
  let offset = 0;
  const parsed = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let rest = raw.trim();
    if (!rest.startsWith("[")) {
      continue;
    }

    const times = [];
    let match = timeTag.exec(rest);
    while (match) {
      const time = parseLrcTime(match[1], match[2], match[3]);
      if (time !== null) {
        times.push(time);
      }
      rest = rest.slice(match[0].length).trimStart();
      match = timeTag.exec(rest);
    }

    if (!times.length) {
      // Metadata such as [ar:], [ti:] or [length:]; only [offset:] affects timing.
      const offsetTag = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(rest);
      if (offsetTag) {
        offset = Number(offsetTag[1]) / 1000;
      }
      continue;
    }

    const lyric = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").replace(/\s+/g, " ").trim();
    for (const time of times) {
      parsed.push({ time, text: lyric });
    }
  }

  // A positive LRC offset means the lyrics should appear earlier.
  const sorted = parsed
    .map((line) => ({ time: Math.max(0, line.time - offset), text: line.text }))
    .sort((left, right) => left.time - right.time);

  const lines = [];
  for (const line of sorted) {
    const previous = lines[lines.length - 1];
    if (!line.text && (!previous || !previous.text)) {
      continue;
    }
    lines.push(line);
  }
  return lines.some((line) => line.text) ? lines : [];
}

function activeLyricIndex(lines, position) {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= position) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function scrollLyricIntoView(row, instant) {
  const areaRect = viewArea.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const top = viewArea.scrollTop
    + (rowRect.top - areaRect.top)
    - viewArea.clientHeight * LYRICS_FOCUS_RATIO
    + rowRect.height / 2;
  viewArea.scrollTo({
    top: Math.max(0, top),
    behavior: instant || prefersReducedMotion() ? "auto" : "smooth"
  });
}

function syncLyricsPosition({ force = false, instant = false } = {}) {
  if (state.view !== "lyrics" || !lyricsLines.length) {
    return;
  }
  const container = viewArea.querySelector(".lyrics-lines.is-synced");
  if (!container) {
    return;
  }

  const index = activeLyricIndex(lyricsLines, playbackPosition());
  if (index === lyricsActiveIndex && !force) {
    return;
  }
  lyricsActiveIndex = index;
  const rows = container.children;
  for (let i = 0; i < rows.length; i += 1) {
    rows[i].classList.toggle("is-active", i === index);
    rows[i].classList.toggle("is-past", i < index);
  }

  if (force) {
    lyricsUserScrollUntil = 0;
  } else if (Date.now() < lyricsUserScrollUntil) {
    return;
  }

  if (index >= 0 && rows[index]) {
    scrollLyricIntoView(rows[index], instant);
  } else if (force) {
    viewArea.scrollTo({ top: 0, behavior: instant || prefersReducedMotion() ? "auto" : "smooth" });
  }
}

function suspendLyricsFollow() {
  if (state.view === "lyrics" && lyricsLines.length) {
    lyricsUserScrollUntil = Date.now() + LYRICS_USER_SCROLL_MS;
  }
}

function syncLyricsButton() {
  const open = state.view === "lyrics";
  lyricsBtn?.classList.toggle("active", open);
  lyricsBtn?.setAttribute("aria-pressed", open ? "true" : "false");
}

function syncLyricsView() {
  syncLyricsButton();
  if (state.view === "lyrics" && (currentTrack()?.id ?? null) !== lyricsTrackId) {
    renderSeq += 1;
    renderLyrics();
  }
}

function toggleLyricsView() {
  if (state.view !== "lyrics") {
    navigate({ view: "lyrics" });
    return;
  }
  if (historyIndex > 0) {
    historyIndex -= 1;
    render(historyStack[historyIndex]);
  } else {
    navigate({ view: "home" });
  }
}

function renderEmpty() {
  const hasFolders = musicFolders().length > 0;
  viewArea.innerHTML = `
    <div class="empty-state">
      <h2>No music found</h2>
      <p>${hasFolders
        ? "EMP couldn’t find tracks in your music folders. Add albums there, then refresh your library."
        : "Add a music folder to start building your library."}</p>
      ${hasFolders
        ? `<button class="pill-btn empty-cta" type="button" data-nav="settings">Open Settings</button>`
        : `<button class="pill-btn empty-cta" type="button" data-add-folder>Add music folder</button>`}
    </div>
  `;
}

function trackRow(track, index, showAlbum, currentId, showCover = true) {
  const current = currentId === track.id;
  const playing = current && state.playing;
  return `
    <div class="track-row${showAlbum ? " with-album" : ""}${showCover ? "" : " no-cover"}${current ? " playing" : ""}${playing ? " is-playing" : ""}" data-play-id="${track.id}">
      <div class="track-index">
        <span class="track-index-number">${index + 1}</span>
        <i class="bi bi-play-fill track-play-icon"></i>
        ${nowEqMarkup("now-eq track-eq")}
      </div>
      <div class="track-main">${showCover ? coverMarkup(track, "playlist-cover") : ""}<span class="track-copy">
          <button class="track-title-btn" type="button" data-play-id="${track.id}">
            <span class="track-name${currentId === track.id ? " playing" : ""}">${escapeHtml(track.title)}</span>
          </button>
          <button class="track-link" type="button" data-open-artist="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</button>
        </span></div>
      ${showAlbum ? `<button class="track-link track-album" type="button" data-open-album="${track.albumId}">${escapeHtml(track.album)}</button>` : ""}
      <div class="track-duration">${formatTime(track.duration)}</div>
    </div>
  `;
}

function trackTableHead(showAlbum, showCover = true) {
  return `
    <div class="track-table-head${showAlbum ? " with-album" : ""}${showCover ? "" : " no-cover"}">
      <div class="track-index">#</div>
      <div class="track-main">Title</div>
      ${showAlbum ? "<div>Album</div>" : ""}
      <div class="track-duration-head" aria-label="Duration"><i class="bi bi-clock"></i></div>
    </div>
  `;
}

function trackTable(tracks, { showAlbum, showCover = true, showHeader = false }) {
  const currentId = currentTrack()?.id;
  return `
    <div class="track-table${showAlbum ? " with-album" : ""}${showCover ? "" : " no-cover"}">
      ${showHeader ? trackTableHead(showAlbum, showCover) : ""}
      ${tracks.map((track, index) => trackRow(track, index, showAlbum, currentId, showCover)).join("")}
    </div>
  `;
}

function mountTrackVirtual(tracks, showAlbum) {
  const table = document.getElementById("virtualTrackTable");
  const spacer = document.getElementById("virtualTrackSpacer");
  if (!table || !spacer) {
    return;
  }

  spacer.style.height = `${tracks.length * TRACK_ROW_HEIGHT}px`;

  const paint = () => {
    const currentId = currentTrack()?.id;
    const tableTop = table.offsetTop;
    const start = Math.max(0, Math.floor((viewArea.scrollTop - tableTop) / TRACK_ROW_HEIGHT) - 12);
    const visible = Math.ceil(viewArea.clientHeight / TRACK_ROW_HEIGHT) + 24;
    const end = Math.min(tracks.length, start + visible);
    const slice = tracks.slice(start, end);

    table.querySelectorAll(".track-row").forEach((row) => row.remove());
    spacer.insertAdjacentHTML("afterend", slice.map((track, index) => trackRow(track, start + index, showAlbum, currentId)).join(""));
    table.querySelectorAll(".track-row").forEach((row, index) => {
      row.style.top = `${(start + index) * TRACK_ROW_HEIGHT}px`;
      row.style.height = `${TRACK_ROW_HEIGHT}px`;
    });
    syncCoverImages(table);
  };

  const onScroll = () => paint();
  viewArea.addEventListener("scroll", onScroll, { passive: true });
  trackVirtual = { onScroll, paint };
  paint();
}

function highlightPlaying() {
  const id = currentTrack()?.id;
  document.querySelectorAll(".track-row").forEach((row) => {
    const current = row.dataset.playId === id;
    row.classList.toggle("playing", current);
    row.classList.toggle("is-playing", current && state.playing);
  });
  document.querySelectorAll(".track-name").forEach((name) => {
    const row = name.closest(".track-row");
    name.classList.toggle("playing", row?.dataset.playId === id);
  });
  syncSidebarPlaying();
  syncHomePlaying();
}

function syncSidebarPlaying() {
  if (!libraryList) {
    return;
  }

  libraryList.querySelectorAll(".playlist-row").forEach((row) => {
    const item = row.querySelector(".playlist-item");
    const play = row.querySelector(".playlist-play");
    if (!item) {
      return;
    }

    let playing = false;
    if (item.dataset.playId) {
      playing = isSidebarTrackPlaying(item.dataset.playId);
      item.classList.toggle("active", currentTrack()?.id === item.dataset.playId);
    } else if (item.dataset.openAlbum) {
      playing = isSidebarAlbumPlaying(item.dataset.openAlbum);
    } else if (item.dataset.openPlaylist) {
      playing = isSidebarPlaylistPlaying(item.dataset.openPlaylist);
    }

    row.classList.toggle("is-playing", playing);
    play?.classList.toggle("is-playing", playing);
  });
}

function syncHomePlaying() {
  if (state.view !== "home" || !viewArea) {
    return;
  }

  viewArea.querySelectorAll(".quick-card-wrap").forEach((wrap) => {
    const openAlbum = wrap.querySelector("[data-open-album]");
    const openPlaylist = wrap.querySelector("[data-open-playlist]");
    const fab = wrap.querySelector(".quick-play-fab");
    let playing = false;
    if (openAlbum) {
      playing = isSidebarAlbumPlaying(openAlbum.dataset.openAlbum);
    } else if (openPlaylist) {
      playing = isSidebarPlaylistPlaying(openPlaylist.dataset.openPlaylist);
    }

    wrap.classList.toggle("is-playing", playing);
    if (fab) {
      fab.classList.toggle("is-playing", playing);
      fab.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
      fab.title = playing ? "Pause" : "Play";
      const label = wrap.querySelector(".quick-title")?.textContent || "";
      fab.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${label}`);
    }

    let eq = wrap.querySelector(".quick-eq");
    if (playing && !eq) {
      const card = wrap.querySelector(".quick-card");
      const title = card?.querySelector(".quick-title");
      if (card && title) {
        title.insertAdjacentHTML("beforebegin", nowEqMarkup("now-eq quick-eq"));
      }
    } else if (!playing && eq) {
      eq.remove();
    }
  });

  viewArea.querySelectorAll(".home-shelf .media-card").forEach((card) => {
    let playing = false;
    let label = "";
    if (card.dataset.openAlbum) {
      playing = isSidebarAlbumPlaying(card.dataset.openAlbum);
      label = card.querySelector(".media-title")?.textContent || "";
    } else if (card.dataset.openPlaylist) {
      playing = isSidebarPlaylistPlaying(card.dataset.openPlaylist);
      label = card.querySelector(".media-title")?.textContent || "";
    } else if (card.dataset.openMix) {
      playing = isMixQueuePlaying(card.dataset.openMix);
      label = card.querySelector(".media-title")?.textContent || "";
    } else {
      return;
    }

    const fab = card.querySelector(".play-fab");
    card.classList.toggle("is-playing", playing);
    if (fab) {
      fab.classList.toggle("is-playing", playing);
      fab.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
      fab.title = playing ? "Pause" : "Play";
      if (label) {
        fab.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${label}`);
      }
    }
  });
}

function blurHomePlayControl(target) {
  const control = target?.closest?.(".play-fab, .quick-play-fab, .playlist-play");
  if (control && typeof control.blur === "function") {
    control.blur();
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function userVolumeGain() {
  if (state.muted) {
    return 0;
  }
  const normalized = Math.max(0, Math.min(1, state.volume / 100));
  return Math.pow(normalized, 2);
}

function trackByPlayer(player) {
  return player?.trackId ? trackById(player.trackId) : null;
}

function computePlayerNormalizeGain(player) {
  if (!state.normalizeVolume || !ReplayGain) {
    return 1;
  }
  return ReplayGain.computeReplayGainLinear(trackByPlayer(player), {
    enabled: true,
    mode: state.normalizeMode
  });
}

function playerOutputGain(player) {
  return player.fade * (Number.isFinite(player.normalize) ? player.normalize : 1);
}

const EQ_RAMP_TIME = 0.018;
const EQ_HEADROOM_POINTS = 48;
let eqDragIndex = -1;

function dbToLinear(db) {
  return 10 ** (db / 20);
}

function eqBiquadCoeffs(kind, hz, db, sampleRate) {
  const A = 10 ** (db / 40);
  const w0 = 2 * Math.PI * hz / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  if (kind === "peaking") {
    const alpha = sin / 2;
    return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  }
  const alpha = (sin / 2) * Math.SQRT2;
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  if (kind === "lowshelf") {
    return [
      A * ((A + 1) - (A - 1) * cos + twoSqrtAAlpha),
      2 * A * ((A - 1) - (A + 1) * cos),
      A * ((A + 1) - (A - 1) * cos - twoSqrtAAlpha),
      (A + 1) + (A - 1) * cos + twoSqrtAAlpha,
      -2 * ((A - 1) + (A + 1) * cos),
      (A + 1) + (A - 1) * cos - twoSqrtAAlpha
    ];
  }
  return [
    A * ((A + 1) + (A - 1) * cos + twoSqrtAAlpha),
    -2 * A * ((A - 1) + (A + 1) * cos),
    A * ((A + 1) + (A - 1) * cos - twoSqrtAAlpha),
    (A + 1) - (A - 1) * cos + twoSqrtAAlpha,
    2 * ((A - 1) - (A + 1) * cos),
    (A + 1) - (A - 1) * cos - twoSqrtAAlpha
  ];
}

function eqBiquadResponseDb(coeffs, hz, sampleRate) {
  const [b0, b1, b2, a0, a1, a2] = coeffs;
  const theta = -2 * Math.PI * hz / sampleRate;
  const zr = Math.cos(theta);
  const zi = Math.sin(theta);
  const z2r = zr * zr - zi * zi;
  const z2i = 2 * zr * zi;
  const nr = b0 + b1 * zr + b2 * z2r;
  const ni = b1 * zi + b2 * z2i;
  const dr = a0 + a1 * zr + a2 * z2r;
  const di = a1 * zi + a2 * z2i;
  const mag2 = (nr * nr + ni * ni) / Math.max(1e-20, dr * dr + di * di);
  return 10 * Math.log10(Math.max(1e-20, mag2));
}

function computeEqHeadroomDb(gains, sampleRate) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
  const filters = EQ_BANDS.map((band, index) => eqBiquadCoeffs(band.type, band.hz, gains[index], rate));
  let peak = 0;
  for (let i = 0; i < EQ_HEADROOM_POINTS; i += 1) {
    const hz = 20 * (1000 ** (i / (EQ_HEADROOM_POINTS - 1)));
    let sum = 0;
    for (const coeffs of filters) {
      sum += eqBiquadResponseDb(coeffs, hz, rate);
    }
    if (sum > peak) {
      peak = sum;
    }
  }
  return peak > 0 ? peak : 0;
}

function setAudioParam(param, value, immediate) {
  if (!audioContext || !param) {
    return;
  }
  const now = audioContext.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (immediate) {
    param.setValueAtTime(value, now);
    return;
  }
  param.setTargetAtTime(value, now, EQ_RAMP_TIME);
}

function createPeakProtectChain(eqOutput) {
  peakCompressor = audioContext.createDynamicsCompressor();
  PeakProtect?.applyCompressorParams?.(peakCompressor);
  peakDryGain = audioContext.createGain();
  peakWetGain = audioContext.createGain();
  const mix = PeakProtect?.peakProtectMixGains?.(state.preventClipping !== false)
    ?? { dry: 0, wet: 1 };
  peakDryGain.gain.value = mix.dry;
  peakWetGain.gain.value = mix.wet;
  eqOutput.connect(peakDryGain);
  eqOutput.connect(peakCompressor);
  peakCompressor.connect(peakWetGain);
  peakDryGain.connect(masterGain);
  peakWetGain.connect(masterGain);
}

function applyPeakProtection({ immediate = false } = {}) {
  if (!peakDryGain || !peakWetGain) {
    return;
  }
  const mix = PeakProtect?.peakProtectMixGains?.(state.preventClipping !== false)
    ?? { dry: state.preventClipping === false ? 1 : 0, wet: state.preventClipping === false ? 0 : 1 };
  setAudioParam(peakDryGain.gain, mix.dry, immediate);
  setAudioParam(peakWetGain.gain, mix.wet, immediate);
}

function createEqualizerChain() {
  eqPreamp = audioContext.createGain();
  eqPreamp.gain.value = 1;
  let previous = eqPreamp;
  eqFilters = EQ_BANDS.map((band) => {
    const filter = audioContext.createBiquadFilter();
    filter.type = band.type;
    filter.frequency.value = band.hz;
    filter.Q.value = band.q;
    filter.gain.value = 0;
    previous.connect(filter);
    previous = filter;
    return filter;
  });
  try {
    createPeakProtectChain(previous);
  } catch {
    previous.connect(masterGain);
    peakCompressor = null;
    peakDryGain = null;
    peakWetGain = null;
  }
  eqReady = true;
  return eqPreamp;
}

function applyEqualizer({ immediate = false } = {}) {
  if (!eqReady || !eqPreamp || eqFilters.length !== 6) {
    return;
  }

  const enabled = state.equalizerEnabled === true;
  const source = sanitizeEqGains(state.equalizerGains);
  const gains = enabled ? source : cloneEqGains(EQ_FLAT_GAINS);
  try {
    const headroom = enabled ? computeEqHeadroomDb(source, audioContext?.sampleRate) : 0;
    cachedEqHeadroomDb = Number.isFinite(headroom) && headroom > 0 ? headroom : 0;
  } catch {
    cachedEqHeadroomDb = 0;
  }

  eqFilters.forEach((filter, index) => {
    setAudioParam(filter.gain, Number.isFinite(gains[index]) ? gains[index] : 0, immediate);
  });
  setAudioParam(eqPreamp.gain, dbToLinear(-cachedEqHeadroomDb), immediate);
}

function eqGainToOffset(gain) {
  return ((EQ_MAX_DB - gain) / (EQ_MAX_DB - EQ_MIN_DB)) * 100;
}

function eqBandCenterX(index, count, width) {
  return ((index + 0.5) / count) * width;
}

function eqSmoothPath(points) {
  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    path += ` C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6}, ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6}, ${p2[0]} ${p2[1]}`;
  }
  return path;
}

function eqCurveCommands(gains, width, height) {
  const points = gains.map((gain, index) => [
    eqBandCenterX(index, gains.length, width),
    (eqGainToOffset(gain) / 100) * height
  ]);
  const thru = [[0, points[0][1]], ...points, [width, points[points.length - 1][1]]];
  const line = eqSmoothPath(thru);
  return { line, fill: `${line} L ${width} ${height} L 0 ${height} Z`, points };
}

function closeEqPresetMenu() {
  viewArea.querySelectorAll(".eq-preset-wrap").forEach((wrap) => {
    const menu = wrap.querySelector(".eq-preset-menu");
    const button = wrap.querySelector("[data-eq-preset-toggle], [data-startup-toggle]");
    if (menu) {
      menu.hidden = true;
    }
    button?.setAttribute("aria-expanded", "false");
    wrap.classList.remove("is-open");
  });
}

function syncEqualizerUi() {
  if (state.view !== "settings") {
    return;
  }

  const label = viewArea.querySelector("[data-eq-preset-label]");
  if (label) {
    label.textContent = eqPresetLabel(state.equalizerPreset);
  }

  viewArea.querySelectorAll("[data-eq-preset]").forEach((item) => {
    const selected = item.dataset.eqPreset === state.equalizerPreset;
    item.classList.toggle("is-selected", selected);
    item.setAttribute("aria-selected", selected ? "true" : "false");
  });

  const width = 600;
  const height = 220;
  const curve = eqCurveCommands(state.equalizerGains, width, height);
  const line = viewArea.querySelector("[data-eq-line]");
  const fill = viewArea.querySelector("[data-eq-fill]");
  const grid = viewArea.querySelector("[data-eq-grid]");
  if (line) {
    line.setAttribute("d", curve.line);
  }
  if (fill) {
    fill.setAttribute("d", curve.fill);
  }
  if (grid && !grid.childElementCount) {
    curve.points.forEach((point) => {
      const vertical = document.createElementNS("http://www.w3.org/2000/svg", "line");
      vertical.setAttribute("class", "eq-grid-band");
      vertical.setAttribute("x1", String(point[0]));
      vertical.setAttribute("x2", String(point[0]));
      vertical.setAttribute("y1", "0");
      vertical.setAttribute("y2", String(height));
      grid.appendChild(vertical);
    });
  }

  state.equalizerGains.forEach((gain, index) => {
    const input = viewArea.querySelector(`[data-eq-band-input="${index}"]`);
    const handle = viewArea.querySelector(`[data-eq-handle="${index}"]`);
    if (input && input !== document.activeElement) {
      input.value = String(gain);
    }
    if (handle) {
      handle.style.top = `${eqGainToOffset(gain)}%`;
    }
  });
}

function setEqualizerGains(gains, presetId, { persist = true } = {}) {
  state.equalizerGains = sanitizeEqGains(gains);
  state.equalizerPreset = presetId ?? matchEqPresetId(state.equalizerGains);
  applyEqualizer();
  syncEqualizerUi();
  if (persist) {
    writeSession();
  }
}

function setEqualizerBand(index, value, { persist = true } = {}) {
  if (index < 0 || index > 5) {
    return;
  }
  const gains = cloneEqGains(state.equalizerGains);
  const number = Number(value);
  gains[index] = Number.isFinite(number) ? Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, number)) : 0;
  setEqualizerGains(gains, null, { persist });
}

function applyEqualizerPreset(id) {
  if (!isEqPresetAvailable(id)) {
    return;
  }
  setEqualizerGains(EQ_PRESETS[id].gains, id);
}

function resetEqualizer() {
  setEqualizerGains(EQ_FLAT_GAINS, "flat");
}

function eqClientYToGain(clientY, graph) {
  const track = graph.querySelector(".eq-svg") || graph;
  const rect = track.getBoundingClientRect();
  const t = (clientY - rect.top) / Math.max(1, rect.height);
  return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, EQ_MAX_DB - t * (EQ_MAX_DB - EQ_MIN_DB)));
}

function resumeAudioContext() {
  if (!audioContext || audioContext.state === "closed") {
    return Promise.resolve();
  }
  if (audioContext.state === "running") {
    return Promise.resolve();
  }
  if (audioContextResumePromise) {
    return audioContextResumePromise;
  }
  audioContextResumePromise = Promise.resolve(audioContext.resume?.())
    .catch(() => {})
    .finally(() => {
      audioContextResumePromise = null;
    });
  return audioContextResumePromise;
}

function wirePlayerIntoGraph(player, mixTarget) {
  if (player.source) {
    return;
  }
  player.source = audioContext.createMediaElementSource(player.el);
  player.gain = audioContext.createGain();
  player.analyser = audioContext.createAnalyser();
  player.analyser.fftSize = 2048;
  player.source.connect(player.analyser);
  player.source.connect(player.gain);
  player.gain.connect(mixTarget);
  player.el.volume = 1;
}

function applyAudioOutputDevice() {
  if (!audioContext || typeof audioContext.setSinkId !== "function") {
    return Promise.resolve();
  }
  if (isRemotePlayback() || isConnectingPlayback()) {
    return Promise.resolve();
  }
  const sinkId = typeof state.audioOutputId === "string" ? state.audioOutputId : "";
  return Promise.resolve(audioContext.setSinkId(sinkId)).catch(() => {
    if (sinkId) {
      state.audioOutputId = "";
      writeSession();
      return audioContext.setSinkId("");
    }
    return undefined;
  });
}

function ensureAudioGraph() {
  if (audioGraphReady && audioContext && audioContext.state !== "closed") {
    resumeAudioContext();
    return;
  }

  if (audioGraphReady && audioContext?.state === "closed") {
    rebuildAudioGraphFromClosedContext();
    return;
  }

  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) {
    return;
  }

  try {
    audioOutputSupported = "setSinkId" in Context.prototype;
    audioContext = new Context();
    audioContext.addEventListener("statechange", () => {
      if (audioContext?.state === "suspended" && state.playing && !isRemotePlayback()) {
        resumeAudioContext();
      }
    });
    masterGain = audioContext.createGain();
    masterGain.connect(audioContext.destination);

    let mixTarget = masterGain;
    try {
      mixTarget = createEqualizerChain() ?? masterGain;
    } catch {
      eqReady = false;
      eqPreamp = null;
      eqFilters = [];
      peakCompressor = null;
      peakDryGain = null;
      peakWetGain = null;
      mixTarget = masterGain;
    }

    players.forEach((player) => {
      wirePlayerIntoGraph(player, mixTarget);
    });
    audioGraphReady = true;
    try {
      applyEqualizer({ immediate: true });
      applyPeakProtection({ immediate: true });
    } catch {
      // Playback continues without EQ/peak protect if apply fails.
    }
    applyAudioOutputDevice();
    resumeAudioContext();
  } catch {
    audioGraphReady = false;
  }
}

function rebuildAudioGraphFromClosedContext() {
  const snapshot = GraphRecovery?.capturePlaybackSnapshot?.({
    trackId: currentTrack()?.id ?? null,
    position: playbackPosition(),
    playing: state.playing,
    queue: state.queue,
    shuffleBag: state.shuffleBag,
    index: state.index,
    shuffle: state.shuffle,
    repeat: state.repeat,
    incomingTrackId: incomingPlayer().trackId,
    nextId: peekNextId({ wrap: state.repeat === "all" }),
    lyricsTrackId: currentTrack()?.id ?? null,
    listenOccurrenceIds: players
      .map((player) => player.listenOccurrence && !player.listenOccurrence.finalized
        ? player.trackId
        : null)
      .filter(Boolean)
  }) ?? null;

  audioGraphReady = false;
  audioContext = null;
  masterGain = null;
  eqPreamp = null;
  eqFilters = [];
  eqReady = false;
  peakCompressor = null;
  peakDryGain = null;
  peakWetGain = null;

  const saved = players.map((player) => ({
    trackId: player.trackId,
    fade: player.fade,
    normalize: player.normalize,
    listenOccurrence: player.listenOccurrence,
    currentTime: player.el.currentTime,
    src: player.el.getAttribute("src")
  }));

  // Replace elements so MediaElementSources can be created again; preserve listen occurrences.
  players.forEach((_, index) => {
    const replacement = createAudioPlayer();
    replacement.fade = saved[index].fade;
    replacement.normalize = saved[index].normalize;
    replacement.trackId = saved[index].trackId;
    replacement.listenOccurrence = saved[index].listenOccurrence;
    players[index] = replacement;
  });

  playbackElementBindGeneration = GraphRecovery?.nextBindGeneration?.(playbackElementBindGeneration)
    ?? (playbackElementBindGeneration + 1);
  ensureAudioGraph();
  players.forEach(bindPlaybackElement);

  saved.forEach((entry, index) => {
    const player = players[index];
    if (!entry.src || !entry.trackId) {
      return;
    }
    const track = trackById(entry.trackId);
    if (!track) {
      return;
    }
    player.el.src = track.url;
    player.trackId = track.id;
    player.fade = entry.fade;
    applyReplayGain(player);
    const seekTo = snapshot && index === currentPlayerIndex
      ? snapshot.position
      : entry.currentTime;
    if (Number.isFinite(seekTo) && seekTo > 0) {
      try {
        player.el.currentTime = seekTo;
      } catch {
        // Ignore seek failures during recovery.
      }
    }
    if (snapshot?.playing && index === currentPlayerIndex && !isRemotePlayback()) {
      player.el.play().catch(() => {});
    }
  });

  const incomingId = GraphRecovery?.resolveIncomingAfterRebuild?.(snapshot);
  if (incomingId && incomingPlayer().trackId !== incomingId) {
    const next = trackById(incomingId);
    if (next && (state.crossfade || state.gapless)) {
      ensureIncomingLoaded(next);
    }
  }

  applyVolume();
  updateNowPlaying();
  syncLyricsRequests();
}

function applyVolume() {
  const master = userVolumeGain();
  if (audioGraphReady && masterGain) {
    // Direct assignment keeps crossfade rAF fades responsive.
    masterGain.gain.value = master;
    players.forEach((player) => {
      if (player.gain) {
        player.gain.gain.value = playerOutputGain(player);
      }
      player.el.volume = 1;
    });
    return;
  }

  players.forEach((player) => {
    player.el.volume = clamp(master * playerOutputGain(player), 0, 1);
  });
}

function applyReplayGain(player) {
  if (!player) {
    return;
  }
  if (!player.trackId || !state.normalizeVolume) {
    player.normalize = 1;
    return;
  }
  player.normalize = computePlayerNormalizeGain(player);
}

function applyCachedNormalize(player) {
  applyReplayGain(player);
}

function stopPlayer(player) {
  finalizePlayerListen(player);
  player.el.pause();
  player.el.removeAttribute("src");
  player.el.load();
  player.trackId = null;
  player.fade = 0;
  player.normalize = 1;
  postNowPlaying();
}

function finishIncoming() {
  playbackTransitioning = false;
  if (fadeRaf) {
    cancelAnimationFrame(fadeRaf);
    fadeRaf = 0;
  }
  stopPlayer(incomingPlayer());
  currentPlayer().fade = 1;
  applyVolume();
}

function cancelTransition() {
  transitionGeneration += 1;
  if (fadeRaf) {
    cancelAnimationFrame(fadeRaf);
    fadeRaf = 0;
  }
  playbackTransitioning = false;
  stopPlayer(incomingPlayer());
  currentPlayer().fade = 1;
  applyVolume();
}

function loadPlayer(player, track, { fade = 1 } = {}) {
  beginPlayerListen(player, track);
  player.el.src = track.url;
  player.trackId = track.id;
  player.fade = fade;
  applyCachedNormalize(player);
  applyVolume();
  postNowPlaying();
}

function peekNextId({ wrap = true } = {}) {
  const order = activeOrder();
  if (!order.length) {
    return null;
  }
  if (state.index + 1 < order.length) {
    return order[state.index + 1];
  }
  return wrap ? order[0] : null;
}

function advanceQueueTo(trackId) {
  const order = activeOrder();
  const index = order.indexOf(trackId);
  if (index >= 0) {
    state.index = index;
  }
}

function ensureIncomingLoaded(track) {
  const incoming = incomingPlayer();
  if (incoming.trackId === track.id && incoming.el.src) {
    applyReplayGain(incoming);
    return;
  }
  loadPlayer(incoming, track, { fade: 0 });
}

function invalidateIncomingPreload() {
  preloadGeneration += 1;
  if (playbackTransitioning) {
    return;
  }
  const nextId = (state.crossfade || state.gapless) && state.repeat !== "one"
    ? peekNextId({ wrap: state.repeat === "all" })
    : null;
  const incoming = incomingPlayer();
  if (!Transitions?.isIncomingPreloadValid?.(incoming.trackId, nextId)) {
    if (incoming.trackId) {
      stopPlayer(incoming);
    }
  }
  if (nextId && (state.crossfade || state.gapless)) {
    maybePreloadNext();
  }
}

function maybePreloadNext() {
  const el = currentAudio();
  const duration = el.duration || currentTrack()?.duration || 0;
  const remaining = duration ? duration - el.currentTime : Number.POSITIVE_INFINITY;
  const allowed = Transitions?.shouldPreloadNext?.({
    remote: isRemotePlayback(),
    connecting: isConnectingPlayback(),
    transitioning: playbackTransitioning,
    repeatOne: state.repeat === "one",
    crossfade: state.crossfade,
    gapless: state.gapless,
    remainingSeconds: remaining,
    crossfadeSeconds: state.crossfadeSeconds
  });
  if (!allowed) {
    return;
  }
  const generation = preloadGeneration;
  const nextId = peekNextId({ wrap: state.repeat === "all" });
  const next = trackById(nextId);
  if (!next || generation !== preloadGeneration) {
    return;
  }
  ensureIncomingLoaded(next);
}

function recordCurrentRecent() {
  const track = currentTrack();
  if (!track) {
    return;
  }
  recordRecentAlbum(track.albumId);
  recordRecentTrack(track.id);
}

function incomingReadyForTransition(player) {
  // HAVE_CURRENT_DATA === 2
  return Boolean(player?.el?.src) && player.el.readyState >= 2;
}

async function startCrossfade(nextId) {
  if (playbackTransitioning) {
    return;
  }
  const next = trackById(nextId);
  if (!next) {
    return;
  }

  const generation = ++transitionGeneration;
  playbackTransitioning = true;
  ensureAudioGraph();
  const incoming = incomingPlayer();
  ensureIncomingLoaded(next);
  incoming.fade = 0;
  applyVolume();

  if (!incomingReadyForTransition(incoming)) {
    try {
      await new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("incoming load failed"));
        };
        const cleanup = () => {
          incoming.el.removeEventListener("canplay", onReady);
          incoming.el.removeEventListener("error", onError);
        };
        incoming.el.addEventListener("canplay", onReady, { once: true });
        incoming.el.addEventListener("error", onError, { once: true });
      });
    } catch {
      if (generation !== transitionGeneration) {
        return;
      }
      playbackTransitioning = false;
      playTrack(nextId, null, { keepBag: true });
      return;
    }
  }

  try {
    await incoming.el.play();
  } catch {
    if (generation !== transitionGeneration) {
      return;
    }
    playbackTransitioning = false;
    playTrack(nextId, null, { keepBag: true });
    return;
  }

  if (generation !== transitionGeneration || !playbackTransitioning) {
    return;
  }

  const remaining = (currentAudio().duration || state.crossfadeSeconds) - currentAudio().currentTime;
  fadeDurationMs = Transitions?.crossfadeDurationMs?.(state.crossfadeSeconds, remaining)
    ?? Math.min(state.crossfadeSeconds, Math.max(0.5, remaining)) * 1000;
  advanceQueueTo(nextId);
  swapPlayers();
  recordCurrentRecent();
  updateNowPlaying();
  writeSession();

  fadeStartedAt = performance.now();
  let fadeElapsed = 0;
  let lastTick = fadeStartedAt;
  currentPlayer().fade = 0;
  incomingPlayer().fade = 1;
  applyVolume();

  const step = (now) => {
    if (generation !== transitionGeneration) {
      return;
    }
    if (state.playing) {
      fadeElapsed += now - lastTick;
    }
    lastTick = now;
    const t = Math.min(1, fadeElapsed / fadeDurationMs);
    currentPlayer().fade = t;
    incomingPlayer().fade = 1 - t;
    applyVolume();
    if (t < 1 && playbackTransitioning) {
      fadeRaf = requestAnimationFrame(step);
      return;
    }
    if (playbackTransitioning && generation === transitionGeneration) {
      finishIncoming();
    }
  };
  fadeRaf = requestAnimationFrame(step);
}

async function startGapless(nextId) {
  if (playbackTransitioning) {
    return;
  }
  const next = trackById(nextId);
  if (!next) {
    return;
  }

  const generation = ++transitionGeneration;
  playbackTransitioning = true;
  ensureAudioGraph();
  const incoming = incomingPlayer();
  ensureIncomingLoaded(next);
  incoming.fade = 1;
  applyVolume();

  if (!incomingReadyForTransition(incoming)) {
    try {
      await new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("incoming load failed"));
        };
        const cleanup = () => {
          incoming.el.removeEventListener("canplay", onReady);
          incoming.el.removeEventListener("error", onError);
        };
        incoming.el.addEventListener("canplay", onReady, { once: true });
        incoming.el.addEventListener("error", onError, { once: true });
      });
    } catch {
      if (generation !== transitionGeneration) {
        return;
      }
      playbackTransitioning = false;
      playTrack(nextId, null, { keepBag: true });
      return;
    }
  }

  try {
    await incoming.el.play();
  } catch {
    if (generation !== transitionGeneration) {
      return;
    }
    playbackTransitioning = false;
    playTrack(nextId, null, { keepBag: true });
    return;
  }

  if (generation !== transitionGeneration || !playbackTransitioning) {
    return;
  }

  currentPlayer().el.pause();
  advanceQueueTo(nextId);
  swapPlayers();
  currentPlayer().fade = 1;
  recordCurrentRecent();
  finishIncoming();
  updateNowPlaying();
  writeSession();
}

function maybeStartAutoAdvance() {
  if (isRemotePlayback() || isConnectingPlayback() || !state.playing || playbackTransitioning || state.repeat === "one" || state.seeking) {
    return;
  }
  const el = currentAudio();
  const duration = el.duration || currentTrack()?.duration || 0;
  if (!duration) {
    return;
  }
  const remaining = duration - el.currentTime;
  const nextId = peekNextId({ wrap: state.repeat === "all" });
  if (!nextId) {
    return;
  }
  if (state.crossfade && Transitions?.shouldStartCrossfade?.(remaining, state.crossfadeSeconds)) {
    startCrossfade(nextId);
    return;
  }
  if (state.gapless && Transitions?.shouldStartGapless?.(remaining, GAPLESS_LEAD_SECONDS)) {
    startGapless(nextId);
  }
}

function applyPlaybackSettings() {
  applyReplayGain(currentPlayer());
  applyReplayGain(incomingPlayer());
  applyPeakProtection();
  applyVolume();

  if (!state.crossfade && !state.gapless && !playbackTransitioning) {
    stopPlayer(incomingPlayer());
    return;
  }
  invalidateIncomingPreload();
  maybePreloadNext();
}

function postAppSettings() {
  window.chrome?.webview?.postMessage({
    type: "appSettings",
    startupOnLogin: state.startupOnLogin,
    closeMinimizes: state.closeMinimizes,
    automaticUpdateChecks: state.automaticUpdateChecks !== false
  });
}

function syncStartupSettingsUi() {
  if (state.view !== "settings") {
    return;
  }

  const label = viewArea.querySelector("[data-startup-label]");
  if (label) {
    label.textContent = startupOnLoginLabel(state.startupOnLogin);
  }

  viewArea.querySelectorAll("[data-startup]").forEach((item) => {
    const selected = item.dataset.startup === state.startupOnLogin;
    item.classList.toggle("is-selected", selected);
    item.setAttribute("aria-selected", selected ? "true" : "false");
  });

  const toggle = viewArea.querySelector('[data-setting="closeMinimizes"]');
  toggle?.setAttribute("aria-checked", state.closeMinimizes ? "true" : "false");
}

function applyHostAppSettings(detail) {
  if (!detail) {
    return;
  }

  if (detail.startupOnLogin != null) {
    state.startupOnLogin = normalizeStartupOnLogin(detail.startupOnLogin);
  }
  if (typeof detail.closeMinimizes === "boolean") {
    state.closeMinimizes = detail.closeMinimizes;
  }
  if (typeof detail.automaticUpdateChecks === "boolean") {
    state.automaticUpdateChecks = detail.automaticUpdateChecks;
  }
  if (typeof detail.currentVersion === "string" && detail.currentVersion) {
    state.appVersion = detail.currentVersion;
  }
  writeSession();
  syncStartupSettingsUi();
  syncUpdatesSettingsUi();
}

function setAutomaticUpdateChecks(value) {
  state.automaticUpdateChecks = Boolean(value);
  writeSession();
  postAppSettings();
  postUpdateAction("setAutomatic", { enabled: state.automaticUpdateChecks });
  syncUpdatesSettingsUi();
}

function syncUpdatesSettingsUi() {
  if (state.view !== "settings") {
    updateSettingsNavBadge();
    return;
  }

  const versionEl = viewArea.querySelector("[data-update-version]");
  if (versionEl) {
    versionEl.textContent = state.appVersion || "…";
  }
  const statusEl = viewArea.querySelector("[data-update-status]");
  if (statusEl) {
    statusEl.textContent = updateStatusCopy();
  }
  const autoToggle = viewArea.querySelector('[data-setting="automaticUpdateChecks"]');
  autoToggle?.setAttribute("aria-checked", state.automaticUpdateChecks !== false ? "true" : "false");

  const actionsRow = viewArea.querySelector("[data-update-actions]");
  if (actionsRow) {
    const status = state.updateStatus || {};
    const actions = [];
    if (status.state === "updateAvailable") {
      actions.push(`<button class="eq-reset" type="button" data-update-action="download">Download Update</button>`);
      actions.push(`<button class="eq-reset" type="button" data-update-action="dismiss">Not Now</button>`);
    } else if (status.state === "ready") {
      actions.push(`<button class="eq-reset" type="button" data-update-action="restartAndUpdate">Restart and Update</button>`);
      actions.push(`<button class="eq-reset" type="button" data-update-action="dismiss">Later</button>`);
    } else if (status.state !== "checking" && status.state !== "downloading" && status.state !== "installing") {
      actions.push(`<button class="eq-reset" type="button" data-update-action="check">Check for Updates</button>`);
    }
    actionsRow.innerHTML = actions.join("\n        ");
  }
  updateSettingsNavBadge();
}

function setStartupOnLogin(value) {
  state.startupOnLogin = normalizeStartupOnLogin(value);
  writeSession();
  postAppSettings();
  syncStartupSettingsUi();
}

function setCloseMinimizes(value) {
  state.closeMinimizes = Boolean(value);
  writeSession();
  postAppSettings();
  syncStartupSettingsUi();
}

function setPlaybackSetting(key, value) {
  const needsSettingsRerender = key === "crossfade"
    || key === "gapless"
    || key === "normalizeVolume"
    || key === "normalizeMode";

  if (key === "crossfade" || key === "gapless") {
    const next = Transitions?.applyTransitionExclusivity?.(key, value, state)
      ?? { crossfade: key === "crossfade" ? Boolean(value) : state.crossfade, gapless: key === "gapless" ? Boolean(value) : state.gapless };
    state.crossfade = next.crossfade;
    state.gapless = next.gapless;
  } else if (key === "normalizeMode") {
    state.normalizeMode = ReplayGain?.normalizeMode?.(value) || "track";
  } else if (key === "crossfadeSeconds") {
    state.crossfadeSeconds = clampCrossfadeSeconds(value);
  } else if (key === "audioOutputId") {
    state.audioOutputId = typeof value === "string" ? value : "";
    if (!state.audioOutputId) {
      state.audioOutputLabel = "";
    } else if (!state.audioOutputLabel) {
      const match = audioOutputDevices.find((device) => device.deviceId === state.audioOutputId);
      state.audioOutputLabel = match && String(match.label || "").trim() ? match.label.trim() : "";
    }
    applyAudioOutputDevice();
  } else {
    state[key] = Boolean(value);
  }

  writeSession();
  if (key === "equalizerEnabled") {
    applyEqualizer();
  } else if (key === "preventClipping") {
    applyPeakProtection();
  } else if (key !== "audioOutputId") {
    applyPlaybackSettings();
  }

  if (state.view === "settings") {
    if (needsSettingsRerender) {
      renderSettings();
      const durationSlider = viewArea.querySelector("[data-crossfade-seconds]");
      if (durationSlider) {
        updateSlider(durationSlider);
      }
    } else if (key === "crossfadeSeconds") {
      const label = viewArea.querySelector("[data-crossfade-seconds-label]");
      if (label) {
        label.textContent = `${state.crossfadeSeconds} sec`;
      }
    } else {
      const toggle = viewArea.querySelector(`[data-setting="${key}"]`);
      if (toggle) {
        toggle.setAttribute("aria-checked", state[key] ? "true" : "false");
      }
    }
  }
}

function sliderPercent(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const value = Number(el.value) || 0;
  return ((value - min) / (max - min)) * 100;
}

function updateSlider(el) {
  el.style.setProperty("--fill", `${Math.max(0, Math.min(100, sliderPercent(el)))}%`);
}

function setTooltipTitle(element, title) {
  element.setAttribute("data-bs-title", title);
  element.setAttribute("aria-label", title);
  const tooltip = bootstrap.Tooltip.getInstance(element);
  tooltip?.setContent({ ".tooltip-inner": title });
}

function updateRepeatButton() {
  const on = state.repeat !== "off";
  repeatBtn.classList.toggle("active", on);
  repeatBtn.innerHTML = state.repeat === "one"
    ? '<i class="bi bi-repeat-1"></i>'
    : '<i class="bi bi-repeat"></i>';
  const title = state.repeat === "one"
    ? "Repeat one"
    : state.repeat === "all"
      ? "Repeat all"
      : "Repeat";
  setTooltipTitle(repeatBtn, title);
}

function postNowPlaying() {
  const track = currentTrack();
  window.chrome?.webview?.postMessage({
    type: "nowPlaying",
    title: track?.title ?? "",
    artist: track?.artist ?? "",
    album: track?.album ?? "",
    trackId: track?.id ?? null,
    nextTrackId: nextCastTrackId(),
    playing: Boolean(track && state.playing),
    coverUrl: track?.coverUrl ?? "",
    mediaHosts: activeMediaHosts()
  });
}

function setNowPlayingInteractive(enabled) {
  nowCover.disabled = !enabled;
  nowTitle.disabled = !enabled;
  nowArtist.disabled = !enabled;
  nowCover.classList.toggle("now-link", enabled);
  nowTitle.classList.toggle("now-link", enabled);
  nowArtist.classList.toggle("now-link", enabled);
}

function updateNowPlaying() {
  const track = currentTrack();
  if (!track) {
    nowCover.removeAttribute("style");
    nowCover.innerHTML = "";
    nowCover.classList.remove("cover-fallback");
    nowTitle.textContent = "Select a track";
    nowArtist.textContent = "EMP";
    setNowPlayingInteractive(false);
    elapsedEl.textContent = "0:00";
    durationEl.textContent = "0:00";
    playBtn.innerHTML = '<i class="bi bi-play-fill"></i>';
    updateRepeatButton();
    updateSlider(seekBar);
    updateSlider(volumeBar);
    renderQueueDrawer();
    syncLyricsRequests();
    syncLyricsView();
    postNowPlaying();
    return;
  }

  nowCover.removeAttribute("style");
  if (track.coverUrl) {
    nowCover.classList.remove("cover-fallback");
    nowCover.innerHTML = coverMarkup(
      { coverUrl: track.coverUrl, color: track.color || albumById(track.albumId)?.color },
      "now-cover-art"
    );
    syncCoverImages(nowCover);
  } else {
    nowCover.classList.add("cover-fallback");
    nowCover.setAttribute("style", coverBackground(track));
    nowCover.innerHTML = '<i class="bi bi-music-note-beamed"></i>';
  }
  nowTitle.textContent = track.title;
  nowArtist.textContent = track.artist;
  setNowPlayingInteractive(true);
  durationEl.textContent = formatTime(playbackDuration() || track.duration);
  elapsedEl.textContent = formatTime(Math.min(playbackPosition(), playbackDuration() || playbackPosition()));
  playBtn.innerHTML = state.playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
  playBtn.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  likeBtn.innerHTML = state.liked.has(track.id) ? '<i class="bi bi-heart-fill"></i>' : '<i class="bi bi-heart"></i>';
  likeBtn.classList.toggle("active", state.liked.has(track.id));
  shuffleBtn.classList.toggle("active", state.shuffle);
  updateRepeatButton();

  const volumeIcon = state.muted || state.volume === 0
    ? "bi-volume-mute-fill"
    : state.volume < 40
      ? "bi-volume-down-fill"
      : "bi-volume-up-fill";
  muteBtn.innerHTML = `<i class="bi ${volumeIcon}"></i>`;
  highlightPlaying();
  updateCollectionControls();
  trackVirtual?.paint();
  collectionVirtual?.paint();
  updateSlider(seekBar);
  updateSlider(volumeBar);
  applyVolumeControls();
  updateDeviceButton();
  renderQueueDrawer();
  syncLyricsRequests();
  syncLyricsView();
  postNowPlaying();
}

async function playTrack(id, queueIds, options = {}) {
  const autoplay = options.autoplay !== false;
  const position = Number(options.position) || 0;
  state.holdEnded = false;
  cancelTransition();

  if (queueIds) {
    state.queue = [...queueIds];
    state.queueSource = normalizeQueueSource(options.source);
  } else if (!state.queue.length) {
    state.queue = state.library.tracks.map((track) => track.id);
    state.queueSource = { kind: "library" };
  }

  if (state.shuffle) {
    if (options.keepBag && state.shuffleBag.includes(id)) {
      state.index = state.shuffleBag.indexOf(id);
    } else {
      rebuildShuffleBag(id);
    }
  } else {
    state.shuffleBag = [];
    const index = state.queue.indexOf(id);
    state.index = index >= 0 ? index : 0;
  }
  invalidateIncomingPreload();

  const track = currentTrack();
  if (!track) {
    return;
  }

  if (options.recordRecent !== false) {
    recordRecentAlbum(track.albumId);
    recordRecentTrack(track.id);
  }

  if (isConnectingPlayback() && !isRemotePlayback()) {
    lastAudioTime = position;
    state.playing = autoplay;
    updateNowPlaying();
    writeSession();
    return;
  }

  if (isRemotePlayback()) {
    stopLocalOutput();
    beginRemoteListen(track);
    lastAudioTime = position;
    state.remotePosition = position;
    state.remoteStatusAt = performance.now();
    state.playing = autoplay;
    postCastCommand("load", {
      trackId: track.id,
      position,
      playing: autoplay
    });
    updateNowPlaying();
    writeSession();
    return;
  }

  finalizeRemoteListen();
  ensureAudioGraph();
  loadPlayer(currentPlayer(), track, { fade: 1 });
  lastAudioTime = position;

  if (position > 0) {
    await seekWhenReady(position, track.duration);
  }

  if (autoplay) {
    try {
      await currentAudio().play();
      state.playing = true;
    } catch (error) {
      state.playing = false;
      nowArtist.textContent = "Unable to play this file";
    }
  } else {
    state.playing = false;
  }

  updateNowPlaying();
  writeSession();
}

function seekWhenReady(position, fallbackDuration) {
  const el = currentAudio();
  return new Promise((resolve) => {
    const apply = () => {
      const duration = Number.isFinite(el.duration) && el.duration > 0
        ? el.duration
        : fallbackDuration || 0;
      el.currentTime = duration > 0 ? Math.min(position, Math.max(0, duration - 0.25)) : position;
      resolve();
    };

    if (el.readyState >= 1) {
      apply();
      return;
    }

    const onMeta = () => {
      el.removeEventListener("loadedmetadata", onMeta);
      apply();
    };

    el.addEventListener("loadedmetadata", onMeta);
    window.setTimeout(() => {
      el.removeEventListener("loadedmetadata", onMeta);
      apply();
    }, 1500);
  });
}

function seekTo(position) {
  const duration = playbackDuration();
  if (!duration) {
    return false;
  }

  const next = Math.max(0, Math.min(duration, position));
  setListenSeeking(true);
  if (isRemotePlayback()) {
    postCastCommand("seek", { position: next });
    state.remotePosition = next;
    state.remoteStatusAt = performance.now();
  } else {
    currentAudio().currentTime = next;
  }
  lastAudioTime = next;
  setListenSeeking(false);
  updateNowPlaying();
  writeSession();
  return true;
}

function seekBy(seconds) {
  if (seekTo(playbackPosition() + seconds)) {
    syncLyricsPosition({ force: true, instant: true });
  }
}

async function restoreSession() {
  const session = readSession();
  if (!session) {
    updateNowPlaying();
    return;
  }

  const compactLibrary = session.queueCompact === true
    && (session.queueSource?.kind === "library" || session.queueSource?.kind === "songs");
  const queue = compactLibrary
    ? state.library.tracks.map((track) => track.id)
    : (Array.isArray(session.queue) ? session.queue.filter((id) => trackById(id)) : []);
  const trackId = session.trackId && trackById(session.trackId)
    ? session.trackId
    : queue[0];

  if (!trackId) {
    updateNowPlaying();
    renderLibraryList();
    return;
  }

  if (!state.recentAlbumIds.length) {
    const restoredTrack = trackById(trackId);
    if (restoredTrack?.albumId) {
      state.recentAlbumIds = [restoredTrack.albumId];
    }
  }
  if (!state.recentTrackIds.length) {
    state.recentTrackIds = [trackId];
  }
  if (!state.recentHome.length) {
    state.recentHome = normalizeRecentHome(null, state.recentAlbumIds, state.recentPlaylistIds);
  }
  renderLibraryList();

  const restoredQueue = queue.length ? queue : state.library.tracks.map((track) => track.id);
  if (state.shuffle && Array.isArray(session.shuffleBag) && session.shuffleBag.length) {
    state.shuffleBag = session.shuffleBag.filter((id) => trackById(id) && restoredQueue.includes(id));
  } else if (state.shuffle && compactLibrary) {
    state.shuffleBag = [];
  }

  await playTrack(trackId, restoredQueue, {
    source: queue.length || compactLibrary
      ? normalizeQueueSource(session.queueSource) || { kind: "library" }
      : { kind: "library" },
    autoplay: false,
    recordRecent: false,
    keepBag: state.shuffle && state.shuffleBag.includes(trackId),
    position: Math.max(0, Number(session.position) || 0)
  });
}

function albumQueueIds(album) {
  if (!album) {
    return [];
  }

  return album.trackIds
    .map(trackById)
    .filter(Boolean)
    .sort((left, right) => (left.trackNumber || 0) - (right.trackNumber || 0) || compareText(left.title, right.title))
    .map((track) => track.id);
}

function artistQueueIds(name) {
  return [...tracksByArtist(name)].sort((left, right) => {
    const album = compareText(left.album, right.album);
    if (album !== 0) {
      return album;
    }
    return (left.trackNumber || 0) - (right.trackNumber || 0) || compareText(left.title, right.title);
  }).map((track) => track.id);
}

function viewQueueIds() {
  if (state.view === "album") {
    return albumQueueIds(albumById(state.albumId));
  }
  if (state.view === "playlist") {
    return playlistTracks(playlistById(state.playlistId)).map((track) => track.id);
  }
  if (state.view === "mix") {
    return mixQueueIds(mixById(state.mixId));
  }
  if (state.view === "artist") {
    return artistQueueIds(state.artist);
  }
  if (state.view === "songs") {
    return songsResultIds.length ? [...songsResultIds] : getSongsTracks().map((track) => track.id);
  }
  return [];
}

function sameCollection(queue, ids) {
  if (!queue?.length || !ids?.length || queue.length !== ids.length) {
    return false;
  }

  const wanted = new Set(ids);
  return queue.every((id) => wanted.has(id));
}

function collectionIsCurrent() {
  const ids = viewQueueIds();
  return sameCollection(state.queue, ids) && Boolean(currentTrack());
}

function updatePlaylistDetails(playlistId, name, description) {
  const playlist = playlistById(playlistId);
  if (!playlist) {
    return;
  }

  if (!isLikedPlaylist(playlist)) {
    const trimmed = String(name ?? "").trim();
    if (trimmed) {
      playlist.name = trimmed;
    }
  }
  playlist.description = String(description ?? "").trim();
  writeSession();
  refreshAfterPlaylistChange(playlist.id);
}

function collectionActionsMarkup(label, playAttrs, { more = false, albumMore = false } = {}) {
  return `
    <div class="album-actions">
      <button class="play-fab-lg" type="button" ${playAttrs} aria-label="Play ${escapeHtml(label)}">
        <i class="bi bi-play-fill"></i>
      </button>
      <button class="collection-shuffle" type="button" data-collection-shuffle aria-label="Enable shuffle" title="Shuffle">
        <i class="bi bi-shuffle"></i>
      </button>
      ${more ? `
        <button class="collection-more" type="button" data-playlist-more aria-label="More options" title="More">
          <i class="bi bi-three-dots"></i>
        </button>
      ` : ""}
      ${albumMore ? `
        <button class="collection-more" type="button" data-album-more aria-label="More options" title="More">
          <i class="bi bi-three-dots"></i>
        </button>
      ` : ""}
    </div>
  `;
}

function updateCollectionControls() {
  if (state.view === "songs") {
    updateSongsCollectionControls();
    return;
  }

  const play = viewArea.querySelector(".play-fab-lg");
  const topPlay = document.getElementById("topCollectionPlay");
  if (!play && !topPlay) {
    return;
  }

  const current = collectionIsCurrent();
  const playing = current && state.playing;
  const icon = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
  const label = playing ? "Pause" : "Play";

  if (play) {
    play.innerHTML = icon;
    play.setAttribute("aria-label", label);
  }

  if (topPlay) {
    topPlay.innerHTML = icon;
    topPlay.setAttribute("aria-label", label);
  }

  const shuffle = viewArea.querySelector("[data-collection-shuffle]");
  if (shuffle) {
    const on = current && state.shuffle;
    shuffle.classList.toggle("active", on);
    shuffle.setAttribute("aria-label", on ? "Disable shuffle" : "Enable shuffle");
    shuffle.title = on ? "Disable shuffle" : "Shuffle";
  }
}

function playCollectionFromView(startId) {
  if (state.view === "album" && state.albumId) {
    playAlbum(state.albumId, startId);
  } else if (state.view === "playlist" && state.playlistId) {
    playPlaylist(state.playlistId, startId);
  } else if (state.view === "mix" && state.mixId) {
    playMix(state.mixId, startId);
  } else if (state.view === "artist" && state.artist) {
    playArtist(state.artist, startId);
  }
}

function toggleCollectionShuffle() {
  if (collectionIsCurrent()) {
    setShuffle(!state.shuffle);
    return;
  }

  const ids = viewQueueIds();
  if (!ids.length) {
    return;
  }

  if (!state.shuffle) {
    setShuffle(true);
  }
  playCollectionFromView(randomQueueId(ids));
}

function playAlbum(albumId, startId) {
  const ids = albumQueueIds(albumById(albumId));
  if (!ids.length) {
    return;
  }
  playTrack(queueStartId(ids, startId), ids, { source: { kind: "album", id: albumId } });
}

function playArtist(name, startId) {
  const ids = artistQueueIds(name);
  if (!ids.length) {
    return;
  }
  playTrack(queueStartId(ids, startId), ids, { source: { kind: "artist", id: name } });
}

function togglePlay() {
  const track = currentTrack();
  if (!track) {
    const first = state.library.tracks[0];
    if (first) {
      playTrack(first.id, state.library.tracks.map((item) => item.id), { source: { kind: "library" } });
    }
    return;
  }

  if (isConnectingPlayback()) {
    return;
  }

  if (isRemotePlayback()) {
    if (state.playing) {
      postCastCommand("pause");
      state.playing = false;
    } else {
      postCastCommand("play", { playing: true });
      state.playing = true;
    }
    tickListenStats();
    updateNowPlaying();
    writeSession();
    return;
  }

  const el = currentAudio();
  if (state.playing) {
    el.pause();
    incomingPlayer().el.pause();
    state.playing = false;
  } else {
    state.holdEnded = false;
    ensureAudioGraph();
    if (el.ended || (el.duration > 0 && el.currentTime >= el.duration - 0.05)) {
      el.currentTime = 0;
      lastAudioTime = 0;
    }
    el.play();
    if (playbackTransitioning) {
      incomingPlayer().el.play();
    }
    state.playing = true;
  }
  tickListenStats();
  updateNowPlaying();
  writeSession();
}

function stopAtEndOfQueue() {
  state.holdEnded = true;
  state.playing = false;
  cancelTransition();
  if (isRemotePlayback()) {
    postCastCommand("pause");
  } else {
    currentAudio().pause();
  }
  updateNowPlaying();
  writeSession();
}

function hasNextTrack() {
  return state.index + 1 < activeOrder().length;
}

function nextTrack({ wrap = true } = {}) {
  const order = activeOrder();
  if (!order.length) {
    return;
  }

  if (!wrap && !hasNextTrack()) {
    stopAtEndOfQueue();
    return;
  }

  if (state.index + 1 >= order.length) {
    if (!wrap) {
      stopAtEndOfQueue();
      return;
    }
    state.index = 0;
  } else {
    state.index += 1;
  }

  playTrack(order[state.index], null, { keepBag: true });
}

function previousTrack() {
  const order = activeOrder();
  if (!order.length) {
    return;
  }
  if (playbackPosition() > 3) {
    if (isRemotePlayback()) {
      postCastCommand("seek", { position: 0 });
      state.remotePosition = 0;
      state.remoteStatusAt = performance.now();
    } else {
      currentAudio().currentTime = 0;
    }
    lastAudioTime = 0;
    updateNowPlaying();
    writeSession();
    return;
  }
  state.index = (state.index - 1 + order.length) % order.length;
  playTrack(order[state.index], null, { keepBag: true });
}

function openNowPlayingAlbum() {
  const track = currentTrack();
  if (track?.albumId) {
    navigate({ view: "album", albumId: track.albumId });
  }
}

function openNowPlayingArtist() {
  const track = currentTrack();
  if (track?.artist) {
    navigate({ view: "artist", artist: track.artist });
  }
}

function cycleRepeat() {
  const index = REPEAT_MODES.indexOf(state.repeat);
  state.repeat = REPEAT_MODES[(index + 1) % REPEAT_MODES.length];
  invalidateIncomingPreload();
  updateNowPlaying();
  writeSession();
}

function rescanButton() {
  return viewArea.querySelector("[data-rescan-library]");
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function startRescan(button) {
  if (button.disabled || pendingRescanId || !window.chrome?.webview) {
    return;
  }

  const slot = button.closest(".settings-rescan");
  const width = button.offsetWidth;
  const size = button.offsetHeight;
  if (slot) {
    slot.style.width = `${width}px`;
  }

  button.style.setProperty("--rescan-width", `${width}px`);
  button.style.setProperty("--rescan-size", `${size}px`);
  void button.offsetWidth;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.setAttribute("aria-label", "Rescanning library");
  button.classList.add("is-scanning");
  pendingRescanId = `rescan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.chrome.webview.postMessage({ type: "refresh", requestId: pendingRescanId });
}

function finishRescan(button, failed) {
  window.clearTimeout(rescanTimer);
  button.classList.remove("is-scanning");
  button.removeAttribute("aria-busy");
  button.removeAttribute("aria-label");
  if (failed) {
    endRescan(button);
    return;
  }

  button.classList.add("is-success");
  rescanTimer = window.setTimeout(() => endRescan(button), RESCAN_HOLD_MS);
}

function endRescan(button) {
  window.clearTimeout(rescanTimer);
  button.classList.remove("is-scanning", "is-success");
  button.disabled = false;
  button.removeAttribute("aria-busy");
  button.removeAttribute("aria-label");
  rescanTimer = window.setTimeout(() => {
    button.style.removeProperty("--rescan-width");
    button.style.removeProperty("--rescan-size");
    button.closest(".settings-rescan")?.style.removeProperty("width");
    render(historyStack[historyIndex]);
  }, prefersReducedMotion() ? 0 : RESCAN_EXPAND_MS);
}

function bindLibrary(library) {
  const requestId = typeof library.requestId === "string" ? library.requestId : "";
  const button = rescanButton();
  const busy = button !== null
    && (button.classList.contains("is-scanning") || button.classList.contains("is-success"));
  const matched = requestId !== "" && requestId === pendingRescanId;
  const failed = matched && library.failed === true;
  const fingerprint = typeof library.contentFingerprint === "string"
    ? library.contentFingerprint
    : "";
  const unchanged = !failed
    && fingerprint !== ""
    && fingerprint === libraryContentFingerprint
    && sessionRestored;
  if (matched) {
    pendingRescanId = "";
  }

  if (!failed && !unchanged) {
    const previousTracks = captureActiveTracks();
    state.library = {
      rootPath: library.rootPath ?? "",
      folders: Array.isArray(library.folders) ? library.folders : [],
      albums: library.albums ?? [],
      singles: library.singles ?? [],
      tracks: library.tracks ?? []
    };
    retainActiveTracks(previousTracks);
    invalidateSearchIndex();
    if (fingerprint) {
      libraryContentFingerprint = fingerprint;
    }
  } else if (!failed && fingerprint) {
    libraryContentFingerprint = fingerprint;
  }

  // Refresh mix snapshot against the current library when content changes.
  // Does not mutate the active playback queue or listening statistics.
  if (!failed && state.personalizedMixes !== false && state.library.tracks.length) {
    try {
      window.EmpMixes?.ensureMixSnapshot?.({
        enabled: true,
        tracks: state.library.tracks,
        listenStats: state.listenStats || {},
        libraryFingerprint: libraryContentFingerprint || "",
        now: Date.now(),
        allowGenerate: listenStatsLoaded || !window.chrome?.webview?.postMessage
      });
    } catch (error) {
      console.error("EMP mix refresh after library update failed.", error);
    }
  }

  if (!failed && !unchanged) {
    scheduleSmartReevaluation({ metadata: true, dateRelative: true });
  }

  // While the button animates, only its own library message may re-render the view.
  if (matched && busy) {
    finishRescan(button, failed);
  } else if (!busy && !unchanged) {
    if (state.view === "search") {
      focusSearchOnRender = false;
    }
    // If the open mix vanished after a library change, leave the broken view.
    if (state.view === "mix" && state.mixId && !mixById(state.mixId)) {
      historyStack[historyIndex] = { view: "home" };
      render(historyStack[historyIndex]);
    } else {
      render(historyStack[historyIndex]);
    }
    focusSearchOnRender = true;
  }

  if (!sessionRestored) {
    sessionRestored = true;
    restoreSession();
    markUpdateUiShellReady();
    return;
  }

  if (!unchanged) {
    updateNowPlaying();
  }
  markUpdateUiShellReady();
}

function markUpdateUiShellReady() {
  if (updateUiShellReady) {
    return;
  }
  updateUiShellReady = true;
  syncUpdateToast();
}

function isTypingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

let contextRoot = null;
const contextMenuState = {
  trackId: null,
  trackIds: [],
  playlistId: null,
  naming: false,
  query: ""
};

const trackSelection = {
  ids: new Set(),
  anchorId: null
};

function clearTrackSelection() {
  trackSelection.ids.clear();
  trackSelection.anchorId = null;
  document.querySelectorAll(".track-row.selected").forEach((row) => row.classList.remove("selected"));
}

function visibleTrackIdsInView() {
  return [...document.querySelectorAll(".track-row[data-play-id]")]
    .map((row) => row.dataset.playId)
    .filter(Boolean);
}

function syncTrackSelectionClasses() {
  document.querySelectorAll(".track-row[data-play-id]").forEach((row) => {
    row.classList.toggle("selected", trackSelection.ids.has(row.dataset.playId));
  });
}

function selectTrackRange(toId) {
  const ids = visibleTrackIdsInView();
  const anchor = trackSelection.anchorId && ids.includes(trackSelection.anchorId)
    ? trackSelection.anchorId
    : toId;
  const from = ids.indexOf(anchor);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) {
    trackSelection.ids = new Set([toId]);
    trackSelection.anchorId = toId;
    syncTrackSelectionClasses();
    return;
  }
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  trackSelection.ids = new Set(ids.slice(start, end + 1));
  syncTrackSelectionClasses();
}

function closeContextMenu() {
  if (!contextRoot || contextRoot.hidden) {
    contextMenuState.trackId = null;
    contextMenuState.trackIds = [];
    contextMenuState.playlistId = null;
    contextMenuState.naming = false;
    contextMenuState.query = "";
    return;
  }

  contextRoot.hidden = true;
  const submenu = contextRoot.querySelector(".ctx-submenu");
  if (submenu) {
    submenu.hidden = true;
  }
  contextMenuState.trackId = null;
  contextMenuState.trackIds = [];
  contextMenuState.playlistId = null;
  contextMenuState.naming = false;
  contextMenuState.query = "";
}

let overflowRoot = null;
let detailsModal = null;

function closeOverflowMenu() {
  if (overflowRoot) {
    overflowRoot.hidden = true;
  }
}

function closeDetailsModal() {
  if (detailsModal) {
    detailsModal.hidden = true;
  }
}

function positionOverflowMenu(anchor) {
  const menu = overflowRoot.querySelector(".ctx-menu");
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  const box = menu.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + box.width > window.innerWidth - 8) {
    left = Math.max(8, rect.right - box.width);
  }
  if (top + box.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - box.height - 6);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function ensureOverflowRoot() {
  if (overflowRoot) {
    return overflowRoot;
  }

  overflowRoot = document.createElement("div");
  overflowRoot.id = "empOverflowRoot";
  overflowRoot.className = "ctx-root";
  overflowRoot.hidden = true;
  overflowRoot.innerHTML = `
    <div class="ctx-menu" role="menu">
      <button class="ctx-item" type="button" data-playlist-edit>
        <i class="bi bi-pencil"></i>
        <span>Name &amp; details</span>
      </button>
      <button class="ctx-item" type="button" data-smart-edit-rules hidden>
        <i class="bi bi-funnel"></i>
        <span>Edit Rules</span>
      </button>
      <button class="ctx-item" type="button" data-smart-refresh hidden>
        <i class="bi bi-arrow-clockwise"></i>
        <span>Refresh Matches</span>
      </button>
      <button class="ctx-item" type="button" data-smart-reshuffle hidden>
        <i class="bi bi-shuffle"></i>
        <span>Reshuffle</span>
      </button>
      <button class="ctx-item" type="button" data-smart-duplicate hidden>
        <i class="bi bi-copy"></i>
        <span>Duplicate</span>
      </button>
      <button class="ctx-item" type="button" data-smart-convert hidden>
        <i class="bi bi-music-note-list"></i>
        <span>Convert to Regular Playlist</span>
      </button>
      <button class="ctx-item ctx-item-danger" type="button" data-playlist-delete>
        <i class="bi bi-trash3"></i>
        <span>Delete Playlist</span>
      </button>
      <button class="ctx-item" type="button" data-album-edit-meta hidden>
        <i class="bi bi-pencil-square"></i>
        <span>Edit Album Metadata</span>
      </button>
    </div>
  `;
  document.body.appendChild(overflowRoot);
  overflowRoot.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target === overflowRoot) {
      closeOverflowMenu();
      return;
    }
    if (event.target.closest("[data-playlist-edit]")) {
      closeOverflowMenu();
      openPlaylistDetailsModal();
    }
    if (event.target.closest("[data-smart-edit-rules]")) {
      closeOverflowMenu();
      openSmartPlaylistEditorEdit(state.playlistId);
    }
    if (event.target.closest("[data-smart-refresh]")) {
      closeOverflowMenu();
      smartMatchCache.delete(state.playlistId);
      refreshAfterPlaylistChange(state.playlistId);
    }
    if (event.target.closest("[data-smart-reshuffle]")) {
      closeOverflowMenu();
      reshuffleSmartPlaylist(state.playlistId);
    }
    if (event.target.closest("[data-smart-duplicate]")) {
      closeOverflowMenu();
      const copy = duplicateSmartPlaylist(state.playlistId);
      if (copy) {
        state.recentsFilter = "playlists";
        syncRecentsChips();
        navigate({ view: "playlist", playlistId: copy.id });
      }
    }
    if (event.target.closest("[data-smart-convert]")) {
      closeOverflowMenu();
      const converted = convertSmartPlaylistToRegular(state.playlistId);
      if (converted) {
        state.recentsFilter = "playlists";
        syncRecentsChips();
        navigate({ view: "playlist", playlistId: converted.id });
      }
    }
    if (event.target.closest("[data-playlist-delete]")) {
      closeOverflowMenu();
      openDeletePlaylistModal();
    }
    if (event.target.closest("[data-album-edit-meta]")) {
      closeOverflowMenu();
      const album = albumById(state.albumId);
      if (album?.trackIds?.length) {
        window.EmpMetadataEditor?.open(album.trackIds);
      }
    }
  });
  overflowRoot.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return overflowRoot;
}

function openOverflowMenu(anchor, { album = false } = {}) {
  closeContextMenu();
  const root = ensureOverflowRoot();
  const deleteBtn = root.querySelector("[data-playlist-delete]");
  const editBtn = root.querySelector("[data-playlist-edit]");
  const albumEditBtn = root.querySelector("[data-album-edit-meta]");
  const playlist = playlistById(state.playlistId);
  const smart = !album && isSmartPlaylist(playlist);
  if (editBtn) {
    editBtn.hidden = album;
  }
  if (deleteBtn) {
    deleteBtn.hidden = album || !!(playlist && isLikedPlaylist(playlist));
  }
  if (albumEditBtn) {
    albumEditBtn.hidden = !album;
  }
  root.querySelector("[data-smart-edit-rules]").hidden = !smart;
  root.querySelector("[data-smart-refresh]").hidden = !smart;
  root.querySelector("[data-smart-duplicate]").hidden = !smart;
  root.querySelector("[data-smart-convert]").hidden = !smart;
  root.querySelector("[data-smart-reshuffle]").hidden = !(smart && playlist?.smart?.sort?.field === "random");
  if (deleteBtn && smart) {
    deleteBtn.querySelector("span").textContent = "Delete Smart Playlist";
  } else if (deleteBtn) {
    deleteBtn.querySelector("span").textContent = "Delete Playlist";
  }
  root.hidden = false;
  positionOverflowMenu(anchor);
}

function ensureDetailsModal() {
  if (detailsModal) {
    return detailsModal;
  }

  detailsModal = document.createElement("div");
  detailsModal.className = "details-modal-root";
  detailsModal.hidden = true;
  detailsModal.innerHTML = `
    <div class="details-modal" role="dialog" aria-modal="true" aria-labelledby="detailsModalTitle">
      <div class="details-modal-head">
        <h2 id="detailsModalTitle">Edit details</h2>
        <button class="details-modal-close" type="button" data-details-close aria-label="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <form class="details-modal-form" data-details-form>
        <div class="details-modal-main">
          <div class="details-modal-cover" data-details-cover></div>
          <div class="details-modal-fields">
            <input class="details-name" type="text" maxlength="80" aria-label="Playlist name" autocomplete="off">
            <textarea class="details-desc" maxlength="300" rows="5" placeholder="Add an optional description" aria-label="Playlist description"></textarea>
          </div>
        </div>
        <div class="details-modal-foot">
          <button class="details-save" type="submit">Save</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(detailsModal);

  detailsModal.addEventListener("click", (event) => {
    if (event.target === detailsModal || event.target.closest("[data-details-close]")) {
      closeDetailsModal();
    }
  });

  detailsModal.querySelector("[data-details-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    const playlistId = detailsModal.dataset.playlistId;
    const name = detailsModal.querySelector(".details-name").value;
    const description = detailsModal.querySelector(".details-desc").value;
    closeDetailsModal();
    updatePlaylistDetails(playlistId, name, description);
  });

  return detailsModal;
}

function openPlaylistDetailsModal() {
  const playlist = playlistById(state.playlistId);
  if (!playlist) {
    return;
  }

  const root = ensureDetailsModal();
  root.dataset.playlistId = playlist.id;
  root.hidden = false;
  const cover = root.querySelector("[data-details-cover]");
  const name = root.querySelector(".details-name");
  const desc = root.querySelector(".details-desc");
  cover.innerHTML = playlistCoverMarkup(playlist, "details-cover");
  name.value = playlist.name;
  name.disabled = isLikedPlaylist(playlist);
  desc.value = playlist.description || "";
  name.focus();
  if (!name.disabled) {
    name.select();
  }
}

let deleteModal = null;

function ensureDeleteModal() {
  if (deleteModal) {
    return deleteModal;
  }

  deleteModal = document.createElement("div");
  deleteModal.className = "details-modal-root";
  deleteModal.hidden = true;
  deleteModal.innerHTML = `
    <div class="details-modal delete-modal" role="dialog" aria-modal="true" aria-labelledby="deleteModalTitle">
      <div class="details-modal-head">
        <h2 id="deleteModalTitle">Delete Playlist</h2>
        <button class="details-modal-close" type="button" data-delete-close aria-label="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <p class="delete-modal-msg">This will delete the current playlist. This action cannot be undone.</p>
      <div class="delete-modal-foot">
        <button class="delete-modal-cancel" type="button" data-delete-close>Cancel</button>
        <button class="delete-modal-confirm" type="button" data-delete-confirm>Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(deleteModal);

  deleteModal.addEventListener("click", (event) => {
    if (event.target === deleteModal || event.target.closest("[data-delete-close]")) {
      closeDeleteModal();
    }
    if (event.target.closest("[data-delete-confirm]")) {
      const playlistId = deleteModal.dataset.playlistId;
      closeDeleteModal();
      deletePlaylist(playlistId);
    }
  });

  return deleteModal;
}

function openDeletePlaylistModal() {
  const playlist = playlistById(state.playlistId);
  if (!playlist || isLikedPlaylist(playlist)) {
    return;
  }
  const root = ensureDeleteModal();
  root.dataset.playlistId = playlist.id;
  root.hidden = false;
}

function closeDeleteModal() {
  if (deleteModal) {
    deleteModal.hidden = true;
  }
}

function deletePlaylist(playlistId) {
  smartMatchCache.delete(playlistId);
  state.playlists = state.playlists.filter((p) => p.id !== playlistId);
  invalidateSearchIndex();
  writeSession();
  renderLibraryList();
  if (state.view === "playlists" || state.view === "playlist") {
    navigate({ view: "playlists" });
  } else if (state.view === "search") {
    focusSearchOnRender = false;
    render(historyStack[historyIndex]);
    focusSearchOnRender = true;
  } else {
    navigate({ view: "home" });
  }
}

function contextPlaylistListHtml() {
  const playlists = playlistsForMenu(contextMenuState.query);
  if (!playlists.length) {
    return `<div class="ctx-empty">${contextMenuState.query ? "No matching playlists" : "No playlists yet"}</div>`;
  }

  return playlists.map((playlist) => `
    <button class="ctx-item" type="button" data-ctx-playlist="${playlist.id}">
      <span>${escapeHtml(playlist.name)}</span>
    </button>
  `).join("");
}

function renderContextPlaylistList() {
  const list = contextRoot?.querySelector(".ctx-playlist-list");
  if (list) {
    list.innerHTML = contextPlaylistListHtml();
  }
}

function resetContextSubmenu() {
  if (!contextRoot) {
    return;
  }

  const search = contextRoot.querySelector(".ctx-search-input");
  const newBtn = contextRoot.querySelector("[data-ctx-new]");
  const form = contextRoot.querySelector(".ctx-new-form");
  const nameInput = contextRoot.querySelector(".ctx-name-input");
  contextMenuState.query = "";
  contextMenuState.naming = false;
  if (search) {
    search.value = "";
  }
  if (newBtn) {
    newBtn.hidden = false;
  }
  if (form) {
    form.hidden = true;
  }
  if (nameInput) {
    nameInput.value = "";
  }
  renderContextPlaylistList();
}

function positionContextMenu(x, y) {
  const menu = contextRoot.querySelector(".ctx-menu");
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - rect.width - 8);
  }
  if (top + rect.height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - rect.height - 8);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function positionContextSubmenu() {
  const menu = contextRoot.querySelector(".ctx-menu");
  const item = contextRoot.querySelector("[data-ctx-add]");
  const submenu = contextRoot.querySelector(".ctx-submenu");
  const menuRect = menu.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  submenu.style.left = `${menuRect.right - 4}px`;
  submenu.style.top = `${itemRect.top}px`;
  const rect = submenu.getBoundingClientRect();
  let left = menuRect.right - 4;
  let top = itemRect.top;
  if (left + rect.width > window.innerWidth - 8) {
    left = menuRect.left - rect.width + 4;
  }
  if (left < 8) {
    left = 8;
  }
  if (top + rect.height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - rect.height - 8);
  }
  submenu.style.left = `${left}px`;
  submenu.style.top = `${top}px`;
}

function openContextSubmenu() {
  if (!contextRoot) {
    return;
  }

  const submenu = contextRoot.querySelector(".ctx-submenu");
  submenu.hidden = false;
  renderContextPlaylistList();
  positionContextSubmenu();
}

function startPlaylistNaming() {
  contextMenuState.naming = true;
  const newBtn = contextRoot.querySelector("[data-ctx-new]");
  const form = contextRoot.querySelector(".ctx-new-form");
  const nameInput = contextRoot.querySelector(".ctx-name-input");
  newBtn.hidden = true;
  form.hidden = false;
  nameInput.value = "";
  nameInput.placeholder = defaultPlaylistName();
  positionContextSubmenu();
  nameInput.focus();
}

function submitNewPlaylist() {
  const nameInput = contextRoot.querySelector(".ctx-name-input");
  const name = nameInput.value.trim() || defaultPlaylistName();
  createPlaylist(name, contextMenuState.trackId);
  closeContextMenu();
}

function bindContextRoot(root) {
  root.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  root.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target === root) {
      closeContextMenu();
      return;
    }

    if (event.target.closest("[data-ctx-edit-meta]")) {
      const ids = contextMenuState.trackIds?.length
        ? contextMenuState.trackIds
        : contextMenuState.trackId
          ? [contextMenuState.trackId]
          : [];
      closeContextMenu();
      if (ids.length) {
        window.EmpMetadataEditor?.open(ids);
      }
      return;
    }

    if (event.target.closest("[data-ctx-add]")) {
      openContextSubmenu();
      return;
    }

    if (event.target.closest("[data-ctx-new]")) {
      startPlaylistNaming();
      return;
    }

    if (event.target.closest("[data-ctx-remove]")) {
      removeTrackFromPlaylist(contextMenuState.playlistId, contextMenuState.trackId);
      closeContextMenu();
      return;
    }

    if (event.target.closest("[data-ctx-like]")) {
      if (state.liked.has(contextMenuState.trackId)) {
        unlikeTrack(contextMenuState.trackId);
      } else {
        likeTrack(contextMenuState.trackId);
      }
      updateNowPlaying();
      closeContextMenu();
      return;
    }

    const playlistBtn = event.target.closest("[data-ctx-playlist]");
    if (playlistBtn) {
      addTrackToPlaylist(playlistBtn.dataset.ctxPlaylist, contextMenuState.trackId);
      closeContextMenu();
    }
  });

  root.querySelector("[data-ctx-add]").addEventListener("mouseenter", openContextSubmenu);
  root.querySelector("[data-ctx-playlist-actions]")?.addEventListener("mouseenter", () => {
    const submenu = root.querySelector(".ctx-submenu");
    if (submenu) {
      submenu.hidden = true;
    }
  });

  root.querySelector(".ctx-search-input").addEventListener("input", (event) => {
    contextMenuState.query = event.target.value;
    renderContextPlaylistList();
  });

  root.querySelector(".ctx-new-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitNewPlaylist();
  });
}

function ensureContextRoot() {
  if (contextRoot) {
    return contextRoot;
  }

  contextRoot = document.createElement("div");
  contextRoot.id = "empContextRoot";
  contextRoot.className = "ctx-root";
  contextRoot.hidden = true;
  contextRoot.innerHTML = `
    <div class="ctx-menu" role="menu">
      <button class="ctx-item" type="button" data-ctx-edit-meta>
        <i class="bi bi-pencil-square"></i>
        <span data-ctx-edit-meta-label>Edit Metadata</span>
      </button>
      <button class="ctx-item has-sub" type="button" data-ctx-add>
        <i class="bi bi-plus-lg"></i>
        <span>Add to playlist</span>
        <i class="bi bi-chevron-right ctx-chevron"></i>
      </button>
      <div data-ctx-playlist-actions hidden>
        <button class="ctx-item" type="button" data-ctx-remove>
          <i class="bi bi-dash-circle"></i>
          <span>Remove from this playlist</span>
        </button>
        <button class="ctx-item" type="button" data-ctx-like>
          <span class="ctx-liked-icon" aria-hidden="true"><i class="bi bi-heart-fill"></i></span>
          <span data-ctx-like-label>Save to your Liked Songs</span>
        </button>
      </div>
    </div>
    <div class="ctx-submenu" hidden>
      <div class="ctx-search">
        <i class="bi bi-search"></i>
        <input class="ctx-search-input" type="search" placeholder="Find a playlist" aria-label="Find a playlist" autocomplete="off">
      </div>
      <button class="ctx-item" type="button" data-ctx-new>
        <i class="bi bi-plus-lg"></i>
        <span>New playlist</span>
      </button>
      <form class="ctx-new-form" hidden>
        <input class="ctx-name-input" type="text" maxlength="80" aria-label="Playlist name" autocomplete="off">
        <button class="ctx-name-submit" type="submit" aria-label="Create playlist">
          <i class="bi bi-check-lg"></i>
        </button>
      </form>
      <div class="ctx-divider"></div>
      <div class="ctx-playlist-list"></div>
    </div>
  `;
  document.body.appendChild(contextRoot);
  bindContextRoot(contextRoot);
  return contextRoot;
}

function updateContextPlaylistActions() {
  const actions = contextRoot?.querySelector("[data-ctx-playlist-actions]");
  const likeBtn = contextRoot?.querySelector("[data-ctx-like]");
  const likeLabel = contextRoot?.querySelector("[data-ctx-like-label]");
  const removeBtn = contextRoot?.querySelector("[data-ctx-remove]");
  const playlistMode = Boolean(contextMenuState.playlistId);
  if (actions) {
    actions.hidden = !playlistMode;
  }
  if (!likeBtn || !likeLabel) {
    return;
  }

  const currentPlaylist = playlistById(contextMenuState.playlistId);
  const onLikedPlaylist = isLikedPlaylist(currentPlaylist);
  const onSmartPlaylist = isSmartPlaylist(currentPlaylist);
  if (removeBtn) {
    removeBtn.hidden = onSmartPlaylist;
    if (onSmartPlaylist) {
      removeBtn.title = "Smart Playlist membership is controlled by rules";
    } else {
      removeBtn.removeAttribute("title");
    }
  }
  likeBtn.hidden = onLikedPlaylist;
  const liked = state.liked.has(contextMenuState.trackId);
  likeLabel.textContent = liked ? "Remove from your Liked Songs" : "Save to your Liked Songs";
}

function openContextMenu(trackId, x, y) {
  closeOverflowMenu();
  const root = ensureContextRoot();
  const selected = trackSelection.ids.has(trackId) && trackSelection.ids.size > 1
    ? [...trackSelection.ids]
    : [trackId];
  contextMenuState.trackId = trackId;
  contextMenuState.trackIds = selected;
  contextMenuState.playlistId = state.view === "playlist" ? state.playlistId : null;
  updateContextPlaylistActions();
  const editLabel = root.querySelector("[data-ctx-edit-meta-label]");
  if (editLabel) {
    editLabel.textContent = selected.length > 1
      ? `Edit Metadata (${selected.length} songs)`
      : "Edit Metadata";
  }
  root.hidden = false;
  root.querySelector(".ctx-submenu").hidden = true;
  resetContextSubmenu();
  positionContextMenu(x, y);
  if (!contextMenuState.playlistId) {
    openContextSubmenu();
  }
}

window.empMediaCommand = (command) => {
  if (command === "play") {
    if (!state.playing) {
      togglePlay();
    }
    return;
  }
  if (command === "pause") {
    if (state.playing) {
      togglePlay();
    }
    return;
  }
  if (command === "toggle") {
    togglePlay();
    return;
  }
  if (command === "next") {
    nextTrack({ wrap: true });
    return;
  }
  if (command === "previous") {
    previousTrack();
  }
};

document.body.addEventListener("click", (event) => {
  const recentsFilterButton = event.target.closest("[data-recents-filter]");
  const settingButton = event.target.closest("[data-setting]");
  const playlistMoreButton = event.target.closest("[data-playlist-more]");
  const albumMoreButton = event.target.closest("[data-album-more]");
  const collectionShuffleButton = event.target.closest("[data-collection-shuffle]");
  const playPlaylistButton = event.target.closest("[data-play-playlist]");
  const playlistButton = event.target.closest("[data-open-playlist]");
  const playMixButton = event.target.closest("[data-play-mix]");
  const mixButton = event.target.closest("[data-open-mix]");
  const playAlbumButton = event.target.closest("[data-play-album]");
  const playArtistButton = event.target.closest("[data-play-artist]");
  const artistButton = event.target.closest("[data-open-artist]");
  const albumButton = event.target.closest("[data-open-album]");
  const playButton = event.target.closest("[data-play-id]");
  const sortButton = event.target.closest("[data-sort]");
  const layoutButton = event.target.closest("[data-layout]");
  const navButton = event.target.closest("[data-nav]");
  const searchMoreButton = event.target.closest("[data-search-more]");
  const searchRecentButton = event.target.closest("[data-search-recent]");
  const searchRemoveButton = event.target.closest("[data-search-remove]");
  const searchClearHistoryButton = event.target.closest("[data-search-clear-history]");

  if (searchMoreButton) {
    event.preventDefault();
    expandSearchResults(searchMoreButton.dataset.searchMore);
    return;
  }

  if (searchRemoveButton) {
    event.preventDefault();
    event.stopPropagation();
    removeSearchHistoryEntry(searchRemoveButton.dataset.searchRemove);
    if (state.view === "search" && !normalizeSearchQuery(state.query)) {
      renderSearch({ preserveFocus: true });
    }
    return;
  }

  if (searchClearHistoryButton) {
    event.preventDefault();
    clearSearchHistory();
    if (state.view === "search" && !normalizeSearchQuery(state.query)) {
      renderSearch({ preserveFocus: true });
    }
    return;
  }

  if (searchRecentButton) {
    event.preventDefault();
    updateSearchQuery(searchRecentButton.dataset.searchRecent || "", { focus: true, commit: true });
    return;
  }

  const shuffleLibraryButton = event.target.closest("[data-shuffle-library]");
  if (shuffleLibraryButton) {
    event.preventDefault();
    if (!shuffleLibraryButton.disabled) {
      shuffleFullLibrary();
    }
    return;
  }

  const songsPlayButton = event.target.closest("[data-songs-play]");
  if (songsPlayButton) {
    event.preventDefault();
    event.stopPropagation();
    if (songsPlayButton.disabled) {
      return;
    }
    if (sameCollection(state.queue, songsResultIds) && currentTrack()) {
      togglePlay();
    } else {
      playSongsFromView(null, { shuffle: false });
    }
    return;
  }

  const songsShuffleButton = event.target.closest("[data-songs-shuffle]");
  if (songsShuffleButton) {
    event.preventDefault();
    event.stopPropagation();
    if (songsShuffleButton.disabled) {
      return;
    }
    if (sameCollection(state.queue, songsResultIds) && currentTrack()) {
      setShuffle(!state.shuffle);
      updateSongsCollectionControls();
    } else {
      playSongsFromView(null, { shuffle: true });
    }
    return;
  }

  const songsNeverPlayedButton = event.target.closest("[data-songs-never-played]");
  if (songsNeverPlayedButton) {
    event.preventDefault();
    state.songsNeverPlayed = !state.songsNeverPlayed;
    refreshSongsResults({ preserveScroll: true });
    return;
  }

  const songsFilterClearButton = event.target.closest("[data-songs-filter-clear]");
  if (songsFilterClearButton) {
    event.preventDefault();
    state.songsQuery = "";
    const input = document.getElementById("songsFilterInput");
    if (input) {
      input.value = "";
      input.focus();
    }
    refreshSongsResults();
    return;
  }

  const songsResetFiltersButton = event.target.closest("[data-songs-reset-filters]");
  if (songsResetFiltersButton) {
    event.preventDefault();
    resetSongsFilters();
    return;
  }

  const songsSortDirButton = event.target.closest("[data-songs-sort-dir]");
  if (songsSortDirButton) {
    event.preventDefault();
    closeSongsSortMenu();
    state.songsSortDir = state.songsSortDir === "asc" ? "desc" : "asc";
    refreshSongsResults({ preserveScroll: true });
    return;
  }

  const songsSortItem = event.target.closest("[data-songs-sort]");
  if (songsSortItem) {
    event.preventDefault();
    setSongsSort(songsSortItem.dataset.songsSort);
    return;
  }

  const songsSortToggle = event.target.closest("[data-songs-sort-toggle]");
  if (songsSortToggle) {
    event.preventDefault();
    const wrap = songsSortToggle.closest(".songs-sort-wrap");
    const menu = document.getElementById("songsSortMenu");
    if (!wrap || !menu) {
      return;
    }
    const open = menu.hidden;
    closeSongsSortMenu();
    closeAudioOutputMenu();
    if (open) {
      wrap.classList.add("is-open");
      menu.hidden = false;
      songsSortToggle.setAttribute("aria-expanded", "true");
    }
    return;
  }

  if (!event.target.closest(".songs-sort-wrap")) {
    closeSongsSortMenu();
  }

  if (
    state.view === "search"
    && normalizeSearchQuery(state.query)
    && (playPlaylistButton || playlistButton || playAlbumButton || playArtistButton
      || artistButton || albumButton || playButton)
  ) {
    commitSearchHistory(state.query);
    clearSearchHistoryIdleCommit();
  }

  const normalizeModeButton = event.target.closest("[data-normalize-mode]");
  if (normalizeModeButton) {
    event.preventDefault();
    setPlaybackSetting("normalizeMode", normalizeModeButton.dataset.normalizeMode);
    return;
  }

  const audioOutputToggle = event.target.closest("[data-audio-output-toggle]");
  if (audioOutputToggle) {
    event.preventDefault();
    const wrap = audioOutputToggle.closest(".settings-audio-output-wrap");
    const menu = wrap?.querySelector(".songs-sort-menu");
    const open = menu && menu.hidden;
    closeAudioOutputMenu();
    closeEqPresetMenu();
    closeSongsSortMenu();
    if (open && menu) {
      menu.hidden = false;
      audioOutputToggle.setAttribute("aria-expanded", "true");
      wrap.classList.add("is-open");
    }
    return;
  }

  const audioOutputPick = event.target.closest("[data-audio-output-pick]");
  if (audioOutputPick) {
    event.preventDefault();
    closeAudioOutputMenu();
    pickAudioOutputDevice();
    return;
  }

  const audioOutputItem = event.target.closest("[data-audio-output]");
  if (audioOutputItem && audioOutputItem.closest(".settings-audio-output-wrap")) {
    event.preventDefault();
    const deviceId = audioOutputItem.dataset.audioOutput ?? "";
    const label = audioOutputItem.querySelector("span")?.textContent?.trim() || "";
    state.audioOutputLabel = deviceId ? label : "";
    setPlaybackSetting("audioOutputId", deviceId);
    closeAudioOutputMenu();
    if (state.view === "settings") {
      renderSettings();
    }
    return;
  }

  if (!event.target.closest(".settings-audio-output-wrap")) {
    closeAudioOutputMenu();
  }

  if (settingButton) {
    event.preventDefault();
    const key = settingButton.dataset.setting;
    if (key === "crossfade" || key === "gapless" || key === "normalizeVolume" || key === "equalizerEnabled" || key === "preventClipping") {
      setPlaybackSetting(key, !state[key]);
    } else if (key === "personalizedMixes") {
      setPersonalizedMixes(state.personalizedMixes === false);
    } else if (key === "closeMinimizes") {
      setCloseMinimizes(!state.closeMinimizes);
    } else if (key === "automaticUpdateChecks") {
      setAutomaticUpdateChecks(!(state.automaticUpdateChecks !== false));
    }
    return;
  }

  const updateToastAction = event.target.closest("[data-update-toast-action]");
  if (updateToastAction) {
    event.preventDefault();
    const action = updateToastAction.dataset.updateToastAction;
    if (action === "dismiss") {
      dismissUpdateToast();
    } else if (action === "download") {
      const toast = document.getElementById("updateToast");
      if (toast) {
        toast.hidden = true;
      }
      postUpdateAction("download");
    }
    return;
  }

  const updateActionButton = event.target.closest("[data-update-action]");
  if (updateActionButton) {
    event.preventDefault();
    postUpdateAction(updateActionButton.dataset.updateAction);
    return;
  }

  const addFolderButton = event.target.closest("[data-add-folder]");
  if (addFolderButton) {
    event.preventDefault();
    window.chrome?.webview?.postMessage({ type: "addMusicFolder" });
    return;
  }

  const removeFolderButton = event.target.closest("[data-remove-folder]");
  if (removeFolderButton) {
    event.preventDefault();
    window.chrome?.webview?.postMessage({
      type: "removeMusicFolder",
      path: removeFolderButton.dataset.removeFolder
    });
    return;
  }

  const rescanControl = event.target.closest("[data-rescan-library]");
  if (rescanControl) {
    event.preventDefault();
    startRescan(rescanControl);
    return;
  }

  const menuToggle = event.target.closest("[data-eq-preset-toggle], [data-startup-toggle]");
  if (menuToggle) {
    event.preventDefault();
    const wrap = menuToggle.closest(".eq-preset-wrap");
    const menu = wrap?.querySelector(".eq-preset-menu");
    const open = menu && menu.hidden;
    closeEqPresetMenu();
    closeAudioOutputMenu();
    if (open && menu) {
      menu.hidden = false;
      menuToggle.setAttribute("aria-expanded", "true");
      wrap.classList.add("is-open");
    }
    return;
  }

  const startupItem = event.target.closest("[data-startup]");
  if (startupItem) {
    event.preventDefault();
    setStartupOnLogin(startupItem.dataset.startup);
    closeEqPresetMenu();
    return;
  }

  const eqPresetItem = event.target.closest("[data-eq-preset]");
  if (eqPresetItem) {
    event.preventDefault();
    if (eqPresetItem.disabled || eqPresetItem.getAttribute("aria-disabled") === "true") {
      return;
    }
    applyEqualizerPreset(eqPresetItem.dataset.eqPreset);
    closeEqPresetMenu();
    return;
  }

  const eqReset = event.target.closest("[data-eq-reset]");
  if (eqReset) {
    event.preventDefault();
    resetEqualizer();
    return;
  }

  if (!event.target.closest(".eq-preset-wrap")) {
    closeEqPresetMenu();
  }

  if (recentsFilterButton) {
    event.preventDefault();
    setRecentsFilter(recentsFilterButton.dataset.recentsFilter);
    return;
  }

  if (event.target.closest("[data-smart-edit-rules]")) {
    event.preventDefault();
    openSmartPlaylistEditorEdit(state.playlistId);
    return;
  }

  if (playlistMoreButton) {
    event.preventDefault();
    event.stopPropagation();
    if (overflowRoot && !overflowRoot.hidden) {
      closeOverflowMenu();
    } else {
      openOverflowMenu(playlistMoreButton);
    }
    return;
  }

  if (albumMoreButton) {
    event.preventDefault();
    event.stopPropagation();
    if (overflowRoot && !overflowRoot.hidden) {
      closeOverflowMenu();
    } else {
      openOverflowMenu(albumMoreButton, { album: true });
    }
    return;
  }

  if (collectionShuffleButton) {
    event.preventDefault();
    event.stopPropagation();
    toggleCollectionShuffle();
    return;
  }

  if (playPlaylistButton) {
    event.preventDefault();
    event.stopPropagation();
    const playlistId = playPlaylistButton.dataset.playPlaylist;
    const canToggle = playPlaylistButton.classList.contains("play-fab-lg")
      || playPlaylistButton.classList.contains("play-fab")
      || playPlaylistButton.classList.contains("quick-play-fab");
    if (canToggle && queueMatchesIds(playlistTracks(playlistById(playlistId)).map((track) => track.id))) {
      togglePlay();
    } else {
      playPlaylist(playlistId);
    }
    blurHomePlayControl(playPlaylistButton);
    return;
  }

  if (playlistButton) {
    event.preventDefault();
    event.stopPropagation();
    recordRecentPlaylist(playlistButton.dataset.openPlaylist);
    writeSession();
    navigate({ view: "playlist", playlistId: playlistButton.dataset.openPlaylist });
    return;
  }

  if (playMixButton) {
    event.preventDefault();
    event.stopPropagation();
    const mixId = playMixButton.dataset.playMix;
    const canToggle = playMixButton.classList.contains("play-fab-lg")
      || playMixButton.classList.contains("play-fab")
      || playMixButton.id === "topCollectionPlay";
    if (canToggle && queueMatchesIds(mixQueueIds(mixById(mixId)))) {
      togglePlay();
    } else {
      playMix(mixId);
    }
    blurHomePlayControl(playMixButton);
    return;
  }

  if (mixButton) {
    event.preventDefault();
    event.stopPropagation();
    navigate({ view: "mix", mixId: mixButton.dataset.openMix });
    return;
  }

  if (playAlbumButton) {
    event.preventDefault();
    event.stopPropagation();
    const albumId = playAlbumButton.dataset.playAlbum;
    const canToggle = playAlbumButton.classList.contains("play-fab-lg")
      || playAlbumButton.classList.contains("play-fab")
      || playAlbumButton.classList.contains("quick-play-fab");
    if (canToggle && queueMatchesIds(albumQueueIds(albumById(albumId)))) {
      togglePlay();
    } else {
      playAlbum(albumId);
    }
    blurHomePlayControl(playAlbumButton);
    return;
  }

  if (playArtistButton) {
    event.preventDefault();
    event.stopPropagation();
    const artistName = playArtistButton.dataset.playArtist;
    const canToggle = playArtistButton.classList.contains("play-fab-lg")
      || playArtistButton.classList.contains("play-fab");
    if (canToggle && queueMatchesIds(artistQueueIds(artistName))) {
      togglePlay();
    } else {
      playArtist(artistName);
    }
    blurHomePlayControl(playArtistButton);
    return;
  }

  if (artistButton) {
    event.preventDefault();
    event.stopPropagation();
    navigate({ view: "artist", artist: artistButton.dataset.openArtist });
    return;
  }

  if (albumButton) {
    navigate({ view: "album", albumId: albumButton.dataset.openAlbum });
    return;
  }

  if (playButton) {
    const id = playButton.dataset.playId;
    const row = playButton.closest(".track-row");
    if (row && id && (event.ctrlKey || event.metaKey || event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        selectTrackRange(id);
      } else if (trackSelection.ids.has(id)) {
        trackSelection.ids.delete(id);
        trackSelection.anchorId = id;
        syncTrackSelectionClasses();
      } else {
        trackSelection.ids.add(id);
        trackSelection.anchorId = id;
        syncTrackSelectionClasses();
      }
      return;
    }
    if (id && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      // Play should not leave a selection highlight; keep anchor for Shift ranges.
      trackSelection.ids.clear();
      trackSelection.anchorId = id;
      document.querySelectorAll(".track-row.selected").forEach((row) => row.classList.remove("selected"));
    }
    const album = albumById(state.albumId);
    const playlist = playlistById(state.playlistId);
    let queue;
    let source;
    if (playButton.closest("#libraryList")) {
      queue = recentTracks(MAX_RECENTS).map((track) => track.id);
      source = { kind: "recents" };
    } else if (state.view === "album" && album) {
      queue = albumQueueIds(album);
      source = { kind: "album", id: album.id };
    } else if (state.view === "playlist" && playlist) {
      queue = playlistTracks(playlist).map((track) => track.id);
      source = { kind: isSmartPlaylist(playlist) ? "smart" : "playlist", id: playlist.id };
      recordRecentPlaylist(playlist.id);
    } else if (state.view === "mix" && state.mixId) {
      queue = mixQueueIds(mixById(state.mixId));
      source = { kind: "mix", id: state.mixId };
    } else if (state.view === "artist" && state.artist) {
      queue = artistQueueIds(state.artist);
      source = { kind: "artist", id: state.artist };
    } else if (state.view === "songs") {
      queue = songsResultIds.length ? songsResultIds : getSongsTracks().map((track) => track.id);
      source = { kind: "songs" };
    } else {
      queue = state.library.tracks.map((track) => track.id);
      source = { kind: "library" };
    }
    playTrack(id, queue, { source });
    return;
  }

  if (sortButton) {
    clearBrowseScrollForHistory();
    state.librarySort = normalizeSort(sortButton.dataset.sort);
    writeSession();
    render(historyStack[historyIndex]);
    viewArea.scrollTop = 0;
    return;
  }

  if (layoutButton) {
    clearBrowseScrollForHistory();
    state.libraryLayout = normalizeLayout(layoutButton.dataset.layout);
    writeSession();
    render(historyStack[historyIndex]);
    viewArea.scrollTop = 0;
    return;
  }

  if (navButton) {
    if (navButton.classList.contains("library-title-btn") && state.sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
    const entry = { view: navButton.dataset.nav };
    if (navButton.dataset.filter) {
      entry.filter = navButton.dataset.filter;
    }
    navigate(entry);
  }
});

document.addEventListener("contextmenu", (event) => {
  const row = event.target.closest(".track-row");
  const allowed = state.view === "album"
    || state.view === "artist"
    || state.view === "playlist"
    || state.view === "mix"
    || state.view === "search"
    || state.view === "songs"
    || state.view === "tracks";
  if (!row || !allowed) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const trackId = row.dataset.playId;
  if (!trackId) {
    return;
  }

  if (!trackSelection.ids.has(trackId)) {
    trackSelection.ids = new Set([trackId]);
    trackSelection.anchorId = trackId;
    syncTrackSelectionClasses();
  }

  openContextMenu(trackId, event.clientX, event.clientY);
});

viewArea.addEventListener("scroll", () => {
  closeContextMenu();
  closeOverflowMenu();
  closeEqPresetMenu();
  syncTopBarScroll();
});
viewArea.addEventListener("wheel", suspendLyricsFollow, { passive: true });
viewArea.addEventListener("touchmove", suspendLyricsFollow, { passive: true });
viewArea.addEventListener("pointerdown", (event) => {
  // Only the scrollbar reports the scroll container itself as the target.
  if (event.target === viewArea) {
    suspendLyricsFollow();
  }
});
viewArea.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
    suspendLyricsFollow();
  }
});
viewArea.addEventListener("click", (event) => {
  const line = event.target.closest(".lyrics-lines.is-synced .lyrics-line");
  if (!line) {
    return;
  }
  const entry = lyricsLines[Number(line.dataset.lyricIndex)];
  if (entry && seekTo(entry.time)) {
    syncLyricsPosition({ force: true });
  }
});
window.addEventListener("resize", () => {
  closeContextMenu();
  closeOverflowMenu();
  closeCreateMenu();
  closeEqPresetMenu();
  updateLibraryChipsScroll();
  syncTopBarScroll();
  syncHomeLayout();
  scheduleCollectionViewportSync();
});

window.addEventListener("focus", () => {
  ensureSmartDateRelativeFreshness();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    ensureSmartDateRelativeFreshness();
  }
});

(function configureSmartPlaylistEditor() {
  const editor = window.EmpSmartPlaylistEditor;
  if (!editor) {
    return;
  }

  let discardRoot = null;
  function ensureDiscardModal() {
    if (discardRoot) {
      return discardRoot;
    }
    discardRoot = document.createElement("div");
    discardRoot.className = "details-modal-root";
    discardRoot.hidden = true;
    discardRoot.innerHTML = `
      <div class="details-modal delete-modal" role="dialog" aria-modal="true" aria-labelledby="smartDiscardTitle">
        <div class="details-modal-head">
          <h2 id="smartDiscardTitle">Discard changes?</h2>
          <button class="details-modal-close" type="button" data-discard-close aria-label="Close">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
        <p class="delete-modal-msg">You have unsaved smart playlist changes. Discard them?</p>
        <div class="delete-modal-foot">
          <button class="delete-modal-cancel" type="button" data-discard-close>Keep editing</button>
          <button class="delete-modal-confirm" type="button" data-discard-confirm>Discard</button>
        </div>
      </div>
    `;
    document.body.appendChild(discardRoot);
    discardRoot.addEventListener("click", (event) => {
      if (event.target === discardRoot || event.target.closest("[data-discard-close]")) {
        discardRoot.hidden = true;
        return;
      }
      if (event.target.closest("[data-discard-confirm]")) {
        discardRoot.hidden = true;
        const proceed = discardRoot._proceed;
        discardRoot._proceed = null;
        proceed?.();
      }
    });
    return discardRoot;
  }

  editor.configure({
    getContext: () => smartEvalContext(),
    escapeHtml,
    formatDuration: (seconds) => {
      const total = Math.max(0, Math.floor(Number(seconds) || 0));
      const m = Math.floor(total / 60);
      const s = String(total % 60).padStart(2, "0");
      return `${m}:${s}`;
    },
    coverUrl: (track) => track?.coverUrl || albumById(track?.albumId)?.coverUrl || "",
    onSave: ({ mode, playlistId, name, description, smart }) => {
      if (mode === "edit" && playlistId) {
        updateSmartPlaylist(playlistId, { name, description, smart });
        state.recentsFilter = "playlists";
        syncRecentsChips();
        navigate({ view: "playlist", playlistId });
        return;
      }
      const playlist = createSmartPlaylist({ name, description, smart });
      state.recentsFilter = "playlists";
      syncRecentsChips();
      writeSession();
      navigate({ view: "playlist", playlistId: playlist.id });
    },
    confirmDiscard: (proceed) => {
      const root = ensureDiscardModal();
      root._proceed = proceed;
      root.hidden = false;
    }
  });
})();

new ResizeObserver(() => {
  syncHomeLayout();
  scheduleCollectionViewportSync();
}).observe(viewArea);

function syncTopBarScroll() {
  const topBar = document.querySelector(".top-bar");
  if (!topBar) {
    return;
  }
  document.documentElement.style.setProperty("--top-bar-height", `${topBar.offsetHeight}px`);
  topBar.classList.toggle("is-scrolled", viewArea.scrollTop > 8);

  const barBottom = topBar.getBoundingClientRect().bottom;
  syncStuckTableHead(barBottom);
  syncTopCollection(barBottom);
}

function syncStuckTableHead(barBottom) {
  const head = viewArea.querySelector(".track-panel .track-table-head");
  if (!head) {
    return;
  }
  head.classList.toggle("is-stuck", head.getBoundingClientRect().top <= barBottom + 1);
}

function syncTopCollection(barBottom) {
  const chrome = document.getElementById("topCollection");
  if (!chrome || chrome.hidden) {
    return;
  }

  const title = viewArea.querySelector(".album-hero h1, .songs-header h1");
  const show = Boolean(title) && title.getBoundingClientRect().bottom <= barBottom;
  chrome.classList.toggle("is-visible", show);
  chrome.setAttribute("aria-hidden", show ? "false" : "true");
}

function collectionHeader() {
  if (state.view === "album") {
    const album = albumById(state.albumId);
    return album ? { name: album.title, attribute: "data-play-album", value: album.id } : null;
  }
  if (state.view === "playlist") {
    const playlist = playlistById(state.playlistId);
    return playlist ? { name: playlist.name, attribute: "data-play-playlist", value: playlist.id } : null;
  }
  if (state.view === "mix") {
    const mix = mixById(state.mixId);
    return mix ? { name: mix.title, attribute: "data-play-mix", value: mix.id } : null;
  }
  if (state.view === "artist" && state.artist) {
    return { name: state.artist, attribute: "data-play-artist", value: state.artist };
  }
  if (state.view === "songs") {
    return { name: "Songs", attribute: "data-songs-play", value: "songs" };
  }
  return null;
}

function mountTopCollection() {
  const chrome = document.getElementById("topCollection");
  const play = document.getElementById("topCollectionPlay");
  const name = document.getElementById("topCollectionName");
  if (!chrome || !play || !name) {
    return;
  }

  chrome.classList.remove("is-visible");
  chrome.setAttribute("aria-hidden", "true");
  play.removeAttribute("data-play-album");
  play.removeAttribute("data-play-playlist");
  play.removeAttribute("data-play-mix");
  play.removeAttribute("data-play-artist");
  play.removeAttribute("data-songs-play");
  play.disabled = false;

  const header = collectionHeader();
  chrome.hidden = !header;
  name.textContent = header ? header.name : "";
  if (header) {
    play.setAttribute(header.attribute, header.value);
  }
}

viewArea.addEventListener("input", (event) => {
  const crossfadeSeconds = event.target.closest("[data-crossfade-seconds]");
  if (crossfadeSeconds) {
    setPlaybackSetting("crossfadeSeconds", crossfadeSeconds.value);
    updateSlider(crossfadeSeconds);
    return;
  }
  const input = event.target.closest("[data-eq-band-input]");
  if (!input) {
    return;
  }
  setEqualizerBand(Number(input.dataset.eqBandInput), input.value, { persist: false });
});

viewArea.addEventListener("change", (event) => {
  if (event.target.closest("[data-eq-band-input]")) {
    writeSession();
  }
});

viewArea.addEventListener("pointerdown", (event) => {
  const band = event.target.closest("[data-eq-band]");
  if (!band || event.target.closest(".eq-band-label") || event.target.closest("[data-eq-band-input]")) {
    return;
  }
  const graph = viewArea.querySelector("[data-eq-graph]");
  const index = Number(band.dataset.eqBand);
  if (!graph || !Number.isInteger(index)) {
    return;
  }
  event.preventDefault();
  eqDragIndex = index;
  band.setPointerCapture?.(event.pointerId);
  setEqualizerBand(index, eqClientYToGain(event.clientY, graph), { persist: false });
});

document.addEventListener("pointermove", (event) => {
  if (eqDragIndex < 0) {
    return;
  }
  const graph = viewArea.querySelector("[data-eq-graph]");
  if (!graph) {
    return;
  }
  setEqualizerBand(eqDragIndex, eqClientYToGain(event.clientY, graph), { persist: false });
});

document.addEventListener("pointerup", () => {
  if (eqDragIndex < 0) {
    return;
  }
  eqDragIndex = -1;
  writeSession();
});

document.addEventListener("pointercancel", () => {
  if (eqDragIndex < 0) {
    return;
  }
  eqDragIndex = -1;
  writeSession();
});

document.getElementById("backBtn").addEventListener("click", () => {
  if (historyIndex > 0) {
    historyIndex -= 1;
    render(historyStack[historyIndex]);
  }
});

document.getElementById("forwardBtn").addEventListener("click", () => {
  if (historyIndex < historyStack.length - 1) {
    historyIndex += 1;
    render(historyStack[historyIndex]);
  }
});

document.getElementById("refreshBtn").addEventListener("click", () => {
  window.chrome?.webview?.postMessage({ type: "refresh" });
});

createPlaylistBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  if (createMenuRoot && !createMenuRoot.hidden) {
    closeCreateMenu();
    return;
  }
  openCreateMenu(createPlaylistBtn);
});

sidebarCollapseBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  toggleSidebarCollapsed();
});

sidebarSortBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  cycleSidebarSort();
});

librarySearch?.addEventListener("input", () => {
  state.libraryQuery = librarySearch.value;
  renderLibraryList();
});

document.querySelector("[data-chips-scroll] .library-chips")?.addEventListener("scroll", updateLibraryChipsScroll, { passive: true });

(function bindSidebarResize() {
  if (!sidebarResize || !sidebar) {
    return;
  }

  let dragging = false;
  let startX = 0;
  let startWidth = state.sidebarWidth;

  const setResizing = (active) => {
    sidebar.classList.toggle("is-resizing", active);
    document.documentElement.classList.toggle("is-sidebar-resizing", active);
  };

  const onMove = (event) => {
    if (!dragging) {
      return;
    }
    const delta = event.clientX - startX;
    state.sidebarWidth = normalizeSidebarWidth(startWidth + delta);
    document.documentElement.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
    scheduleCollectionViewportSync();
  };

  const onUp = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    setResizing(false);
    document.body.style.cursor = "";
    writeSession();
    updateLibraryChipsScroll();
    scheduleCollectionViewportSync();
  };

  sidebarResize.addEventListener("pointerdown", (event) => {
    if (state.sidebarCollapsed || event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startWidth = state.sidebarWidth;
    setResizing(true);
    document.body.style.cursor = "col-resize";
    sidebarResize.setPointerCapture?.(event.pointerId);
  });

  sidebarResize.addEventListener("pointermove", onMove);
  sidebarResize.addEventListener("pointerup", onUp);
  sidebarResize.addEventListener("pointercancel", onUp);

  sidebarResize.addEventListener("keydown", (event) => {
    if (state.sidebarCollapsed) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      state.sidebarWidth = normalizeSidebarWidth(state.sidebarWidth - 16);
      applySidebarLayout();
      writeSession();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      state.sidebarWidth = normalizeSidebarWidth(state.sidebarWidth + 16);
      applySidebarLayout();
      writeSession();
    }
  });
})();

function scheduleSearchRender({ immediate = false } = {}) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = 0;
  const requestId = ++searchRequestId;
  if (immediate) {
    renderSearch({ preserveFocus: false, requestId });
    return;
  }
  searchDebounceTimer = window.setTimeout(() => {
    searchDebounceTimer = 0;
    renderSearch({ preserveFocus: false, requestId });
  }, SEARCH_DEBOUNCE_MS);
}

searchInput.addEventListener("input", () => {
  state.query = searchInput.value;
  const entry = { view: "search", query: state.query };
  historyStack[historyIndex] = entry;
  scheduleSearchRender();
  scheduleSearchHistoryIdleCommit();
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    clearSearchHistoryIdleCommit();
    if (isMeaningfulSearchQuery(state.query)) {
      commitSearchHistory(state.query);
    }
    scheduleSearchRender({ immediate: true });
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    clearSearchHistoryIdleCommit();
    if (state.query) {
      state.query = "";
      historyStack[historyIndex] = { view: "search", query: "" };
      searchInput.value = "";
      scheduleSearchRender({ immediate: true });
      searchInput.focus();
    } else {
      searchInput.blur();
    }
  }
});

nowCover.addEventListener("click", openNowPlayingAlbum);
nowTitle.addEventListener("click", openNowPlayingAlbum);
nowArtist.addEventListener("click", openNowPlayingArtist);

playBtn.addEventListener("click", togglePlay);
document.getElementById("nextBtn").addEventListener("click", () => nextTrack({ wrap: true }));
document.getElementById("prevBtn").addEventListener("click", previousTrack);

deviceBtn?.addEventListener("click", () => {
  if (deviceDrawerIsOpen()) {
    closeDeviceDrawer();
  } else {
    openDeviceDrawer();
  }
});

deviceDrawerRoot?.addEventListener("click", (event) => {
  if (event.target === deviceDrawerRoot) {
    closeDeviceDrawer();
    return;
  }
  const row = event.target.closest("[data-cast-device]");
  if (row?.dataset.castDevice) {
    selectPlaybackDevice(row.dataset.castDevice);
  }
});

document.getElementById("deviceDrawerClose")?.addEventListener("click", (event) => {
  event.stopPropagation();
  closeDeviceDrawer();
});

deviceRescanBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  rescanDevices();
});

deviceDrawerRoot?.addEventListener("keydown", (event) => {
  trapDrawerFocus(deviceDrawerRoot, event);
});

lyricsBtn?.addEventListener("click", toggleLyricsView);

queueBtn?.addEventListener("click", () => {
  if (queueDrawerRoot?.classList.contains("is-open")) {
    closeQueueDrawer();
  } else {
    openQueueDrawer();
  }
});

queueDrawerRoot?.addEventListener("click", (event) => {
  if (event.target === queueDrawerRoot) {
    closeQueueDrawer();
    return;
  }
  const row = event.target.closest("[data-queue-track]");
  if (row?.dataset.queueTrack) {
    playQueuedTrack(row.dataset.queueTrack, row.hasAttribute("data-queue-current"));
  }
});

document.getElementById("queueDrawerClose")?.addEventListener("click", (event) => {
  event.stopPropagation();
  closeQueueDrawer();
});

queueDrawerRoot?.addEventListener("keydown", (event) => {
  trapDrawerFocus(queueDrawerRoot, event);
});

shuffleBtn.addEventListener("click", () => {
  setShuffle(!state.shuffle);
});

repeatBtn.addEventListener("click", cycleRepeat);

likeBtn.addEventListener("click", () => {
  const track = currentTrack();
  if (!track) {
    return;
  }
  if (state.liked.has(track.id)) {
    unlikeTrack(track.id);
  } else {
    likeTrack(track.id);
  }
  updateNowPlaying();
});

seekBar.addEventListener("input", () => {
  if (!state.seeking) {
    setListenSeeking(true);
  }
  state.seeking = true;
  const duration = playbackDuration() || currentTrack()?.duration || 0;
  elapsedEl.textContent = formatTime((Number(seekBar.value) / 1000) * duration);
  updateSlider(seekBar);
});

seekBar.addEventListener("change", () => {
  const duration = playbackDuration() || currentTrack()?.duration || 0;
  const position = (Number(seekBar.value) / 1000) * duration;
  if (isRemotePlayback()) {
    postCastCommand("seek", { position });
    state.remotePosition = position;
    state.remoteStatusAt = performance.now();
  } else {
    currentAudio().currentTime = position;
  }
  lastAudioTime = position;
  state.seeking = false;
  setListenSeeking(false);
  updateSlider(seekBar);
  syncLyricsPosition({ force: true, instant: true });
  writeSession();
});

volumeBar.addEventListener("input", () => {
  if (isRemotePlayback() && !state.castVolumeAvailable) {
    volumeBar.value = String(state.muted ? 0 : state.volume);
    updateSlider(volumeBar);
    return;
  }
  state.volume = Number(volumeBar.value);
  state.muted = state.volume === 0;
  if (state.volume > 0) {
    state.lastVolume = state.volume;
  }
  if (isRemotePlayback()) {
    postCastCommand("volume");
  } else {
    applyVolume();
  }
  updateNowPlaying();
  writeSession();
});

muteBtn.addEventListener("click", () => {
  if (isRemotePlayback() && !state.castVolumeAvailable) {
    return;
  }
  state.muted = !state.muted;
  if (state.muted) {
    state.lastVolume = state.volume || state.lastVolume;
    volumeBar.value = "0";
  } else {
    state.volume = state.lastVolume || 80;
    volumeBar.value = String(state.volume);
  }
  if (isRemotePlayback()) {
    postCastCommand("volume");
  } else {
    applyVolume();
  }
  updateNowPlaying();
  writeSession();
});

function bindPlaybackElement(player) {
  const el = player.el;
  const bindGeneration = playbackElementBindGeneration;
  el.addEventListener("timeupdate", () => {
    if (bindGeneration !== playbackElementBindGeneration) {
      return;
    }
    if (el !== currentAudio() || isRemotePlayback() || isConnectingPlayback()) {
      return;
    }

    if (state.seeking) {
      lastAudioTime = el.currentTime;
      return;
    }

    const duration = el.duration || currentTrack()?.duration || 1;
    if (
      state.repeat === "off"
      && state.playing
      && !playbackTransitioning
      && duration > 1
      && lastAudioTime >= duration * 0.9
      && el.currentTime < 0.4
    ) {
      stopAtEndOfQueue();
      lastAudioTime = 0;
      return;
    }

    lastAudioTime = el.currentTime;
    elapsedEl.textContent = formatTime(el.currentTime);
    seekBar.value = String(Math.round((el.currentTime / duration) * 1000));
    updateSlider(seekBar);
    syncLyricsPosition();
    writeSessionThrottled();
    maybePreloadNext();
    maybeStartAutoAdvance();
  });

  el.addEventListener("loadedmetadata", () => {
    const occ = player.listenOccurrence;
    if (occ && !occ.finalized && Number.isFinite(el.duration) && el.duration > 0) {
      occ.durationSec = el.duration;
    }
    if (el !== currentAudio()) {
      return;
    }
    durationEl.textContent = formatTime(el.duration);
  });

  el.addEventListener("ended", () => {
    if (bindGeneration !== playbackElementBindGeneration) {
      return;
    }
    if (el !== currentAudio() || playbackTransitioning || isRemotePlayback() || isConnectingPlayback()) {
      return;
    }
    if (state.repeat === "one") {
      state.holdEnded = false;
      const track = currentTrack();
      finalizePlayerListen(player);
      el.currentTime = 0;
      if (track) {
        beginPlayerListen(player, track);
      }
      el.play();
      return;
    }
    nextTrack({ wrap: state.repeat === "all" });
  });

  el.addEventListener("play", () => {
    setPlayerListenStalled(player, false);
    if (el !== currentAudio() || isRemotePlayback() || isConnectingPlayback()) {
      return;
    }
    if (state.holdEnded && state.repeat !== "one") {
      el.pause();
      state.playing = false;
      return;
    }
    state.holdEnded = false;
    state.playing = true;
    updateNowPlaying();
    writeSession();
  });

  el.addEventListener("playing", () => {
    setPlayerListenStalled(player, false);
  });

  el.addEventListener("waiting", () => {
    setPlayerListenStalled(player, true);
  });

  el.addEventListener("stalled", () => {
    setPlayerListenStalled(player, true);
  });

  el.addEventListener("pause", () => {
    if (bindGeneration !== playbackElementBindGeneration) {
      return;
    }
    if (el !== currentAudio() || playbackTransitioning || isRemotePlayback() || isConnectingPlayback()) {
      return;
    }
    if (!el.ended) {
      state.playing = false;
      updateNowPlaying();
      writeSession();
    }
  });
}

players.forEach((player) => bindPlaybackElement(player));

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    tickListenStats();
    postListenStatsUpdates();
    writeSession();
    return;
  }
  if (state.playing && !isRemotePlayback()) {
    ensureAudioGraph();
    resumeAudioContext();
  }
});

window.addEventListener("pagehide", () => {
  teardownListenStatsForUnload();
  writeSession();
});

document.addEventListener("keydown", (event) => {
  if (event.code === "Escape") {
    if (window.EmpMetadataEditor?.isOpen?.()) {
      // Metadata editor handles Escape itself (preview back / dirty confirm).
      return;
    }
    if (window.EmpSmartPlaylistEditor?.isOpen?.()) {
      event.preventDefault();
      window.EmpSmartPlaylistEditor.requestClose();
      return;
    }
    if (createMenuRoot && !createMenuRoot.hidden) {
      event.preventDefault();
      closeCreateMenu();
      createPlaylistBtn?.focus();
      return;
    }
    if (deviceDrawerIsOpen()) {
      event.preventDefault();
      closeDeviceDrawer();
      return;
    }
    if (queueDrawerIsOpen()) {
      event.preventDefault();
      closeQueueDrawer();
      return;
    }
    if (detailsModal && !detailsModal.hidden) {
      event.preventDefault();
      closeDetailsModal();
      return;
    }
    if (overflowRoot && !overflowRoot.hidden) {
      event.preventDefault();
      closeOverflowMenu();
      return;
    }
    if (contextRoot && !contextRoot.hidden) {
      event.preventDefault();
      closeContextMenu();
      return;
    }
    const openMenu = [...viewArea.querySelectorAll(".eq-preset-menu")].find((menu) => !menu.hidden);
    if (openMenu) {
      event.preventDefault();
      closeEqPresetMenu();
      return;
    }
  }

  if (window.EmpMetadataEditor?.isOpen?.()) {
    return;
  }

  if (detailsModal && !detailsModal.hidden) {
    return;
  }

  if (event.code === "Slash" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.target === searchInput) {
      return;
    }
    event.preventDefault();
    if (state.view !== "search") {
      navigate({ view: "search", query: state.query });
    }
    searchInput.focus();
    return;
  }

  if (isTypingTarget(event.target)) {
    return;
  }

  if (event.code === "Space") {
    event.preventDefault();
    togglePlay();
    return;
  }

  if (event.ctrlKey && event.code === "ArrowRight") {
    event.preventDefault();
    nextTrack({ wrap: true });
    return;
  }

  if (event.ctrlKey && event.code === "ArrowLeft") {
    event.preventDefault();
    previousTrack();
    return;
  }

  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.code === "ArrowRight") {
    event.preventDefault();
    seekBy(5);
    return;
  }

  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.code === "ArrowLeft") {
    event.preventDefault();
    seekBy(-5);
  }
});

document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((element) => {
  const tooltip = new bootstrap.Tooltip(element, {
    trigger: "hover",
    delay: { show: 250, hide: 0 }
  });

  const hideTooltip = () => tooltip.hide();
  element.addEventListener("click", hideTooltip);
  element.addEventListener("mouseleave", hideTooltip);
  element.addEventListener("blur", hideTooltip);
});

function postWindowAction(action) {
  window.chrome?.webview?.postMessage({ type: "window", action });
}

function isWindowDragExempt(target) {
  return Boolean(
    target?.closest?.(
      "button, input, a, select, textarea, label, .window-control, .window-controls, .sidebar-resize, .slider"
    )
  );
}

function isPointerOverViewScrollbar(event) {
  if (!viewArea) {
    return false;
  }
  const rect = viewArea.getBoundingClientRect();
  const gutter = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--view-scrollbar-size")
  ) || 10;
  return event.clientX >= rect.right - gutter - 1
    && event.clientX <= rect.right + 1
    && event.clientY >= rect.top
    && event.clientY <= rect.bottom;
}

function bindWindowDragRegion(element) {
  if (!element) {
    return;
  }

  element.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0
      || event.detail > 1
      || isWindowDragExempt(event.target)
      || isPointerOverViewScrollbar(event)
    ) {
      return;
    }
    postWindowAction("drag");
  });

  element.addEventListener("dblclick", (event) => {
    if (isWindowDragExempt(event.target) || isPointerOverViewScrollbar(event)) {
      return;
    }
    event.preventDefault();
    postWindowAction("maximizeToggle");
  });
}

function applyHostWindowState(detail) {
  const maximized = Boolean(detail?.maximized);
  document.documentElement.classList.toggle("is-window-maximized", maximized);

  const button = document.getElementById("winMaximize");
  const icon = button?.querySelector("[data-maximize-icon]");
  if (!button || !icon) {
    return;
  }

  const label = maximized ? "Restore" : "Maximize";
  button.setAttribute("aria-label", label);
  button.setAttribute("data-bs-title", label);
  icon.classList.toggle("bi-square", !maximized);
  icon.classList.toggle("bi-window-stack", maximized);

  const tooltip = bootstrap.Tooltip.getInstance(button);
  tooltip?.setContent({ ".tooltip-inner": label });
}

document.getElementById("winMinimize")?.addEventListener("click", () => {
  postWindowAction("minimize");
});

document.getElementById("winMaximize")?.addEventListener("click", () => {
  postWindowAction("maximizeToggle");
});

document.getElementById("winClose")?.addEventListener("click", () => {
  postWindowAction("close");
});

bindWindowDragRegion(document.getElementById("topBar"));
bindWindowDragRegion(document.querySelector(".window-chrome-drag"));

applySidebarLayout({ animate: false });
syncSidebarSortUi();
updateLibraryChipsScroll();
syncTopBarScroll();
syncHomeLayout();

bindCoverImageLifecycle(viewArea);
bindCoverImageLifecycle(libraryList);
bindCoverImageLifecycle(nowCover);
bindCoverImageLifecycle(queueDrawerBody);

window.addEventListener("emp-library", (event) => bindLibrary(event.detail));
window.addEventListener("emp-artist-info", (event) => applyArtistInfo(event.detail));
window.addEventListener("emp-lyrics", (event) => applyLyricsResult(event.detail));
window.addEventListener("emp-storage", (event) => applyStorageUsage(event.detail));
window.addEventListener("emp-app-settings", (event) => applyHostAppSettings(event.detail));
window.addEventListener("emp-update-status", (event) => applyUpdateStatus(event.detail));
window.addEventListener("emp-window-state", (event) => applyHostWindowState(event.detail));
window.addEventListener("emp-cast", (event) => handleCastMessage(event.detail));
window.addEventListener("emp-listen-stats", (event) => applyListenStats(event.detail));

document.addEventListener("input", (event) => {
  if (event.target?.id !== "songsFilterInput") {
    return;
  }
  state.songsQuery = event.target.value;
  scheduleSongsFilterRefresh();
});

if (window.__emp?.library) {
  bindLibrary(window.__emp.library);
}

/**
 * Dev helper: seed synthetic albums/artists approximating trackCount tracks.
 * Usage: `__EMP_seedBrowseFixture(10000)` then open Browse Library.
 * Does not write to disk; next real library bind replaces it.
 */
globalThis.__EMP_seedBrowseFixture = function seedBrowseFixture(trackCount = 10000) {
  const total = Math.max(1, Math.floor(Number(trackCount) || 0));
  const albums = [];
  const singles = [];
  const tracks = [];
  let remaining = total;
  let albumIndex = 0;
  while (remaining > 0) {
    albumIndex += 1;
    const isSingle = albumIndex % 7 === 0;
    const size = Math.min(remaining, isSingle ? 1 : 10);
    const id = `fixture-album-${albumIndex}`;
    const artist = `Fixture Artist ${((albumIndex - 1) % 500) + 1}`;
    const title = `${isSingle ? "Single" : "Album"} ${albumIndex}`;
    const album = {
      id,
      title,
      artist,
      coverUrl: null,
      color: "#282828",
      trackCount: size,
      year: 2000 + (albumIndex % 25),
      isSingle,
      trackIds: []
    };
    for (let n = 1; n <= size; n += 1) {
      const trackId = `fixture-track-${albumIndex}-${n}`;
      album.trackIds.push(trackId);
      tracks.push({
        id: trackId,
        title: `Track ${n}`,
        artist,
        album: title,
        albumId: id,
        trackNumber: n,
        duration: 180,
        url: "",
        coverUrl: null,
        isSingle,
        color: "#282828"
      });
    }
    if (isSingle) {
      singles.push(album);
    } else {
      albums.push(album);
    }
    remaining -= size;
  }
  invalidateSearchIndex();
  state.library = {
    rootPath: state.library.rootPath || "",
    folders: state.library.folders || [],
    albums,
    singles,
    tracks
  };
  if (state.view === "albums") {
    renderAlbumGrid();
  }
  console.info(
    "[EMP library] seeded fixture: "
      + tracks.length + " tracks, "
      + albums.length + " albums, "
      + singles.length + " singles"
  );
  return { tracks: tracks.length, albums: albums.length, singles: singles.length };
};

updateRepeatButton();
updateSlider(volumeBar);
updateSlider(seekBar);
updateDeviceButton();
refreshAudioOutputDevices();
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    refreshAudioOutputDevices();
  });
}

