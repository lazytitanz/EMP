const audio = new Audio();
audio.preload = "metadata";
audio.loop = false;

const state = {
  library: { rootPath: "", albums: [], singles: [], tracks: [] },
  view: "home",
  albumId: null,
  query: "",
  queue: [],
  index: -1,
  playing: false,
  seeking: false,
  shuffle: false,
  repeat: false,
  liked: new Set(),
  volume: 80,
  muted: false,
  lastVolume: 80,
  recentAlbumIds: [],
  albumFilter: "all",
  holdEnded: false
};

const historyStack = [{ view: "home" }];
let historyIndex = 0;

const viewArea = document.getElementById("viewArea");
const libraryList = document.getElementById("libraryList");
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
const HOME_QUICK_SIZE = 6;
const HOME_SHELF_SIZE = 8;
const SIDEBAR_RECENTS = 12;
const MAX_RECENTS = 24;
const SEARCH_ALBUM_LIMIT = 12;
const SEARCH_TRACK_LIMIT = 40;
const TRACK_ROW_HEIGHT = 58;
let sessionRestored = false;
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

function writeSession() {
  const track = currentTrack();
  const payload = {
    trackId: track?.id ?? null,
    queue: state.queue,
    index: state.index,
    position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    volume: state.volume,
    lastVolume: state.lastVolume,
    muted: state.muted,
    shuffle: state.shuffle,
    repeat: state.repeat,
    recentAlbumIds: state.recentAlbumIds
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
  state.repeat = Boolean(session.repeat);
  if (Array.isArray(session.recentAlbumIds)) {
    state.recentAlbumIds = session.recentAlbumIds.filter((id) => typeof id === "string");
  }
  volumeBar.value = state.muted ? "0" : String(state.volume);
  applyVolume();
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

function allAlbums() {
  return [...state.library.albums, ...state.library.singles];
}

function albumById(id) {
  return allAlbums().find((album) => album.id === id);
}

function trackById(id) {
  return state.library.tracks.find((track) => track.id === id);
}

function currentTrack() {
  return trackById(state.queue[state.index]) ?? null;
}

function recentAlbums(limit = MAX_RECENTS) {
  return state.recentAlbumIds
    .map((id) => albumById(id))
    .filter(Boolean)
    .slice(0, limit);
}

function albumsByRecency(list) {
  const rank = new Map(state.recentAlbumIds.map((id, index) => [id, index]));
  return [...list].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const artist = left.artist.localeCompare(right.artist, undefined, { sensitivity: "base" });
    if (artist !== 0) {
      return artist;
    }

    return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  });
}

function recordRecentAlbum(albumId) {
  if (!albumId) {
    return;
  }

  state.recentAlbumIds = [albumId, ...state.recentAlbumIds.filter((id) => id !== albumId)]
    .slice(0, MAX_RECENTS);
  renderLibraryList();
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

function coverMarkup(item, className) {
  if (item?.coverUrl) {
    return `<img class="${className}" src="${escapeHtml(item.coverUrl)}" alt="" loading="lazy" decoding="async">`;
  }

  return `<div class="${className} cover-fallback" style="${coverBackground(item)}"><i class="bi bi-music-note-beamed"></i></div>`;
}

function songLabel(count) {
  return `${count} ${count === 1 ? "song" : "songs"}`;
}

function setStageAccent(color) {
  mainStage.style.background = color
    ? `linear-gradient(180deg, ${color} 0%, var(--emp-bg) 320px)`
    : "";
}

function matchesQuery(text, query) {
  return text.toLowerCase().includes(query);
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
  state.view = entry.view;
  state.albumId = entry.albumId ?? null;
  state.query = entry.query ?? state.query;
  if (entry.view === "albums") {
    state.albumFilter = entry.filter ?? "all";
  }

  document.querySelectorAll("[data-nav]").forEach((item) => {
    const isChip = item.classList.contains("chip");
    const active = item.dataset.nav === entry.view || (entry.view === "album" && item.dataset.nav === "albums" && isChip);
    item.classList.toggle("active", active);
  });

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
  }

  renderLibraryList();
}

