/**
 * Artist page overview model (pure, testable): top-song preview, listening summary,
 * baseline-aware "in library since", playlist membership, release ordering, tag-based
 * release types and filters, and the primary vs Appears-on split.
 *
 * Inputs are plain library objects plus accessor functions, so player.js supplies live
 * listening stats / likes / dates and this module never reads global state. Nothing here
 * fabricates data: missing values stay missing and unplayed songs are never ranked.
 */
(function (global) {
  "use strict";

  const PREVIEW_LIMIT = 5;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FILTERABLE_TYPES = Object.freeze(["album", "ep", "single"]);
  const PRIMARY_LABELS = Object.freeze({
    album: "Album",
    ep: "EP",
    single: "Single",
    broadcast: "Broadcast",
    other: "Release"
  });

  function defaultCompare(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base", numeric: true });
  }

  /** Same track id never counts twice (aggregates and previews). */
  function dedupeTracks(tracks) {
    const seen = new Set();
    const result = [];
    for (const track of Array.isArray(tracks) ? tracks : []) {
      if (!track || typeof track.id !== "string" || !track.id || seen.has(track.id)) {
        continue;
      }
      seen.add(track.id);
      result.push(track);
    }
    return result;
  }

  function yearValue(value) {
    const year = Math.floor(Number(value));
    return Number.isFinite(year) && year > 0 ? year : 0;
  }

  /** Newest release first; unknown years last; then album, disc order, title, id. */
  function defaultSongComparer({ albumYear = () => 0, compare = defaultCompare } = {}) {
    return (left, right) => {
      const leftYear = yearValue(albumYear(left));
      const rightYear = yearValue(albumYear(right));
      if (leftYear !== rightYear) {
        if (!leftYear || !rightYear) {
          return leftYear ? -1 : 1;
        }
        return rightYear - leftYear;
      }
      return compare(left.album, right.album)
        || (Number(left.trackNumber) || 0) - (Number(right.trackNumber) || 0)
        || compare(left.title, right.title)
        || defaultCompare(left.id, right.id);
    };
  }

  /**
   * Up to five songs. With qualified plays: ranked by plays (ties: most recently played, title,
   * id) and titled "Your top songs"; unplayed fill-in rows follow, flagged ranked:false. Without
   * any plays: "Songs" in the default order, nothing ranked.
   */
  function topSongs(tracks, { playCount = () => 0, lastPlayedAt = () => 0, albumYear, compare = defaultCompare, limit = PREVIEW_LIMIT } = {}) {
    const unique = dedupeTracks(tracks);
    const played = [];
    const unplayed = [];
    for (const track of unique) {
      const plays = Math.max(0, Math.floor(Number(playCount(track.id)) || 0));
      (plays > 0 ? played : unplayed).push({ track, plays });
    }
    played.sort((left, right) => right.plays - left.plays
      || (Number(lastPlayedAt(right.track.id)) || 0) - (Number(lastPlayedAt(left.track.id)) || 0)
      || compare(left.track.title, right.track.title)
      || defaultCompare(left.track.id, right.track.id));
    const byDefault = defaultSongComparer({ albumYear, compare });
    unplayed.sort((left, right) => byDefault(left.track, right.track));

    const rows = [
      ...played.map((row) => ({ ...row, ranked: true })),
      ...unplayed.map((row) => ({ ...row, ranked: false }))
    ].slice(0, Math.max(0, limit));
    const byPlays = played.length > 0;
    return {
      title: byPlays ? "Your top songs" : "Songs",
      byPlays,
      rows,
      total: unique.length,
      hasMore: unique.length > limit
    };
  }

  /** Aggregate listening/library facts over unique tracks. Zero/absent values stay explicit. */
  function summary(tracks, { playCount = () => 0, lastPlayedAt = () => 0, isLiked = () => false, dateAdded = () => 0, baselineAt = 0 } = {}) {
    const unique = dedupeTracks(tracks);
    let duration = 0;
    let plays = 0;
    let liked = 0;
    let lastPlayed = 0;
    let earliestAdded = 0;
    for (const track of unique) {
      duration += Math.max(0, Number(track.duration) || 0);
      plays += Math.max(0, Math.floor(Number(playCount(track.id)) || 0));
      liked += isLiked(track.id) ? 1 : 0;
      lastPlayed = Math.max(lastPlayed, Number(lastPlayedAt(track.id)) || 0);
      const added = Number(dateAdded(track)) || 0;
      if (added > 0 && (!earliestAdded || added < earliestAdded)) {
        earliestAdded = added;
      }
    }
    const baseline = Math.max(0, Number(baselineAt) || 0);
    let added = null;
    if (earliestAdded > 0) {
      // Tracks present when date tracking began carry the baseline, not a real addition date.
      added = baseline > 0 && earliestAdded <= baseline
        ? { kind: "baseline", at: baseline }
        : { kind: "tracked", at: earliestAdded };
    }
    return { songs: unique.length, duration, plays, liked, lastPlayedAt: lastPlayed, added };
  }

  function monthYear(at, locale) {
    return new Date(at).toLocaleDateString(locale, { month: "short", year: "numeric" });
  }

  /** "In library since" row, or null when no date is known. Baseline dates are labelled honestly. */
  function addedLabel(added, { locale } = {}) {
    if (!added || !(Number(added.at) > 0)) {
      return null;
    }
    const when = monthYear(added.at, locale);
    return added.kind === "baseline"
      ? { label: "In library since", value: `${when} or earlier` }
      : { label: "In library since", value: when };
  }

  function localDay(at) {
    const date = new Date(at);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  /** "Never played", "Today", "Yesterday", "3 days ago", "Mar 3", "Mar 3, 2025". */
  function lastPlayedLabel(at, { now = Date.now(), locale } = {}) {
    const time = Number(at) || 0;
    if (time <= 0) {
      return "Never played";
    }
    const days = Math.round((localDay(now) - localDay(time)) / DAY_MS);
    if (days <= 0) {
      return "Today";
    }
    if (days === 1) {
      return "Yesterday";
    }
    if (days < 7) {
      return `${days} days ago`;
    }
    const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
    return new Date(time).toLocaleDateString(locale, sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" });
  }

  /** User playlists that contain any of the artist's tracks, most of the artist first. */
  function playlistsContaining(trackIds, playlists, { limit = 3, compare = defaultCompare } = {}) {
    const ids = trackIds instanceof Set ? trackIds : new Set(trackIds || []);
    const matches = [];
    for (const playlist of Array.isArray(playlists) ? playlists : []) {
      if (!playlist || !playlist.id || !Array.isArray(playlist.trackIds)) {
        continue;
      }
      const count = new Set(playlist.trackIds.filter((id) => ids.has(id))).size;
      if (count > 0) {
        matches.push({ id: playlist.id, name: String(playlist.name || ""), count });
      }
    }
    matches.sort((left, right) => right.count - left.count || compare(left.name, right.name) || defaultCompare(left.id, right.id));
    return { items: matches.slice(0, Math.max(0, limit)), total: matches.length };
  }

  // --- Releases ------------------------------------------------------------------------

  /** Tag-based primary release type, or null. Never derived from local track counts. */
  function releaseTypeOf(album) {
    const type = typeof album?.releaseType === "string" ? album.releaseType.toLowerCase() : "";
    return Object.prototype.hasOwnProperty.call(PRIMARY_LABELS, type) ? type : null;
  }

  /** Card label: tag-based type, refined by secondary types; "Release" when unknown. */
  function releaseLabel(album) {
    const type = releaseTypeOf(album);
    if (!type) {
      return "Release";
    }
    const secondary = Array.isArray(album.releaseSecondaryTypes) ? album.releaseSecondaryTypes : [];
    if (secondary.includes("compilation")) {
      return "Compilation";
    }
    if (secondary.includes("soundtrack")) {
      return "Soundtrack";
    }
    if (secondary.includes("live")) {
      return type === "album" ? "Live album" : `Live ${PRIMARY_LABELS[type].toLowerCase()}`.replace("Live ep", "Live EP");
    }
    if (secondary.includes("remix")) {
      return type === "album" ? "Remix album" : `Remix ${PRIMARY_LABELS[type] === "EP" ? "EP" : PRIMARY_LABELS[type].toLowerCase()}`;
    }
    return PRIMARY_LABELS[type];
  }

  /** Newest first by year; unknown years last; then title, then stable id. */
  function sortReleases(albums, { compare = defaultCompare } = {}) {
    return [...(Array.isArray(albums) ? albums : [])].sort((left, right) => {
      const leftYear = yearValue(left?.year);
      const rightYear = yearValue(right?.year);
      if (leftYear !== rightYear) {
        if (!leftYear || !rightYear) {
          return leftYear ? -1 : 1;
        }
        return rightYear - leftYear;
      }
      return compare(left?.title, right?.title) || defaultCompare(left?.id, right?.id);
    });
  }

  /**
   * Filters worth showing: "all" plus each tagged type present, only when filtering would
   * actually narrow the list. Unknown releases stay under "all". Returns [] otherwise.
   */
  function discographyFilters(albums) {
    const list = Array.isArray(albums) ? albums : [];
    const present = FILTERABLE_TYPES.filter((type) => list.some((album) => releaseTypeOf(album) === type));
    if (!present.length) {
      return [];
    }
    const narrows = present.length > 1 || list.some((album) => releaseTypeOf(album) !== present[0]);
    return narrows ? ["all", ...present] : [];
  }

  function filterReleases(albums, filter) {
    const list = Array.isArray(albums) ? albums : [];
    return FILTERABLE_TYPES.includes(filter) ? list.filter((album) => releaseTypeOf(album) === filter) : list;
  }

  /** Consistent album-artist tag across an album's tracks; null when absent or conflicting. */
  function albumArtistTag(album, trackById, matches) {
    let tag = null;
    for (const id of album?.trackIds || []) {
      const value = String(trackById(id)?.albumArtist || "").trim();
      if (!value) {
        continue;
      }
      if (tag === null) {
        tag = value;
      } else if (!matches(tag, value)) {
        return null;
      }
    }
    return tag;
  }

  /**
   * Primary discography vs Appears on.
   * - With a consistent album-artist tag, the tag decides who the release belongs to.
   * - Without one, EMP's existing grouping (album.artist) decides.
   * - Appears on: the artist has credited tracks here, the release is not theirs by tag, and
   *   it is not already primary. Untagged or conflicting releases are never guessed into it.
   */
  function partitionReleases({ name, albums, artistTracks, trackById = () => null, matches = (a, b) => defaultCompare(a, b) === 0 }) {
    const primary = new Map();
    const appearsOn = new Map();
    const creditedAlbumIds = new Set(dedupeTracks(artistTracks).map((track) => track.albumId).filter(Boolean));
    for (const album of Array.isArray(albums) ? albums : []) {
      if (!album?.id) {
        continue;
      }
      const tag = albumArtistTag(album, trackById, matches);
      const isPrimary = tag ? matches(tag, name) : matches(album.artist, name);
      if (isPrimary) {
        primary.set(album.id, album);
      } else if (tag && creditedAlbumIds.has(album.id)) {
        appearsOn.set(album.id, album);
      }
    }
    for (const id of primary.keys()) {
      appearsOn.delete(id);
    }
    return { primary: [...primary.values()], appearsOn: [...appearsOn.values()] };
  }

  /** Hero metadata parts: genres, origin, songs + duration. No empties, no duplicates. */
  function heroMetaParts({ genres = [], origin = "", songsLabel = "" } = {}) {
    const parts = [];
    const seen = new Set();
    const push = (value) => {
      const text = String(value || "").trim();
      const key = text.toLowerCase();
      if (text && !seen.has(key)) {
        seen.add(key);
        parts.push(text);
      }
    };
    const genreList = (Array.isArray(genres) ? genres : []).map((genre) => String(genre || "").trim()).filter(Boolean);
    push(genreList.slice(0, 2).join(", "));
    push(origin);
    push(songsLabel);
    return parts;
  }

  const api = {
    PREVIEW_LIMIT,
    dedupeTracks,
    defaultSongComparer,
    topSongs,
    summary,
    addedLabel,
    lastPlayedLabel,
    playlistsContaining,
    releaseTypeOf,
    releaseLabel,
    sortReleases,
    discographyFilters,
    filterReleases,
    albumArtistTag,
    partitionReleases,
    heroMetaParts
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpArtistOverview = api;
})(typeof window !== "undefined" ? window : globalThis);
