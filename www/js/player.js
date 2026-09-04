const CROSSFADE_SECONDS = 8;
const GAPLESS_LEAD_SECONDS = 0.12;
const PRELOAD_SECONDS = 20;
const NORMALIZE_TARGET_RMS = 0.1;
const NORMALIZE_MIN_GAIN = 0.35;
const NORMALIZE_MAX_GAIN = 2.8;

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
    trackId: null
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
let fadeRaf = 0;
let playbackTransitioning = false;
let fadeStartedAt = 0;
let fadeDurationMs = CROSSFADE_SECONDS * 1000;
const normalizeCache = new Map();

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
  normalizeVolume: false,
  equalizerEnabled: false,
  equalizerPreset: "flat",
  equalizerGains: cloneEqGains(EQ_FLAT_GAINS),
  startupOnLogin: "no",
  closeMinimizes: false
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

const SESSION_KEY = "emp.playback";
const LIKED_PLAYLIST_ID = "pl_liked";
const LIKED_PLAYLIST_NAME = "Liked Songs";
const HOME_QUICK_SIZE = 6;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 420;
const SIDEBAR_COLLAPSED = 72;
const HOME_SHELF_SIZE = 14;
const SIDEBAR_RECENTS = 12;
const MAX_RECENTS = 24;
const SEARCH_ALBUM_LIMIT = 12;
const SEARCH_TRACK_LIMIT = 40;
const TRACK_ROW_HEIGHT = 58;
const ARTIST_INFO_TIMEOUT_MS = 15000;
const RESCAN_HOLD_MS = 1000;
const RESCAN_EXPAND_MS = 220;
const artistInfoCache = new Map();
let artistInfoRequestId = 0;
let sessionRestored = false;
let pendingRescanId = "";
let rescanTimer = 0;
let lastSessionWrite = 0;
let trackVirtual = null;
let lastAudioTime = 0;

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

  return value
    .filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
    .map((item) => ({
      id: item.id === LIKED_PLAYLIST_ID || item.kind === "liked" ? LIKED_PLAYLIST_ID : item.id,
      name: item.id === LIKED_PLAYLIST_ID || item.kind === "liked" ? LIKED_PLAYLIST_NAME : item.name,
      kind: item.id === LIKED_PLAYLIST_ID || item.kind === "liked" ? "liked" : undefined,
      trackIds: Array.isArray(item.trackIds) ? item.trackIds.filter((id) => typeof id === "string") : [],
      description: typeof item.description === "string" ? item.description : "",
      createdAt: Number(item.createdAt) || 0
    }));
}

function isLikedPlaylist(playlist) {
  return playlist?.kind === "liked" || playlist?.id === LIKED_PLAYLIST_ID;
}

function likedPlaylist() {
  return state.playlists.find((playlist) => isLikedPlaylist(playlist)) ?? null;
}

function syncLikedFromPlaylist() {
  const playlist = likedPlaylist();
  state.liked = new Set(playlist?.trackIds ?? []);
}

function writeSession() {
  const track = currentTrack();
  const payload = {
    trackId: track?.id ?? null,
    queue: state.queue,
    shuffleBag: state.shuffleBag,
    index: state.index,
    position: Number.isFinite(currentAudio().currentTime) ? currentAudio().currentTime : 0,
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
    crossfade: state.crossfade,
    gapless: state.gapless,
    normalizeVolume: state.normalizeVolume,
    equalizerEnabled: state.equalizerEnabled,
    equalizerPreset: state.equalizerPreset,
    equalizerGains: cloneEqGains(state.equalizerGains),
    startupOnLogin: state.startupOnLogin,
    closeMinimizes: state.closeMinimizes
  };

  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    lastSessionWrite = Date.now();
  } catch {
    // Ignore storage quota or private-mode failures.
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
  state.crossfade = Boolean(session.crossfade);
  state.gapless = Boolean(session.gapless);
  state.normalizeVolume = Boolean(session.normalizeVolume);
  state.startupOnLogin = normalizeStartupOnLogin(session.startupOnLogin);
  state.closeMinimizes = Boolean(session.closeMinimizes);
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
  recordRecentPlaylist(playlist.id);
  writeSession();
  return playlist;
}

function addTrackToPlaylist(playlistId, trackId) {
  const playlist = playlistById(playlistId);
  if (!playlist || !trackId) {
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
  if (state.view === "playlist" && state.playlistId === playlist.id) {
    render(historyStack[historyIndex]);
  }
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
    if (state.view === "playlist" && state.playlistId === playlist.id) {
      render(historyStack[historyIndex]);
    }
    return;
  }

  addTrackToPlaylist(playlist.id, trackId);
}

function unlikeTrack(trackId) {
  if (!trackId) {
    return;
  }

  state.liked.delete(trackId);
  const playlist = likedPlaylist();
  if (!playlist) {
    writeSession();
    return;
  }

  playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
  writeSession();
  if (state.view === "playlist" && state.playlistId === playlist.id) {
    render(historyStack[historyIndex]);
  } else {
    renderLibraryList();
  }
}