function renderLibraryList() {
  const recents = recentAlbums(SIDEBAR_RECENTS);
  if (!recents.length) {
    libraryList.innerHTML = `<li class="playlist-sub px-3 py-2">Play something to see recents</li>`;
    return;
  }

  libraryList.innerHTML = recents.map((album) => `
    <li>
      <button class="playlist-item${state.albumId === album.id ? " active" : ""}" type="button" data-open-album="${album.id}">
        ${coverMarkup(album, "playlist-cover")}
        <span class="playlist-meta">
          <span class="playlist-title">${escapeHtml(album.title)}</span>
          <span class="playlist-sub">${album.isSingle ? "Single" : "Album"} • ${escapeHtml(album.artist)}</span>
        </span>
      </button>
    </li>
  `).join("");
}

function albumCard(album) {
  return `
    <article class="media-card" data-open-album="${album.id}">
      <div class="media-cover-wrap">
        ${coverMarkup(album, "media-cover")}
        <button class="play-fab" type="button" data-play-album="${album.id}" title="Play" aria-label="Play ${escapeHtml(album.title)}">
          <i class="bi bi-play-fill"></i>
        </button>
      </div>
      <div class="media-title">${escapeHtml(album.title)}</div>
      <div class="media-sub">${album.isSingle ? "Single" : "Album"} • ${escapeHtml(album.artist)}</div>
    </article>
  `;
}

function quickCard(album) {
  return `
    <button class="quick-card" type="button" data-open-album="${album.id}">
      ${coverMarkup(album, "playlist-cover")}
      <span>${escapeHtml(album.title)}</span>
    </button>
  `;
}

function shelfSection(title, items, filter) {
  if (!items.length) {
    return "";
  }

  const shown = items.slice(0, HOME_SHELF_SIZE);
  const showAll = items.length > HOME_SHELF_SIZE;
  return `
    <div class="section-head">
      <h2>${title}</h2>
      ${showAll ? `<button class="see-all" type="button" data-nav="albums" data-filter="${filter}">Show all</button>` : ""}
    </div>
    <div class="shelf-row">${shown.map(albumCard).join("")}</div>
  `;
}

