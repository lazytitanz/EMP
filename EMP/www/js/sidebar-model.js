/**
 * Sidebar library model (pure, testable): filter/sort state, the mixed library list with Home
 * pins first, empty-state reasons, and source-based playback attribution.
 *
 * Pins are never stored here — callers pass Home's pin array (home.json via HomeStore), so Home
 * and the sidebar always share one collection. Nothing in this module mutates its inputs.
 */
(function (global) {
  "use strict";

  const FILTERS = Object.freeze(["playlists", "albums", "artists", "folders"]);
  const SORTS = Object.freeze(["recent", "title"]);
  /** Item kinds listed for each filter; `null` is the unfiltered mixed view. */
  const FILTER_KINDS = Object.freeze({
    all: Object.freeze(["playlist", "album", "artist"]),
    playlists: Object.freeze(["playlist"]),
    albums: Object.freeze(["album"]),
    artists: Object.freeze(["artist"]),
    folders: Object.freeze(["folder"])
  });
  /** Pin kinds eligible for each filter. Mixes have no filter, so they only show unfiltered. */
  const FILTER_PIN_KINDS = Object.freeze({
    all: Object.freeze(["playlist", "album", "artist", "mix"]),
    playlists: Object.freeze(["playlist"]),
    albums: Object.freeze(["album"]),
    artists: Object.freeze(["artist"]),
    folders: Object.freeze([])
  });
  const EMPTY_REASONS = Object.freeze({
    all: "library-empty",
    playlists: "no-playlists",
    albums: "no-albums",
    artists: "no-artists",
    folders: "no-folders"
  });
  /** Queue source kinds that name one sidebar/Home destination. Others (library, songs, recents, homeTop) name none. */
  const SOURCE_TO_KIND = Object.freeze({
    album: "album",
    playlist: "playlist",
    smart: "playlist",
    artist: "artist",
    mix: "mix"
  });

  function normalizeFilter(value) {
    return FILTERS.includes(value) ? value : null;
  }

  /** Selecting the active filter clears it. */
  function toggleFilter(current, next) {
    const target = normalizeFilter(next);
    return target && target !== normalizeFilter(current) ? target : null;
  }

  function normalizeSort(value) {
    return SORTS.includes(value) ? value : "recent";
  }

  /**
   * Stable identity shared with Home pins (`kind:id`). Artists are addressed by display name and
   * folders by Windows path, so both compare case-insensitively; folder separators are unified.
   */
  function itemKey(item) {
    if (!item || typeof item.kind !== "string" || typeof item.id !== "string" || !item.id) {
      return "";
    }
    let id = item.id;
    if (item.kind === "artist") {
      id = id.toLowerCase();
    } else if (item.kind === "folder") {
      id = normalizeFolderPath(id);
    }
    return `${item.kind}:${id}`;
  }

  /** Case-insensitive, separator-agnostic folder identity without a trailing separator. */
  function normalizeFolderPath(path) {
    return String(path || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  }

  function normalizeQuery(query) {
    return String(query || "").trim().toLowerCase();
  }

  function matchesQuery(parts, needle) {
    if (!needle) {
      return true;
    }
    return (parts || []).some((part) => String(part || "").toLowerCase().includes(needle));
  }

  function defaultCompare(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base", numeric: true });
  }

  function sortItems(items, sort, compare) {
    const byTitle = (left, right) => compare(left.title, right.title);
    if (sort === "title") {
      return items.sort(byTitle);
    }
    return items.sort((left, right) => (Number(right.recency) || 0) - (Number(left.recency) || 0) || byTitle(left, right));
  }

  /**
   * Builds the visible list.
   * @param {object} options
   * @param {{playlists?:object[],albums?:object[],artists?:object[],folders?:object[]}} options.catalog
   *   Items shaped `{ kind, id, title, search: string[], recency: number }`.
   * @param {{kind:string,id:string,label?:string}[]} options.pins Home pins in user order.
   * @param {(pin) => object|null} options.resolvePin Live item for a pin, or null when unavailable.
   * @returns {{ pinned: object[], rest: object[], emptyReason: string, collectionSize: number }}
   *   `pinned` rows are `{ key, pin, item, unavailable }`; `rest` rows are `{ key, item }`.
   */
  function buildList({ catalog = {}, pins = [], resolvePin = () => null, filter = null, query = "", sort = "recent", compare = defaultCompare } = {}) {
    const mode = normalizeFilter(filter) || "all";
    const kinds = FILTER_KINDS[mode];
    const pinKinds = FILTER_PIN_KINDS[mode];
    const needle = normalizeQuery(query);
    const order = normalizeSort(sort);

    const pinned = [];
    const pinnedKeys = new Set();
    let eligiblePins = 0;
    for (const pin of pins || []) {
      const key = itemKey(pin);
      if (!key || pinnedKeys.has(key) || !pinKinds.includes(pin.kind)) {
        continue;
      }
      pinnedKeys.add(key);
      eligiblePins += 1;
      const item = resolvePin(pin) || null;
      const parts = item ? item.search || [item.title] : [pin.label || pin.id];
      if (!matchesQuery(parts, needle)) {
        continue;
      }
      pinned.push({ key, pin, item, unavailable: !item });
    }

    const pool = [];
    for (const kind of kinds) {
      const bucket = catalog[`${kind}s`];
      if (Array.isArray(bucket)) {
        pool.push(...bucket);
      }
    }
    const collectionSize = eligiblePins + pool.filter((item) => !pinnedKeys.has(itemKey(item))).length;
    const matching = [];
    for (const item of pool) {
      const key = itemKey(item);
      if (!key || pinnedKeys.has(key) || !matchesQuery(item.search || [item.title], needle)) {
        continue;
      }
      matching.push(item);
    }
    const rest = sortItems(matching, order, compare).map((item) => ({ key: itemKey(item), item }));

    let emptyReason = "";
    if (!pinned.length && !rest.length) {
      emptyReason = collectionSize === 0 ? EMPTY_REASONS[mode] : "no-matches";
    }
    return { pinned, rest, emptyReason, collectionSize };
  }

  /** Rows shown in the collapsed rail: the same order, minus unavailable pins. */
  function railRows(list) {
    return [...(list?.pinned || []).filter((row) => !row.unavailable), ...(list?.rest || [])];
  }

  /**
   * The destination actually being played from, or null. Attribution comes only from the queue's
   * recorded source — never from track membership — and a manually queued entry (origin "user")
   * belongs to no collection. Pause does not change attribution; callers style it separately.
   */
  function playingKey({ source = null, entryOrigin = "source", hasTrack = false } = {}) {
    if (!hasTrack || entryOrigin === "user" || !source || typeof source.id !== "string" || !source.id) {
      return "";
    }
    const kind = SOURCE_TO_KIND[source.kind];
    return kind ? itemKey({ kind, id: source.id }) : "";
  }

  /** True when `albumRoots` (album id → watched roots) places the album under `folderPath`. */
  function albumInFolder(albumRoots, albumId, folderPath) {
    const roots = albumRoots?.[albumId];
    if (!Array.isArray(roots) || !folderPath) {
      return false;
    }
    const target = normalizeFolderPath(folderPath);
    return roots.some((root) => {
      const candidate = normalizeFolderPath(root);
      return candidate === target || candidate.startsWith(`${target}\\`);
    });
  }

  /** Compact count for nav badges ("2,418"). */
  function formatCount(count, locale) {
    const value = Math.max(0, Math.floor(Number(count) || 0));
    try {
      return value.toLocaleString(locale);
    } catch (_) {
      return String(value);
    }
  }

  const api = {
    FILTERS,
    SORTS,
    normalizeFilter,
    toggleFilter,
    normalizeSort,
    itemKey,
    normalizeFolderPath,
    normalizeQuery,
    buildList,
    railRows,
    playingKey,
    albumInFolder,
    formatCount
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpSidebarModel = api;
})(typeof window !== "undefined" ? window : globalThis);