function removeTrackFromPlaylist(playlistId, trackId) {
  const playlist = playlistById(playlistId);
  if (!playlist || !trackId) {
    return;
  }

  if (isLikedPlaylist(playlist)) {
    unlikeTrack(trackId);
    return;
  }

  playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
  writeSession();
  if (state.view === "playlist" && state.playlistId === playlist.id) {
    render(historyStack[historyIndex]);
  } else {
    renderLibraryList();
  }
}

function playPlaylist(playlistId, startId) {
  const playlist = playlistById(playlistId);
  const ids = playlistTracks(playlist).map((track) => track.id);
  if (!ids.length) {
    return;
  }

  recordRecentPlaylist(playlistId);
  playTrack(queueStartId(ids, startId), ids);
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
  return view === "albums" || view === "album" || view === "artist" || view === "tracks" || view === "playlist";
}

function syncNavIcons(entry) {
  const homeIcon = document.querySelector('.nav-stack [data-nav="home"] i');
  if (homeIcon) {
    homeIcon.className = entry.view === "home" ? "bi bi-house-fill" : "bi bi-house";
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

function applySidebarLayout() {
  if (!sidebar) {
    return;
  }

  const width = state.sidebarCollapsed ? SIDEBAR_COLLAPSED : state.sidebarWidth;
  document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  sidebar.classList.toggle("is-collapsed", state.sidebarCollapsed);
  sidebar.classList.toggle("is-resizing", false);

  if (sidebarCollapseBtn) {
    const icon = sidebarCollapseBtn.querySelector("i");
    const label = state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
    if (icon) {
      icon.className = state.sidebarCollapsed ? "bi bi-arrows-angle-expand" : "bi bi-arrows-angle-contract";
    }
    sidebarCollapseBtn.setAttribute("aria-label", label);
    const tip = bootstrap.Tooltip.getInstance(sidebarCollapseBtn);
    tip?.setContent({ ".tooltip-inner": label });
    sidebarCollapseBtn.setAttribute("data-bs-title", label);
  }
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

function sidebarPlaylists() {
  const liked = likedPlaylist();
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

function coverBackground(item) {
  if (item?.coverUrl) {
    return `background-image: url("${item.coverUrl}");`;
  }
  const color = item?.color || "#282828";
  return `background: linear-gradient(135deg, ${color}, #121212);`;
}

function playlistArtworkUrls(playlist) {
  const urls = [];
  for (const track of playlistTracks(playlist)) {
    if (track.coverUrl) {
      urls.push(track.coverUrl);
    }
  }
  return urls;
}

function playlistCoverMarkup(playlist, className) {
  if (isLikedPlaylist(playlist)) {
    return coverMarkup({ kind: "liked", title: playlist?.name }, className);
  }

  const urls = playlistArtworkUrls(playlist);
  if (urls.length >= 4) {
    const tiles = urls.slice(0, 4).map((url) => (
      `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">`
    )).join("");
    return `<div class="${className} cover-mosaic">${tiles}</div>`;
  }

  return coverMarkup(playlistCoverItem(playlist), className);
}

function coverMarkup(item, className) {
  if (item?.kind === "liked") {
    return `<div class="${className} cover-fallback liked-cover"><i class="bi bi-heart-fill"></i></div>`;
  }

  if (item?.coverUrl) {
    return `<img class="${className}" src="${escapeHtml(item.coverUrl)}" alt="" loading="lazy" decoding="async">`;
  }

  return `<div class="${className} cover-fallback" style="${coverBackground(item)}"><i class="bi bi-music-note-beamed"></i></div>`;
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

function setStageAccent(color, depth = 320) {
  mainStage.style.background = color
    ? `linear-gradient(180deg, ${color} 0%, var(--emp-bg) ${depth}px)`
    : "";
}

async function setStageAccentFromArt(coverUrl, fallbackColor, depth = 320) {
  if (coverUrl) {
    const color = await extractVibrantColor(coverUrl);
    if (color) {
      setStageAccent(color, depth);
      return;
    }
  }
  setStageAccent(fallbackColor, depth);
}

function matchesQuery(text, query) {
  return text.toLowerCase().includes(query);
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
  teardownTrackVirtual();
  closeContextMenu();
  closeOverflowMenu();
  closeDetailsModal();
  state.view = entry.view;
  state.albumId = entry.albumId ?? null;
  state.playlistId = entry.playlistId ?? null;
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
    searchInput.focus();
  }

  if (entry.view === "home") {
    setStageAccent("#1e3b2a");
    renderHome();
  } else if (entry.view === "search") {
    setStageAccent("#1f1f1f");
    renderSearch();
  } else if (entry.view === "albums") {
    setStageAccent("#3a1f12");
    renderAlbumGrid();
  } else if (entry.view === "tracks") {
    setStageAccent("#121826");
    renderAllTracks();
  } else if (entry.view === "album") {
    renderAlbum(entry.albumId);
  } else if (entry.view === "playlist") {
    renderPlaylist(entry.playlistId);
  } else if (entry.view === "artist") {
    renderArtist(entry.artist);
  } else if (entry.view === "settings") {
    setStageAccent("#1f1f1f");
    renderSettings();
  }

  renderLibraryList();
  updateCollectionControls();
  syncTopBarScroll();
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
      return `
        <li>
          <div class="playlist-row${playing ? " is-playing" : ""}${pinned ? " is-pinned" : ""}">
            <button class="playlist-item${state.view === "playlist" && state.playlistId === playlist.id ? " active" : ""}" type="button" data-open-playlist="${playlist.id}">
              <span class="playlist-cover-wrap">
                ${playlistCoverMarkup(playlist, "playlist-cover")}
              </span>
              <span class="playlist-meta">
                <span class="playlist-title">${escapeHtml(playlist.name)}</span>
                <span class="playlist-sub">Playlist • ${songLabel(tracks.length)}</span>
              </span>
            </button>
            ${sidebarPlayOverlay(`data-play-playlist="${playlist.id}"`, playlist.name, playing)}
          </div>
        </li>
      `;
    }).join("");
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
      <div class="media-sub">Playlist • ${songLabel(count)}</div>
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
      <button class="play-fab quick-play-fab${playing ? " is-playing" : ""}" type="button" tabindex="-1" data-play-album="${album.id}" title="${playing ? "Pause" : "Play"}" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(album.title)}">
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
      <button class="play-fab quick-play-fab${playing ? " is-playing" : ""}" type="button" tabindex="-1" data-play-playlist="${playlist.id}" title="${playing ? "Pause" : "Play"}" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(playlist.name)}">
        <i class="bi ${playing ? "bi-pause-fill" : "bi-play-fill"}"></i>
      </button>
    </div>
  `;
}

function homeQuickItems() {
  const items = [];
  const seenAlbums = new Set();
  const seenPlaylists = new Set();
  const liked = likedPlaylist();
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

function shelfSection(title, items, filter, { subtitleMode = "type" } = {}) {
  if (!items.length) {
    return "";
  }

  const shown = items.slice(0, HOME_SHELF_SIZE);
  const showAll = items.length > HOME_SHELF_SIZE;
  return `
    <section class="home-shelf">
      <div class="section-head">
        <button class="section-title-btn" type="button" data-nav="albums" data-filter="${filter}">
          <h2>${title}</h2>
        </button>
        ${showAll ? `<button class="see-all" type="button" data-nav="albums" data-filter="${filter}">See all</button>` : ""}
      </div>
      <div class="shelf-row">${shown.map((item) => shelfCard(item, subtitleMode)).join("")}</div>
    </section>
  `;
}

function renderHome() {
  const { albums, singles, tracks } = state.library;
  if (!tracks.length) {
    renderEmpty();
    return;
  }

  const recents = recentHomeItems();
  const quick = homeQuickItems();
  const accentAlbum = quick.find((item) => item.kind === "album")?.album
    || recents.find((item) => item.kind === "album")?.album
    || albums[0]
    || singles[0]
    || null;
  const accentPlaylist = !accentAlbum
    ? (quick.find((item) => item.kind === "playlist")?.playlist
      || recents.find((item) => item.kind === "playlist")?.playlist)
    : null;
  const coverUrl = accentAlbum?.coverUrl
    || (accentPlaylist ? playlistArtworkUrls(accentPlaylist)[0] : null)
    || null;
  const fallbackAccent = accentAlbum?.color || "#1e3b2a";
  setStageAccent(fallbackAccent, 300);
  setStageAccentFromArt(coverUrl, fallbackAccent, 300);

  viewArea.innerHTML = `
    <div class="home-page">
      <h1 class="greeting">${greeting()}</h1>
      ${quick.length ? `<div class="quick-grid">${quick.map(renderQuickCard).join("")}</div>` : ""}
      ${recents.length > HOME_QUICK_SIZE ? shelfSection("Recently played", recents, "all", { subtitleMode: "type" }) : ""}
      ${shelfSection("Albums", albumsByRecency(albums), "albums", { subtitleMode: "artist" })}
      ${shelfSection("Singles", albumsByRecency(singles), "singles", { subtitleMode: "artist" })}
    </div>
  `;
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
  const body = showingArtists
    ? (list
      ? `<div class="library-list">${artists.map(libraryArtistRow).join("")}</div>`
      : `<div class="card-grid">${artists.map(artistCard).join("")}</div>`)
    : (list
      ? `<div class="library-list">${albums.map(libraryAlbumRow).join("")}</div>`
      : `<div class="card-grid">${albums.map(albumCard).join("")}</div>`);

  viewArea.innerHTML = `
    <h1 class="greeting">${heading}</h1>
    <div class="library-toolbar">
      ${libraryFilterChips()}
      ${sortChips({ showLayout: true })}
    </div>
    <p class="collection-stat">${items.length} ${label}</p>
    ${body}
  `;
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

function renderSearch() {
  const query = state.query.trim().toLowerCase();
  if (!query) {
    viewArea.innerHTML = `
      <h1 class="greeting">Search</h1>
      <p class="text-secondary">Find albums, singles, and tracks in your library.</p>
    `;
    return;
  }

  const albums = allAlbums().filter((album) =>
    matchesQuery(`${album.title} ${album.artist}`, query));
  const tracks = state.library.tracks.filter((track) =>
    matchesQuery(`${track.title} ${track.artist} ${track.album}`, query));
  const shownAlbums = albums.slice(0, SEARCH_ALBUM_LIMIT);
  const shownTracks = tracks.slice(0, SEARCH_TRACK_LIMIT);

  viewArea.innerHTML = `
    <h1 class="greeting">Search</h1>
    ${shownAlbums.length ? `
      <div class="section-head">
        <h2>Albums</h2>
        ${albums.length > SEARCH_ALBUM_LIMIT ? `<span class="see-all">Showing ${shownAlbums.length} of ${albums.length}</span>` : ""}
      </div>
      <div class="card-grid">${shownAlbums.map(albumCard).join("")}</div>
    ` : ""}
    ${shownTracks.length ? `
      <div class="section-head ${shownAlbums.length ? "mt-4" : ""}">
        <h2>Songs</h2>
        ${tracks.length > SEARCH_TRACK_LIMIT ? `<span class="see-all">Showing ${shownTracks.length} of ${tracks.length}</span>` : ""}
      </div>
      ${trackTable(shownTracks, { showAlbum: true })}
    ` : ""}
    ${!albums.length && !tracks.length ? `<p class="text-secondary">No results for “${escapeHtml(state.query)}”.</p>` : ""}
  `;
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
        <h2>Playback</h2>
        <div class="settings-row">
          <div class="settings-copy">
            <span class="settings-label">Crossfade Songs</span>
          </div>
          ${settingSwitch("crossfade", state.crossfade, "Crossfade Songs")}
        </div>
        <div class="settings-row">
          <div class="settings-copy">
            <span class="settings-label">Gapless</span>
          </div>
          ${settingSwitch("gapless", state.gapless, "Gapless")}
        </div>
        <div class="settings-row">
          <div class="settings-copy">
            <span class="settings-label">Normalize volume</span>
            <span class="settings-desc">Set the same volume level for all songs</span>
          </div>
          ${settingSwitch("normalizeVolume", state.normalizeVolume, "Normalize volume")}
        </div>
        <div class="settings-row">
          <div class="settings-copy">
            <span class="settings-label">Equalizer</span>
          </div>
          ${settingSwitch("equalizerEnabled", state.equalizerEnabled, "Equalizer")}
        </div>
        ${equalizerMarkup}
      </section>
    </div>
  `;
  try {
    syncEqualizerUi();
  } catch {
    // Settings still render if the graph overlay cannot be drawn.
  }
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
      ${collectionActionsMarkup(album.title, `data-play-album="${album.id}"`)}
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

  const tracks = playlistTracks(playlist);
  const cover = playlistCoverItem(playlist);
  const totalDuration = tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  const album = albumById(tracks[0]?.albumId);
  const playlistFallback = isLikedPlaylist(playlist) ? "#450af5" : (album?.color || cover.color || "#3a1f12");
  setStageAccent(playlistFallback, 420);
  if (!isLikedPlaylist(playlist)) {
    const artUrl = cover.coverUrl || album?.coverUrl;
    setStageAccentFromArt(artUrl, playlistFallback, 420);
  }

  viewArea.innerHTML = `
    <div class="album-page">
      <div class="album-hero">
        ${playlistCoverMarkup(playlist, "album-hero-cover")}
        <div class="album-hero-text">
          <div class="album-kicker">Playlist</div>
          <h1>${escapeHtml(playlist.name)}</h1>
          <div class="album-meta">
            <span>${songLabel(tracks.length)}</span>
            <span class="album-meta-dot">•</span>
            <span>${formatCollectionDuration(totalDuration)}</span>
          </div>
        </div>
      </div>
      ${collectionActionsMarkup(playlist.name, `data-play-playlist="${playlist.id}"`, { more: true })}
      ${tracks.length
        ? `<div class="track-panel">${trackTable(tracks, { showAlbum: true, showCover: true, showHeader: true })}</div>`
        : `<p class="text-secondary">This playlist is empty. Right-click a track on an album to add songs.</p>`}
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
        <div class="section-head ${albums.length ? "mt-4" : ""}">
          <h2>Songs</h2>
        </div>
        <div class="track-panel">
          ${trackTable(tracks, { showAlbum: true, showHeader: true })}
        </div>
      ` : `<p class="text-secondary">No music found for this artist.</p>`}
    </div>
  `;

  requestArtistInfo(name);
}

function requestArtistInfo(name) {
  const requestId = ++artistInfoRequestId;
  const cached = artistInfoCache.get(name.toLowerCase());
  if (cached && hasArtistProfileData(cached)) {
    applyArtistInfo(cached);
    return;
  }

  showArtistInfoLoading();
  window.chrome?.webview?.postMessage({ type: "artistInfo", name });
  window.setTimeout(() => {
    if (requestId !== artistInfoRequestId) {
      return;
    }

    const slot = artistProfileSlot();
    if (slot?.querySelector(".artist-profile-loading")) {
      clearArtistProfile();
    }
  }, ARTIST_INFO_TIMEOUT_MS);
}

function applyArtistInfo(info) {
  if (!info?.name || state.view !== "artist" || !artistsMatch(info.name, state.artist)) {
    return;
  }

  if (hasArtistProfileData(info)) {
    artistInfoCache.set(info.name.toLowerCase(), info);
  }

  const slot = artistProfileSlot();
  if (!slot) {
    return;
  }

  const html = artistProfileMarkup(info);
  if (!html) {
    clearArtistProfile();
    return;
  }

  const wasLoading = Boolean(slot.querySelector(".artist-profile-loading"));
  slot.classList.remove("is-loading");
  slot.setAttribute("aria-busy", "false");
  slot.innerHTML = wasLoading
    ? `<div class="artist-profile-ready">${html}</div>`
    : html;
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

  viewArea.querySelectorAll(".home-shelf .media-card[data-open-album]").forEach((card) => {
    const playing = isSidebarAlbumPlaying(card.dataset.openAlbum);
    const fab = card.querySelector(".play-fab");
    card.classList.toggle("is-playing", playing);
    if (fab) {
      fab.classList.toggle("is-playing", playing);
      fab.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
      fab.title = playing ? "Pause" : "Play";
    }
  });
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

function playerOutputGain(player) {
  const normalize = state.normalizeVolume ? player.normalize : 1;
  return player.fade * normalize;
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
  previous.connect(masterGain);
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

function ensureAudioGraph() {
  if (audioGraphReady) {
    audioContext?.resume?.();
    return;
  }

  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) {
    return;
  }

  try {
    audioContext = new Context();
    masterGain = audioContext.createGain();
    masterGain.connect(audioContext.destination);

    let mixTarget = masterGain;
    try {
      mixTarget = createEqualizerChain() ?? masterGain;
    } catch {
      eqReady = false;
      eqPreamp = null;
      eqFilters = [];
      mixTarget = masterGain;
    }

    players.forEach((player) => {
      player.source = audioContext.createMediaElementSource(player.el);
      player.gain = audioContext.createGain();
      player.analyser = audioContext.createAnalyser();
      player.analyser.fftSize = 2048;
      player.source.connect(player.analyser);
      player.source.connect(player.gain);
      player.gain.connect(mixTarget);
      player.el.volume = 1;
    });
    audioGraphReady = true;
    try {
      applyEqualizer({ immediate: true });
    } catch {
      // Playback continues without EQ if coefficient apply fails.
    }
    audioContext.resume();
  } catch {
    audioGraphReady = false;
  }
}

function applyVolume() {
  const master = userVolumeGain();
  if (audioGraphReady && masterGain) {
    masterGain.gain.value = master;
    players.forEach((player) => {
      player.gain.gain.value = playerOutputGain(player);
      player.el.volume = 1;
    });
    return;
  }

  players.forEach((player) => {
    player.el.volume = clamp(master * playerOutputGain(player), 0, 1);
  });
}

function sampleRms(player) {
  if (!player.analyser) {
    return 0;
  }
  const buffer = new Float32Array(player.analyser.fftSize);
  player.analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

function applyCachedNormalize(player) {
  if (!player.trackId) {
    player.normalize = 1;
    return;
  }
  if (!state.normalizeVolume) {
    player.normalize = 1;
    return;
  }
  if (normalizeCache.has(player.trackId)) {
    player.normalize = normalizeCache.get(player.trackId);
  }
}

function refreshNormalize(player) {
  if (!state.normalizeVolume || !player.trackId || !audioGraphReady) {
    return;
  }
  if (normalizeCache.has(player.trackId)) {
    player.normalize = normalizeCache.get(player.trackId);
    applyVolume();
    return;
  }
  const rms = sampleRms(player);
  if (rms < 0.008) {
    return;
  }
  const gain = clamp(NORMALIZE_TARGET_RMS / rms, NORMALIZE_MIN_GAIN, NORMALIZE_MAX_GAIN);
  normalizeCache.set(player.trackId, gain);
  player.normalize = gain;
  applyVolume();
}

function stopPlayer(player) {
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
    applyCachedNormalize(incoming);
    return;
  }
  loadPlayer(incoming, track, { fade: 0 });
}

function maybePreloadNext() {
  if (playbackTransitioning || state.repeat === "one") {
    return;
  }
  if (!state.crossfade && !state.gapless) {
    return;
  }
  const el = currentAudio();
  const duration = el.duration || currentTrack()?.duration || 0;
  if (!duration || duration - el.currentTime > PRELOAD_SECONDS) {
    return;
  }
  const nextId = peekNextId({ wrap: state.repeat === "all" });
  const next = trackById(nextId);
  if (next) {
    ensureIncomingLoaded(next);
  }
}

function recordCurrentRecent() {
  const track = currentTrack();
  if (!track) {
    return;
  }
  recordRecentAlbum(track.albumId);
  recordRecentTrack(track.id);
}

async function startCrossfade(nextId) {
  if (playbackTransitioning) {
    return;
  }
  const next = trackById(nextId);
  if (!next) {
    return;
  }

  playbackTransitioning = true;
  ensureAudioGraph();
  const incoming = incomingPlayer();
  ensureIncomingLoaded(next);
  incoming.fade = 0;
  applyVolume();

  try {
    await incoming.el.play();
  } catch {
    playbackTransitioning = false;
    playTrack(nextId, null, { keepBag: true });
    return;
  }

  if (!playbackTransitioning) {
    return;
  }

  const remaining = Math.max(0.5, (currentAudio().duration || CROSSFADE_SECONDS) - currentAudio().currentTime);
  fadeDurationMs = Math.min(CROSSFADE_SECONDS, remaining) * 1000;
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
    if (playbackTransitioning) {
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

  playbackTransitioning = true;
  ensureAudioGraph();
  const incoming = incomingPlayer();
  ensureIncomingLoaded(next);
  incoming.fade = 1;
  applyVolume();

  try {
    await incoming.el.play();
  } catch {
    playbackTransitioning = false;
    playTrack(nextId, null, { keepBag: true });
    return;
  }

  if (!playbackTransitioning) {
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
  if (!state.playing || playbackTransitioning || state.repeat === "one" || state.seeking) {
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
  if (state.crossfade && remaining <= CROSSFADE_SECONDS && remaining > 0.05) {
    startCrossfade(nextId);
    return;
  }
  if (state.gapless && remaining <= GAPLESS_LEAD_SECONDS) {
    startGapless(nextId);
  }
}

function applyPlaybackSettings() {
  applyCachedNormalize(currentPlayer());
  applyCachedNormalize(incomingPlayer());
  if (!state.normalizeVolume) {
    currentPlayer().normalize = 1;
    incomingPlayer().normalize = 1;
  }
  applyVolume();

  if (!state.crossfade && !state.gapless && !playbackTransitioning) {
    stopPlayer(incomingPlayer());
    return;
  }
  maybePreloadNext();
}

function postAppSettings() {
  window.chrome?.webview?.postMessage({
    type: "appSettings",
    startupOnLogin: state.startupOnLogin,
    closeMinimizes: state.closeMinimizes
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
  writeSession();
  syncStartupSettingsUi();
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
  state[key] = Boolean(value);
  writeSession();
  if (key === "equalizerEnabled") {
    applyEqualizer();
  } else {
    applyPlaybackSettings();
  }
  if (state.view === "settings") {
    const toggle = viewArea.querySelector(`[data-setting="${key}"]`);
    if (toggle) {
      toggle.setAttribute("aria-checked", state[key] ? "true" : "false");
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
    postNowPlaying();
    return;
  }

  nowCover.removeAttribute("style");
  if (track.coverUrl) {
    nowCover.classList.remove("cover-fallback");
    nowCover.innerHTML = `<img src="${escapeHtml(track.coverUrl)}" alt="">`;
  } else {
    nowCover.classList.add("cover-fallback");
    nowCover.setAttribute("style", coverBackground(track));
    nowCover.innerHTML = '<i class="bi bi-music-note-beamed"></i>';
  }
  nowTitle.textContent = track.title;
  nowArtist.textContent = track.artist;
  setNowPlayingInteractive(true);
  durationEl.textContent = formatTime(currentAudio().duration || track.duration);
  elapsedEl.textContent = formatTime(currentAudio().currentTime || 0);
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
  updateSlider(seekBar);
  updateSlider(volumeBar);
  postNowPlaying();
}

async function playTrack(id, queueIds, options = {}) {
  const autoplay = options.autoplay !== false;
  const position = Number(options.position) || 0;
  state.holdEnded = false;
  cancelTransition();

  if (queueIds) {
    state.queue = [...queueIds];
  } else if (!state.queue.length) {
    state.queue = state.library.tracks.map((track) => track.id);
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

  const track = currentTrack();
  if (!track) {
    return;
  }

  if (options.recordRecent !== false) {
    recordRecentAlbum(track.albumId);
    recordRecentTrack(track.id);
  }

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

function seekBy(seconds) {
  const el = currentAudio();
  const duration = el.duration || currentTrack()?.duration || 0;
  if (!duration) {
    return;
  }

  el.currentTime = Math.max(0, Math.min(duration, (el.currentTime || 0) + seconds));
  lastAudioTime = el.currentTime;
  updateNowPlaying();
  writeSession();
}

async function restoreSession() {
  const session = readSession();
  if (!session) {
    updateNowPlaying();
    return;
  }

  const queue = Array.isArray(session.queue)
    ? session.queue.filter((id) => trackById(id))
    : [];
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
  if (state.shuffle && Array.isArray(session.shuffleBag)) {
    state.shuffleBag = session.shuffleBag.filter((id) => trackById(id) && restoredQueue.includes(id));
  }

  await playTrack(trackId, restoredQueue, {
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
  if (state.view === "artist") {
    return artistQueueIds(state.artist);
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
  if (state.view === "playlist" && state.playlistId === playlist.id) {
    render(historyStack[historyIndex]);
  } else {
    renderLibraryList();
  }
}

function collectionActionsMarkup(label, playAttrs, { more = false } = {}) {
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
    </div>
  `;
}