function renderHome() {
  const { albums, singles, tracks } = state.library;
  if (!tracks.length) {
    renderEmpty();
    return;
  }

  const recents = recentAlbums();
  const quick = recents.slice(0, HOME_QUICK_SIZE);

  viewArea.innerHTML = `
    <h1 class="greeting">${greeting()}</h1>
    <p class="collection-stat">${albums.length} albums • ${singles.length} singles • ${tracks.length} tracks</p>
    ${quick.length ? `<div class="quick-grid">${quick.map(quickCard).join("")}</div>` : ""}
    ${recents.length > HOME_QUICK_SIZE ? shelfSection("Recently played", recents, "all") : ""}
    ${shelfSection("Albums", albumsByRecency(albums), "albums")}
    ${shelfSection("Singles", albumsByRecency(singles), "singles")}
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
  const albums = albumsByRecency(catalogAlbums());
  if (!albums.length) {
    renderEmpty();
    return;
  }

  const label = state.albumFilter === "singles"
    ? "singles"
    : state.albumFilter === "albums"
      ? "albums"
      : "albums & singles";

  viewArea.innerHTML = `
    <h1 class="greeting">${state.albumFilter === "singles" ? "Singles" : "Albums"}</h1>
    <div class="library-chips mb-3">
      <button class="chip${state.albumFilter === "all" ? " active" : ""}" type="button" data-nav="albums" data-filter="all">All</button>
      <button class="chip${state.albumFilter === "albums" ? " active" : ""}" type="button" data-nav="albums" data-filter="albums">Albums</button>
      <button class="chip${state.albumFilter === "singles" ? " active" : ""}" type="button" data-nav="albums" data-filter="singles">Singles</button>
    </div>
    <p class="collection-stat">${albums.length} ${label}</p>
    <div class="card-grid">${albums.map(albumCard).join("")}</div>
  `;
}

function renderAllTracks() {
  if (!state.library.tracks.length) {
    renderEmpty();
    return;
  }

  viewArea.innerHTML = `
    <h1 class="greeting">All tracks</h1>
    <p class="collection-stat">${songLabel(state.library.tracks.length)}</p>
    <div class="track-table virtual-track-table" id="virtualTrackTable">
      <div class="virtual-spacer" id="virtualTrackSpacer"></div>
    </div>
  `;
  mountTrackVirtual(state.library.tracks, true);
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

function renderAlbum(albumId) {
  const album = albumById(albumId);
  if (!album) {
    renderHome();
    return;
  }

  const tracks = album.trackIds.map(trackById).filter(Boolean);
  setStageAccent(album.color);

  viewArea.innerHTML = `
    <div class="album-hero">
      ${coverMarkup(album, "album-hero-cover")}
      <div>
        <div class="album-kicker">${album.isSingle ? "Single" : "Album"}</div>
        <h1>${escapeHtml(album.title)}</h1>
        <div class="album-meta">
          <strong>${escapeHtml(album.artist)}</strong>
          ${album.year ? ` • ${album.year}` : ""}
          • ${songLabel(album.trackCount)}
        </div>
      </div>
    </div>
    <button class="play-fab-lg" type="button" data-play-album="${album.id}" aria-label="Play">
      <i class="bi bi-play-fill"></i>
    </button>
    ${trackTable(tracks, { showAlbum: false })}
  `;
}

function renderEmpty() {
  viewArea.innerHTML = `
    <div class="empty-state">
      <h2>No music found</h2>
      <p>EMP looks in your Music folder. Add albums or singles there, then refresh your library.</p>
    </div>
  `;
}

function trackRow(track, index, showAlbum, currentId) {
  return `
    <div class="track-row${showAlbum ? " with-album" : ""}${currentId === track.id ? " playing" : ""}" data-play-id="${track.id}">
      <div class="track-index">
        <span class="track-index-number">${track.trackNumber || index + 1}</span>
        <i class="bi bi-play-fill track-play-icon"></i>
      </div>
      <button type="button" data-play-id="${track.id}">
        <span class="track-main">
          ${coverMarkup(track, "playlist-cover")}
          <span>
            <span class="track-name${currentId === track.id ? " playing" : ""}">${escapeHtml(track.title)}</span><br>
            <span>${escapeHtml(track.artist)}</span>
          </span>
        </span>
      </button>
      ${showAlbum ? `<button class="track-link" type="button" data-open-album="${track.albumId}">${escapeHtml(track.album)}</button>` : "<span></span>"}
      <div>${formatTime(track.duration)}</div>
    </div>
  `;
}

function trackTable(tracks, { showAlbum }) {
  const currentId = currentTrack()?.id;
  return `
    <div class="track-table">
      ${tracks.map((track, index) => trackRow(track, index, showAlbum, currentId)).join("")}
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
    row.classList.toggle("playing", row.dataset.playId === id);
  });
  document.querySelectorAll(".track-name").forEach((name) => {
    const row = name.closest(".track-row");
    name.classList.toggle("playing", row?.dataset.playId === id);
  });
}

function applyVolume() {
  audio.volume = state.muted ? 0 : state.volume / 100;
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

function updateNowPlaying() {
  const track = currentTrack();
  if (!track) {
    nowCover.removeAttribute("style");
    nowCover.innerHTML = "";
    nowCover.classList.remove("cover-fallback");
    nowTitle.textContent = "Select a track";
    nowArtist.textContent = "EMP";
    elapsedEl.textContent = "0:00";
    durationEl.textContent = "0:00";
    playBtn.innerHTML = '<i class="bi bi-play-fill"></i>';
    updateSlider(seekBar);
    updateSlider(volumeBar);
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
  durationEl.textContent = formatTime(audio.duration || track.duration);
  elapsedEl.textContent = formatTime(audio.currentTime || 0);
  playBtn.innerHTML = state.playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
  playBtn.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  likeBtn.innerHTML = state.liked.has(track.id) ? '<i class="bi bi-heart-fill"></i>' : '<i class="bi bi-heart"></i>';
  likeBtn.classList.toggle("active", state.liked.has(track.id));
  shuffleBtn.classList.toggle("active", state.shuffle);
  repeatBtn.classList.toggle("active", state.repeat);

  const volumeIcon = state.muted || state.volume === 0
    ? "bi-volume-mute-fill"
    : state.volume < 40
      ? "bi-volume-down-fill"
      : "bi-volume-up-fill";
  muteBtn.innerHTML = `<i class="bi ${volumeIcon}"></i>`;
  highlightPlaying();
  trackVirtual?.paint();
  updateSlider(seekBar);
  updateSlider(volumeBar);
}

async function playTrack(id, queueIds, options = {}) {
  const autoplay = options.autoplay !== false;
  const position = Number(options.position) || 0;
  state.holdEnded = false;

  if (queueIds) {
    state.queue = [...queueIds];
  } else if (!state.queue.length) {
    state.queue = state.library.tracks.map((track) => track.id);
  }

  const index = state.queue.indexOf(id);
  state.index = index >= 0 ? index : 0;
  const track = currentTrack();
  if (!track) {
    return;
  }

  if (options.recordRecent !== false) {
    recordRecentAlbum(track.albumId);
  }

  audio.src = track.url;
  applyVolume();
  lastAudioTime = position;

  if (position > 0) {
    await seekWhenReady(position, track.duration);
  }

  if (autoplay) {
    try {
      await audio.play();
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
  return new Promise((resolve) => {
    const apply = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : fallbackDuration || 0;
      audio.currentTime = duration > 0 ? Math.min(position, Math.max(0, duration - 0.25)) : position;
      resolve();
    };

    if (audio.readyState >= 1) {
      apply();
      return;
    }

    const onMeta = () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      apply();
    };

    audio.addEventListener("loadedmetadata", onMeta);
    window.setTimeout(() => {
      audio.removeEventListener("loadedmetadata", onMeta);
      apply();
    }, 1500);
  });
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
      renderLibraryList();
    }
  }

  const restoredQueue = queue.length ? queue : state.library.tracks.map((track) => track.id);
  await playTrack(trackId, restoredQueue, {
    autoplay: false,
    recordRecent: false,
    position: Math.max(0, Number(session.position) || 0)
  });
}

function playAlbum(albumId) {
  const album = albumById(albumId);
  if (!album?.trackIds.length) {
    return;
  }
  playTrack(album.trackIds[0], album.trackIds);
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

  if (state.playing) {
    audio.pause();
    state.playing = false;
  } else {
    state.holdEnded = false;
    if (audio.ended || (audio.duration > 0 && audio.currentTime >= audio.duration - 0.05)) {
      audio.currentTime = 0;
      lastAudioTime = 0;
    }
    audio.play();
    state.playing = true;
  }
  updateNowPlaying();
  writeSession();
}

function stopAtEndOfQueue() {
  state.holdEnded = true;
  state.playing = false;
  audio.pause();
  updateNowPlaying();
  writeSession();
}

function hasNextTrack() {
  if (state.queue.length <= 1) {
    return false;
  }
  if (state.shuffle) {
    return true;
  }
  return state.index + 1 < state.queue.length;
}

function nextTrack({ wrap = true } = {}) {
  if (!state.queue.length) {
    return;
  }

  if (!wrap && !hasNextTrack()) {
    stopAtEndOfQueue();
    return;
  }

  if (state.shuffle) {
    if (state.queue.length === 1) {
      return;
    }

    let nextIndex = state.index;
    while (nextIndex === state.index) {
      nextIndex = Math.floor(Math.random() * state.queue.length);
    }
    state.index = nextIndex;
  } else if (state.index + 1 >= state.queue.length) {
    if (!wrap) {
      stopAtEndOfQueue();
      return;
    }
    state.index = 0;
  } else {
    state.index += 1;
  }

  playTrack(state.queue[state.index]);
}

function previousTrack() {
  if (!state.queue.length) {
    return;
  }
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    updateNowPlaying();
    writeSession();
    return;
  }
  state.index = (state.index - 1 + state.queue.length) % state.queue.length;
  playTrack(state.queue[state.index]);
}

function bindLibrary(library) {
  state.library = {
    rootPath: library.rootPath ?? "",
    albums: library.albums ?? [],
    singles: library.singles ?? [],
    tracks: library.tracks ?? []
  };
  render(historyStack[historyIndex]);

  if (!sessionRestored) {
    sessionRestored = true;
    restoreSession();
    return;
  }

  updateNowPlaying();
}