function updateCollectionControls() {
  const play = viewArea.querySelector(".play-fab-lg");
  if (!play) {
    return;
  }

  const current = collectionIsCurrent();
  const playing = current && state.playing;
  play.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
  play.setAttribute("aria-label", playing ? "Pause" : "Play");

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
  playTrack(queueStartId(ids, startId), ids);
}

function playArtist(name, startId) {
  const ids = artistQueueIds(name);
  if (!ids.length) {
    return;
  }
  playTrack(queueStartId(ids, startId), ids);
}

function togglePlay() {
  const track = currentTrack();
  if (!track) {
    const first = state.library.tracks[0];
    if (first) {
      playTrack(first.id, state.library.tracks.map((item) => item.id));
    }
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
  updateNowPlaying();
  writeSession();
}

function stopAtEndOfQueue() {
  state.holdEnded = true;
  state.playing = false;
  cancelTransition();
  currentAudio().pause();
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
  const el = currentAudio();
  if (el.currentTime > 3) {
    el.currentTime = 0;
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
  if (matched) {
    pendingRescanId = "";
  }

  if (!failed) {
    const previousTracks = captureActiveTracks();
    state.library = {
      rootPath: library.rootPath ?? "",
      folders: Array.isArray(library.folders) ? library.folders : [],
      albums: library.albums ?? [],
      singles: library.singles ?? [],
      tracks: library.tracks ?? []
    };
    retainActiveTracks(previousTracks);
  }

  // While the button animates, only its own library message may re-render the view.
  if (matched && busy) {
    finishRescan(button, failed);
  } else if (!busy) {
    render(historyStack[historyIndex]);
  }

  if (!sessionRestored) {
    sessionRestored = true;
    restoreSession();
    return;
  }

  updateNowPlaying();
}

function isTypingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

let contextRoot = null;
const contextMenuState = {
  trackId: null,
  playlistId: null,
  naming: false,
  query: ""
};

function closeContextMenu() {
  if (!contextRoot || contextRoot.hidden) {
    contextMenuState.trackId = null;
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
      <button class="ctx-item ctx-item-danger" type="button" data-playlist-delete>
        <i class="bi bi-trash3"></i>
        <span>Delete Playlist</span>
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
    if (event.target.closest("[data-playlist-delete]")) {
      closeOverflowMenu();
      openDeletePlaylistModal();
    }
  });
  overflowRoot.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return overflowRoot;
}

function openOverflowMenu(anchor) {
  closeContextMenu();
  const root = ensureOverflowRoot();
  const deleteBtn = root.querySelector("[data-playlist-delete]");
  const playlist = playlistById(state.playlistId);
  if (deleteBtn) {
    deleteBtn.hidden = !!(playlist && isLikedPlaylist(playlist));
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
  state.playlists = state.playlists.filter((p) => p.id !== playlistId);
  writeSession();
  navigate({ view: "home" });
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
  const playlistMode = Boolean(contextMenuState.playlistId);
  if (actions) {
    actions.hidden = !playlistMode;
  }
  if (!likeBtn || !likeLabel) {
    return;
  }

  const onLikedPlaylist = isLikedPlaylist(playlistById(contextMenuState.playlistId));
  likeBtn.hidden = onLikedPlaylist;
  const liked = state.liked.has(contextMenuState.trackId);
  likeLabel.textContent = liked ? "Remove from your Liked Songs" : "Save to your Liked Songs";
}

function openContextMenu(trackId, x, y) {
  closeOverflowMenu();
  const root = ensureContextRoot();
  contextMenuState.trackId = trackId;
  contextMenuState.playlistId = state.view === "playlist" ? state.playlistId : null;
  updateContextPlaylistActions();
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
  const collectionShuffleButton = event.target.closest("[data-collection-shuffle]");
  const playPlaylistButton = event.target.closest("[data-play-playlist]");
  const playlistButton = event.target.closest("[data-open-playlist]");
  const playAlbumButton = event.target.closest("[data-play-album]");
  const playArtistButton = event.target.closest("[data-play-artist]");
  const artistButton = event.target.closest("[data-open-artist]");
  const albumButton = event.target.closest("[data-open-album]");
  const playButton = event.target.closest("[data-play-id]");
  const sortButton = event.target.closest("[data-sort]");
  const layoutButton = event.target.closest("[data-layout]");
  const navButton = event.target.closest("[data-nav]");

  if (settingButton) {
    event.preventDefault();
    const key = settingButton.dataset.setting;
    if (key === "crossfade" || key === "gapless" || key === "normalizeVolume" || key === "equalizerEnabled") {
      setPlaybackSetting(key, !state[key]);
    } else if (key === "closeMinimizes") {
      setCloseMinimizes(!state.closeMinimizes);
    }
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
    const album = albumById(state.albumId);
    const playlist = playlistById(state.playlistId);
    let queue;
    if (playButton.closest("#libraryList")) {
      queue = recentTracks(MAX_RECENTS).map((track) => track.id);
    } else if (state.view === "album" && album) {
      queue = albumQueueIds(album);
    } else if (state.view === "playlist" && playlist) {
      queue = playlistTracks(playlist).map((track) => track.id);
      recordRecentPlaylist(playlist.id);
    } else if (state.view === "artist" && state.artist) {
      queue = artistQueueIds(state.artist);
    } else {
      queue = state.library.tracks.map((track) => track.id);
    }
    playTrack(id, queue);
    return;
  }

  if (sortButton) {
    state.librarySort = normalizeSort(sortButton.dataset.sort);
    writeSession();
    render(historyStack[historyIndex]);
    return;
  }

  if (layoutButton) {
    state.libraryLayout = normalizeLayout(layoutButton.dataset.layout);
    writeSession();
    render(historyStack[historyIndex]);
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
  const allowed = state.view === "album" || state.view === "artist" || state.view === "playlist" || state.view === "search";
  if (!row || !allowed) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const trackId = row.dataset.playId;
  if (!trackId) {
    return;
  }

  openContextMenu(trackId, event.clientX, event.clientY);
});

viewArea.addEventListener("scroll", () => {
  closeContextMenu();
  closeOverflowMenu();
  closeEqPresetMenu();
  syncTopBarScroll();
});
window.addEventListener("resize", () => {
  closeContextMenu();
  closeOverflowMenu();
  closeEqPresetMenu();
  updateLibraryChipsScroll();
  syncTopBarScroll();
});

function syncTopBarScroll() {
  const topBar = document.querySelector(".top-bar");
  if (!topBar) {
    return;
  }
  document.documentElement.style.setProperty("--top-bar-height", `${topBar.offsetHeight}px`);
  topBar.classList.toggle("is-scrolled", viewArea.scrollTop > 8);
}

viewArea.addEventListener("input", (event) => {
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
  createPlaylistFromSidebar();
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

  const onMove = (event) => {
    if (!dragging) {
      return;
    }
    const delta = event.clientX - startX;
    state.sidebarWidth = normalizeSidebarWidth(startWidth + delta);
    document.documentElement.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
  };

  const onUp = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    sidebar.classList.remove("is-resizing");
    document.body.style.cursor = "";
    writeSession();
    updateLibraryChipsScroll();
  };

  sidebarResize.addEventListener("pointerdown", (event) => {
    if (state.sidebarCollapsed || event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startWidth = state.sidebarWidth;
    sidebar.classList.add("is-resizing");
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

searchInput.addEventListener("input", () => {
  state.query = searchInput.value;
  const entry = { view: "search", query: state.query };
  historyStack[historyIndex] = entry;
  render(entry);
});

nowCover.addEventListener("click", openNowPlayingAlbum);
nowTitle.addEventListener("click", openNowPlayingAlbum);
nowArtist.addEventListener("click", openNowPlayingArtist);

playBtn.addEventListener("click", togglePlay);
document.getElementById("nextBtn").addEventListener("click", () => nextTrack({ wrap: true }));
document.getElementById("prevBtn").addEventListener("click", previousTrack);

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
  state.seeking = true;
  const duration = currentAudio().duration || currentTrack()?.duration || 0;
  elapsedEl.textContent = formatTime((Number(seekBar.value) / 1000) * duration);
  updateSlider(seekBar);
});

seekBar.addEventListener("change", () => {
  const el = currentAudio();
  const duration = el.duration || currentTrack()?.duration || 0;
  el.currentTime = (Number(seekBar.value) / 1000) * duration;
  lastAudioTime = el.currentTime;
  state.seeking = false;
  updateSlider(seekBar);
  writeSession();
});

volumeBar.addEventListener("input", () => {
  state.volume = Number(volumeBar.value);
  state.muted = state.volume === 0;
  if (state.volume > 0) {
    state.lastVolume = state.volume;
  }
  applyVolume();
  updateNowPlaying();
  writeSession();
});

muteBtn.addEventListener("click", () => {
  state.muted = !state.muted;
  if (state.muted) {
    state.lastVolume = state.volume || state.lastVolume;
    volumeBar.value = "0";
  } else {
    state.volume = state.lastVolume || 80;
    volumeBar.value = String(state.volume);
  }
  applyVolume();
  updateNowPlaying();
  writeSession();
});

function bindPlaybackElement(el) {
  el.addEventListener("timeupdate", () => {
    if (el !== currentAudio()) {
      return;
    }

    refreshNormalize(currentPlayer());

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
    writeSessionThrottled();
    maybePreloadNext();
    maybeStartAutoAdvance();
  });

  el.addEventListener("loadedmetadata", () => {
    if (el !== currentAudio()) {
      return;
    }
    durationEl.textContent = formatTime(el.duration);
  });

  el.addEventListener("ended", () => {
    if (el !== currentAudio() || playbackTransitioning) {
      return;
    }
    if (state.repeat === "one") {
      state.holdEnded = false;
      el.currentTime = 0;
      el.play();
      return;
    }
    nextTrack({ wrap: state.repeat === "all" });
  });

  el.addEventListener("play", () => {
    if (el !== currentAudio()) {
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

  el.addEventListener("pause", () => {
    if (el !== currentAudio() || playbackTransitioning) {
      return;
    }
    if (!el.ended) {
      state.playing = false;
      updateNowPlaying();
      writeSession();
    }
  });
}

players.forEach((player) => bindPlaybackElement(player.el));

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    writeSession();
  }
});

window.addEventListener("pagehide", writeSession);

document.addEventListener("keydown", (event) => {
  if (event.code === "Escape") {
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

applySidebarLayout();
syncSidebarSortUi();
updateLibraryChipsScroll();
syncTopBarScroll();

window.addEventListener("emp-library", (event) => bindLibrary(event.detail));
window.addEventListener("emp-artist-info", (event) => applyArtistInfo(event.detail));
window.addEventListener("emp-app-settings", (event) => applyHostAppSettings(event.detail));
if (window.__emp?.library) {
  bindLibrary(window.__emp.library);
}

updateRepeatButton();
updateSlider(volumeBar);
updateSlider(seekBar);