document.body.addEventListener("click", (event) => {
  const playAlbumButton = event.target.closest("[data-play-album]");
  const albumButton = event.target.closest("[data-open-album]");
  const playButton = event.target.closest("[data-play-id]");
  const navButton = event.target.closest("[data-nav]");

  if (playAlbumButton) {
    event.preventDefault();
    event.stopPropagation();
    playAlbum(playAlbumButton.dataset.playAlbum);
    return;
  }

  if (albumButton) {
    navigate({ view: "album", albumId: albumButton.dataset.openAlbum });
    return;
  }

  if (playButton) {
    const id = playButton.dataset.playId;
    const album = albumById(state.albumId);
    const queue = state.view === "album" && album
      ? album.trackIds
      : state.library.tracks.map((track) => track.id);
    playTrack(id, queue);
    return;
  }

  if (navButton) {
    const entry = { view: navButton.dataset.nav };
    if (navButton.dataset.filter) {
      entry.filter = navButton.dataset.filter;
    }
    navigate(entry);
  }
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

searchInput.addEventListener("input", () => {
  state.query = searchInput.value;
  const entry = { view: "search", query: state.query };
  historyStack[historyIndex] = entry;
  render(entry);
});

playBtn.addEventListener("click", togglePlay);
document.getElementById("nextBtn").addEventListener("click", () => nextTrack({ wrap: true }));
document.getElementById("prevBtn").addEventListener("click", previousTrack);

shuffleBtn.addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  updateNowPlaying();
  writeSession();
});

repeatBtn.addEventListener("click", () => {
  state.repeat = !state.repeat;
  updateNowPlaying();
  writeSession();
});

likeBtn.addEventListener("click", () => {
  const track = currentTrack();
  if (!track) {
    return;
  }
  if (state.liked.has(track.id)) {
    state.liked.delete(track.id);
  } else {
    state.liked.add(track.id);
  }
  updateNowPlaying();
});

seekBar.addEventListener("input", () => {
  state.seeking = true;
  const duration = audio.duration || currentTrack()?.duration || 0;
  elapsedEl.textContent = formatTime((Number(seekBar.value) / 1000) * duration);
  updateSlider(seekBar);
});

seekBar.addEventListener("change", () => {
  const duration = audio.duration || currentTrack()?.duration || 0;
  audio.currentTime = (Number(seekBar.value) / 1000) * duration;
  lastAudioTime = audio.currentTime;
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

audio.addEventListener("timeupdate", () => {
  if (state.seeking) {
    lastAudioTime = audio.currentTime;
    return;
  }

  const duration = audio.duration || currentTrack()?.duration || 1;
  if (
    !state.repeat
    && state.playing
    && duration > 1
    && lastAudioTime >= duration * 0.9
    && audio.currentTime < 0.4
  ) {
    stopAtEndOfQueue();
    lastAudioTime = 0;
    return;
  }

  lastAudioTime = audio.currentTime;
  elapsedEl.textContent = formatTime(audio.currentTime);
  seekBar.value = String(Math.round((audio.currentTime / duration) * 1000));
  updateSlider(seekBar);
  writeSessionThrottled();
});

audio.addEventListener("loadedmetadata", () => {
  durationEl.textContent = formatTime(audio.duration);
});

audio.addEventListener("ended", () => {
  if (state.repeat) {
    state.holdEnded = false;
    audio.currentTime = 0;
    audio.play();
    return;
  }
  nextTrack({ wrap: false });
});

audio.addEventListener("play", () => {
  if (state.holdEnded && !state.repeat) {
    audio.pause();
    state.playing = false;
    return;
  }
  state.holdEnded = false;
  state.playing = true;
  updateNowPlaying();
  writeSession();
});

audio.addEventListener("pause", () => {
  if (!audio.ended) {
    state.playing = false;
    updateNowPlaying();
    writeSession();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    writeSession();
  }
});

window.addEventListener("pagehide", writeSession);

document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    togglePlay();
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

window.addEventListener("emp-library", (event) => bindLibrary(event.detail));
if (window.__emp?.library) {
  bindLibrary(window.__emp.library);
}

updateSlider(volumeBar);
updateSlider(seekBar);
