/**
 * EMP Your Mixes — local deterministic mix generation.
 * Fully offline. No AI/ML. No external recommendation APIs.
 *
 * Snapshots persist in localStorage (emp.mixes.v1), separate from emp.playback
 * and listening statistics. Daily snapshots are stable across navigation and
 * restarts; recent-lineup history is consulted only when creating a new day.
 */
(function (global) {
  "use strict";

  const MIX_CACHE_KEY = "emp.mixes.v1";
  const SCHEMA_VERSION = 1;

  const MAX_HOME_MIXES = 6;
  const MAX_TRACKS_PER_MIX = 40;
  const MIN_TRACKS_PER_MIX = 8;
  const MAX_RECENT_LINEUPS = 7;
  const MAX_CANDIDATE_ARTIST_MIXES = 12;

  const COLD_START_MIN_PLAYS = 5;
  const COLD_START_MIN_ARTISTS = 2;
  const RECENT_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
  const REDISCOVER_STALE_MS = 30 * 24 * 60 * 60 * 1000;

  // Preference scoring weights (documented, centralized).
  const W_PLAY = 1.0;
  const W_LISTEN = 0.55;
  const W_RECENCY = 0.85;
  const W_LIFETIME = 0.7;
  const W_RECENT = 0.3;
  const TRACK_DIMINISH = 0.72;

  let memorySnapshot = null;

  function localDateString(now = Date.now()) {
    const d = new Date(now);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function normalizeArtistKey(name) {
    return String(name ?? "").trim().toLowerCase();
  }

  function artistMixId(name) {
    return `artist:${normalizeArtistKey(name)}`;
  }

  function hashSeed(text) {
    let h = 2166136261 >>> 0;
    const s = String(text);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function next() {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(list, rng) {
    const items = [...list];
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  function weightedSample(candidates, count, rng, weightFn) {
    const pool = candidates.map((item) => ({
      item,
      weight: Math.max(0.0001, Number(weightFn(item)) || 0.0001)
    }));
    const picked = [];
    const used = new Set();
    const limit = Math.min(count, pool.length);
    for (let n = 0; n < limit; n += 1) {
      let total = 0;
      for (const entry of pool) {
        if (!used.has(entry.item)) {
          total += entry.weight;
        }
      }
      if (total <= 0) {
        break;
      }
      let dart = rng() * total;
      let chosen = null;
      for (const entry of pool) {
        if (used.has(entry.item)) {
          continue;
        }
        dart -= entry.weight;
        if (dart <= 0) {
          chosen = entry.item;
          break;
        }
      }
      if (!chosen) {
        break;
      }
      used.add(chosen);
      picked.push(chosen);
    }
    return picked;
  }

  function statsFor(listenStats, trackId) {
    const row = listenStats?.[trackId];
    return {
      playCount: Math.max(0, Number(row?.playCount) || 0),
      lastPlayedAt: Math.max(0, Number(row?.lastPlayedAt) || 0),
      listenMs: Math.max(0, Number(row?.listenMs) || 0)
    };
  }

  function recencyFactor(lastPlayedAt, now) {
    if (!(lastPlayedAt > 0)) {
      return 0;
    }
    const age = Math.max(0, now - lastPlayedAt);
    if (age >= RECENT_WINDOW_MS) {
      return 0.05;
    }
    return 1 - (age / RECENT_WINDOW_MS) * 0.95;
  }

  function trackPreferenceScore(stats, now) {
    const play = Math.log1p(stats.playCount);
    const listen = Math.log1p(stats.listenMs / 60000);
    const recency = recencyFactor(stats.lastPlayedAt, now);
    const lifetime = W_PLAY * play + W_LISTEN * listen;
    const recent = lifetime * recency;
    return W_LIFETIME * lifetime + W_RECENT * recent + W_RECENCY * recency * Math.min(1, play);
  }

  function buildArtistIndex(tracks, listenStats, now) {
    const byKey = new Map();
    for (const track of tracks) {
      if (!track?.id) {
        continue;
      }
      const name = String(track.artist || "").trim() || "Unknown Artist";
      const key = normalizeArtistKey(name);
      if (!key) {
        continue;
      }
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          key,
          name,
          trackIds: [],
          playedTrackIds: [],
          score: 0,
          recentScore: 0,
          distinctPlayed: 0
        };
        byKey.set(key, entry);
      }
      entry.trackIds.push(track.id);
      const stats = statsFor(listenStats, track.id);
      if (stats.playCount > 0 || stats.listenMs > 0) {
        entry.playedTrackIds.push(track.id);
        entry.distinctPlayed += 1;
        const trackScore = trackPreferenceScore(stats, now);
        const diminished = trackScore * Math.pow(TRACK_DIMINISH, Math.max(0, entry.distinctPlayed - 1));
        entry.score += diminished;
        if (stats.lastPlayedAt > now - RECENT_WINDOW_MS) {
          entry.recentScore += diminished;
        }
      }
    }
    return [...byKey.values()].map((entry) => ({
      ...entry,
      combinedScore: entry.score + 0.35 * entry.recentScore
    }));
  }

  function personalizationStrength(listenStats, artistIndex) {
    let plays = 0;
    for (const stats of Object.values(listenStats || {})) {
      plays += Math.max(0, Number(stats?.playCount) || 0);
    }
    const artistsWithPlays = artistIndex.filter((a) => a.distinctPlayed > 0).length;
    return {
      plays,
      artistsWithPlays,
      weak: plays < COLD_START_MIN_PLAYS || artistsWithPlays < COLD_START_MIN_ARTISTS
    };
  }

  function clampTrackIds(ids) {
    return ids.slice(0, MAX_TRACKS_PER_MIX);
  }

  function pickArtistTracks(entry, listenStats, now, rng, targetCount) {
    const scored = entry.trackIds.map((id) => {
      const stats = statsFor(listenStats, id);
      const pref = trackPreferenceScore(stats, now);
      // Prefer a blend: some familiar, some lesser-played from the same artist.
      const discoveryBoost = stats.playCount <= 1 ? 0.45 : 0;
      return { id, weight: 0.35 + pref + discoveryBoost };
    });
    const picked = weightedSample(scored, targetCount, rng, (row) => row.weight).map((row) => row.id);
    return clampTrackIds(picked);
  }

  function buildArtistMix(entry, listenStats, now, dateStr) {
    const rng = mulberry32(hashSeed(`${dateStr}|${artistMixId(entry.name)}`));
    const trackIds = pickArtistTracks(entry, listenStats, now, rng, MAX_TRACKS_PER_MIX);
    if (trackIds.length < Math.min(MIN_TRACKS_PER_MIX, entry.trackIds.length)) {
      // Small catalog: take what exists without padding unrelated artists.
      const fallback = clampTrackIds(seededShuffle(entry.trackIds, rng));
      if (!fallback.length) {
        return null;
      }
      return {
        id: artistMixId(entry.name),
        type: "artist",
        title: `${entry.name} Mix`,
        description: `${entry.name} from your library`,
        trackIds: fallback,
        coverTrackIds: fallback.slice(0, 4),
        anchorArtist: entry.name,
        generatedFor: dateStr
      };
    }
    return {
      id: artistMixId(entry.name),
      type: "artist",
      title: `${entry.name} Mix`,
      description: `${entry.name} from your library`,
      trackIds,
      coverTrackIds: trackIds.slice(0, 4),
      anchorArtist: entry.name,
      generatedFor: dateStr
    };
  }

  function buildHeavyRotation(tracks, listenStats, now, dateStr) {
    const rng = mulberry32(hashSeed(`${dateStr}|heavy-rotation`));
    const candidates = tracks
      .map((track) => {
        const stats = statsFor(listenStats, track.id);
        if (stats.playCount <= 0 && stats.listenMs <= 0) {
          return null;
        }
        return { id: track.id, weight: 0.2 + trackPreferenceScore(stats, now) };
      })
      .filter(Boolean);
    if (candidates.length < 4) {
      return null;
    }
    const trackIds = clampTrackIds(
      weightedSample(candidates, MAX_TRACKS_PER_MIX, rng, (row) => row.weight).map((row) => row.id)
    );
    return {
      id: "heavy-rotation",
      type: "heavy-rotation",
      title: "Heavy Rotation",
      description: "Your most-played favorites",
      trackIds,
      coverTrackIds: trackIds.slice(0, 4),
      generatedFor: dateStr
    };
  }

  function buildRediscover(tracks, listenStats, artistIndex, now, dateStr, weak) {
    if (weak) {
      return null;
    }
    const rng = mulberry32(hashSeed(`${dateStr}|rediscover`));
    const favored = new Set(
      artistIndex
        .filter((a) => a.combinedScore > 0)
        .sort((a, b) => b.combinedScore - a.combinedScore)
        .slice(0, 8)
        .map((a) => a.key)
    );
    const candidates = [];
    for (const track of tracks) {
      const stats = statsFor(listenStats, track.id);
      const artistKey = normalizeArtistKey(track.artist);
      const stale = stats.lastPlayedAt > 0 && now - stats.lastPlayedAt >= REDISCOVER_STALE_MS;
      const lowPlayFavored = favored.has(artistKey) && stats.playCount > 0 && stats.playCount <= 2;
      const neverFromFavored = favored.has(artistKey) && stats.playCount === 0;
      if (!stale && !lowPlayFavored && !neverFromFavored) {
        continue;
      }
      // Missing stats are not treated as "played long ago".
      if (stats.playCount === 0 && stats.lastPlayedAt === 0 && !neverFromFavored) {
        continue;
      }
      const ageBoost = stale ? Math.min(2, (now - stats.lastPlayedAt) / REDISCOVER_STALE_MS) : 0.4;
      candidates.push({ id: track.id, weight: 0.3 + ageBoost + (lowPlayFavored || neverFromFavored ? 0.5 : 0) });
    }
    if (candidates.length < 4) {
      return null;
    }
    const trackIds = clampTrackIds(
      weightedSample(candidates, MAX_TRACKS_PER_MIX, rng, (row) => row.weight).map((row) => row.id)
    );
    return {
      id: "rediscover",
      type: "rediscover",
      title: "Rediscover",
      description: "Music worth another listen",
      trackIds,
      coverTrackIds: trackIds.slice(0, 4),
      generatedFor: dateStr
    };
  }

  function buildLibraryDiscovery(tracks, listenStats, now, dateStr) {
    const rng = mulberry32(hashSeed(`${dateStr}|library-discovery`));
    const artistCounts = new Map();
    const albumCounts = new Map();
    const scored = tracks.map((track) => {
      const stats = statsFor(listenStats, track.id);
      const playPenalty = Math.log1p(stats.playCount);
      return {
        id: track.id,
        artistKey: normalizeArtistKey(track.artist),
        albumId: track.albumId || "",
        weight: 1.2 / (1 + playPenalty) + (stats.playCount === 0 ? 0.4 : 0) + rng() * 0.05
      };
    });
    const ordered = seededShuffle(scored, rng).sort((a, b) => b.weight - a.weight);
    const picked = [];
    for (const row of ordered) {
      if (picked.length >= MAX_TRACKS_PER_MIX) {
        break;
      }
      const aCount = artistCounts.get(row.artistKey) || 0;
      const alCount = albumCounts.get(row.albumId) || 0;
      if (aCount >= 2 || (row.albumId && alCount >= 2)) {
        continue;
      }
      picked.push(row.id);
      artistCounts.set(row.artistKey, aCount + 1);
      if (row.albumId) {
        albumCounts.set(row.albumId, alCount + 1);
      }
    }
    if (picked.length < 4) {
      return null;
    }
    return {
      id: "library-discovery",
      type: "library-discovery",
      title: "Library Discovery",
      description: "Explore your library",
      trackIds: picked,
      coverTrackIds: picked.slice(0, 4),
      generatedFor: dateStr
    };
  }

  function reduceOverlap(mixes, rng) {
    const seen = new Set();
    return mixes.map((mix, index) => {
      if (index === 0) {
        mix.trackIds.forEach((id) => seen.add(id));
        return mix;
      }
      const kept = [];
      const deferred = [];
      for (const id of mix.trackIds) {
        if (seen.has(id)) {
          deferred.push(id);
        } else {
          kept.push(id);
        }
      }
      const filler = seededShuffle(deferred, rng);
      const trackIds = clampTrackIds([...kept, ...filler]);
      trackIds.forEach((id) => seen.add(id));
      return { ...mix, trackIds, coverTrackIds: trackIds.slice(0, 4) };
    });
  }

  function lineupSignature(ids) {
    return ids.join("|");
  }

  function chooseLineup(candidates, recentLineups, dateStr, weak) {
    const rng = mulberry32(hashSeed(`${dateStr}|lineup`));
    const behavior = [];
    const artists = [];
    for (const mix of candidates) {
      if (mix.type === "artist") {
        artists.push(mix);
      } else {
        behavior.push(mix);
      }
    }

    // Stable favorites: keep top artist mixes with higher stay probability.
    const topArtists = artists.slice(0, 4);
    const chosenArtists = [];
    for (let i = 0; i < topArtists.length; i += 1) {
      const stayBias = i === 0 ? 0.85 : i === 1 ? 0.65 : 0.45;
      if (rng() < stayBias || chosenArtists.length < (weak ? 1 : 2)) {
        chosenArtists.push(topArtists[i]);
      }
      if (chosenArtists.length >= (weak ? 2 : 3)) {
        break;
      }
    }

    let lineupMixes = [...behavior, ...chosenArtists];
    // Prefer meaningful caps.
    if (lineupMixes.length > MAX_HOME_MIXES) {
      lineupMixes = seededShuffle(lineupMixes, rng).slice(0, MAX_HOME_MIXES);
      // Ensure heavy-rotation / discovery stay if present.
      const must = behavior.filter((m) => m.id === "heavy-rotation" || m.id === "library-discovery");
      for (const m of must) {
        if (!lineupMixes.some((x) => x.id === m.id)) {
          lineupMixes[lineupMixes.length - 1] = m;
        }
      }
    }

    // Avoid repeating yesterday's exact lineup when alternatives exist.
    const recentSet = new Set((recentLineups || []).map(lineupSignature));
    let ids = lineupMixes.map((m) => m.id);
    if (recentSet.has(lineupSignature(ids)) && candidates.length > ids.length) {
      const altArtists = artists.filter((a) => !ids.includes(a.id));
      if (altArtists.length) {
        const swapIndex = ids.findIndex((id) => id.startsWith("artist:"));
        if (swapIndex >= 0) {
          const replacement = altArtists[Math.floor(rng() * altArtists.length)];
          lineupMixes[swapIndex] = replacement;
          ids = lineupMixes.map((m) => m.id);
        }
      }
    }

    // Order: behavior first, then artists by score order already in candidates.
    const orderRank = new Map(candidates.map((m, i) => [m.id, i]));
    lineupMixes.sort((a, b) => {
      const aBeh = a.type === "artist" ? 1 : 0;
      const bBeh = b.type === "artist" ? 1 : 0;
      if (aBeh !== bBeh) {
        return aBeh - bBeh;
      }
      return (orderRank.get(a.id) ?? 99) - (orderRank.get(b.id) ?? 99);
    });

    return lineupMixes.slice(0, MAX_HOME_MIXES);
  }

  function generateSnapshot({ tracks, listenStats, fingerprint, now, recentLineups }) {
    const dateStr = localDateString(now);
    const artistIndex = buildArtistIndex(tracks, listenStats, now)
      .filter((a) => a.trackIds.length > 0)
      .sort((a, b) => b.combinedScore - a.combinedScore || b.trackIds.length - a.trackIds.length || a.name.localeCompare(b.name));
    const strength = personalizationStrength(listenStats, artistIndex);

    const candidates = [];
    const heavy = buildHeavyRotation(tracks, listenStats, now, dateStr);
    if (heavy) {
      candidates.push(heavy);
    }
    const rediscover = buildRediscover(tracks, listenStats, artistIndex, now, dateStr, strength.weak);
    if (rediscover) {
      candidates.push(rediscover);
    }
    const discovery = buildLibraryDiscovery(tracks, listenStats, now, dateStr);
    if (discovery) {
      candidates.push(discovery);
    }

    const artistPool = strength.weak
      ? [...artistIndex].sort((a, b) => b.trackIds.length - a.trackIds.length).slice(0, MAX_CANDIDATE_ARTIST_MIXES)
      : artistIndex.filter((a) => a.combinedScore > 0 || a.trackIds.length >= 4).slice(0, MAX_CANDIDATE_ARTIST_MIXES);

    for (const entry of artistPool) {
      const mix = buildArtistMix(entry, listenStats, now, dateStr);
      if (mix && mix.trackIds.length >= Math.min(3, entry.trackIds.length)) {
        candidates.push(mix);
      }
    }

    if (!candidates.length) {
      return null;
    }

    const lineupMixes = chooseLineup(candidates, recentLineups, dateStr, strength.weak);
    const rng = mulberry32(hashSeed(`${dateStr}|overlap`));
    const deduped = reduceOverlap(lineupMixes, rng);

    const mixes = {};
    const lineup = [];
    for (const mix of deduped) {
      if (!mix?.id || !mix.trackIds?.length) {
        continue;
      }
      mixes[mix.id] = mix;
      lineup.push(mix.id);
    }

    if (!lineup.length) {
      return null;
    }

    const nextRecent = [...(recentLineups || [])];
    nextRecent.unshift(lineup);
    while (nextRecent.length > MAX_RECENT_LINEUPS) {
      nextRecent.pop();
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      generatedFor: dateStr,
      libraryFingerprint: fingerprint || "",
      lineup,
      recentLineupIds: nextRecent,
      mixes
    };
  }

  function readCache() {
    try {
      const raw = global.localStorage?.getItem(MIX_CACHE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed !== "object") {
        return null;
      }
      if (!Array.isArray(parsed.lineup) || !parsed.mixes || typeof parsed.mixes !== "object") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function writeCache(snapshot) {
    try {
      global.localStorage?.setItem(MIX_CACHE_KEY, JSON.stringify(snapshot));
      return true;
    } catch {
      // Quota / private mode — keep in-memory only; do not break EMP.
      return false;
    }
  }

  function validateAgainstLibrary(snapshot, trackIdSet) {
    if (!snapshot) {
      return null;
    }
    const mixes = {};
    const lineup = [];
    let missing = 0;
    let total = 0;
    for (const id of snapshot.lineup || []) {
      const mix = snapshot.mixes?.[id];
      if (!mix || !Array.isArray(mix.trackIds)) {
        continue;
      }
      const trackIds = mix.trackIds.filter((trackId) => trackIdSet.has(trackId));
      missing += mix.trackIds.length - trackIds.length;
      total += mix.trackIds.length;
      if (trackIds.length < Math.min(3, mix.trackIds.length) || trackIds.length === 0) {
        continue;
      }
      mixes[id] = {
        ...mix,
        trackIds: clampTrackIds(trackIds),
        coverTrackIds: (mix.coverTrackIds || trackIds).filter((tid) => trackIdSet.has(tid)).slice(0, 4)
      };
      if (!mixes[id].coverTrackIds.length) {
        mixes[id].coverTrackIds = trackIds.slice(0, 4);
      }
      lineup.push(id);
    }
    if (!lineup.length) {
      return null;
    }
    const lossRatio = total > 0 ? missing / total : 1;
    return {
      snapshot: {
        ...snapshot,
        lineup,
        mixes
      },
      lossRatio
    };
  }

  function ensureMixSnapshot(options = {}) {
    const enabled = options.enabled !== false;
    if (!enabled) {
      memorySnapshot = memorySnapshot || readCache();
      return null;
    }

    const tracks = Array.isArray(options.tracks) ? options.tracks : [];
    if (!tracks.length) {
      memorySnapshot = null;
      return null;
    }

    const now = Number(options.now) || Date.now();
    const dateStr = localDateString(now);
    const fingerprint = String(options.libraryFingerprint || "");
    const listenStats = options.listenStats && typeof options.listenStats === "object" ? options.listenStats : {};
    const trackIdSet = new Set(tracks.map((t) => t.id).filter(Boolean));
    const allowGenerate = options.allowGenerate !== false;

    let cached = memorySnapshot || readCache();
    if (cached) {
      const validated = validateAgainstLibrary(cached, trackIdSet);
      if (validated && validated.snapshot.generatedFor === dateStr && validated.lossRatio < 0.35) {
        const cachedFp = validated.snapshot.libraryFingerprint || "";
        // Same calendar day and library still compatible: keep snapshot stable.
        // Do not consult recent-lineup history or reshuffle on reload/navigation.
        if (!fingerprint || !cachedFp || cachedFp === fingerprint) {
          if (fingerprint && !cachedFp) {
            validated.snapshot.libraryFingerprint = fingerprint;
          }
          memorySnapshot = validated.snapshot;
          return memorySnapshot;
        }
      }
    }

    if (!allowGenerate) {
      memorySnapshot = null;
      return null;
    }

    const recentLineups = Array.isArray(cached?.recentLineupIds) ? cached.recentLineupIds : [];
    const generated = generateSnapshot({
      tracks,
      listenStats,
      fingerprint,
      now,
      recentLineups
    });
    if (!generated) {
      memorySnapshot = null;
      return null;
    }
    memorySnapshot = generated;
    writeCache(generated);
    return memorySnapshot;
  }

  function getHomeMixes(limit = MAX_HOME_MIXES) {
    const snap = memorySnapshot;
    if (!snap) {
      return [];
    }
    return snap.lineup
      .map((id) => snap.mixes[id])
      .filter(Boolean)
      .slice(0, Math.max(0, limit));
  }

  function getAllMixes() {
    return getHomeMixes(MAX_HOME_MIXES);
  }

  function getMixById(id) {
    if (!id || !memorySnapshot) {
      return null;
    }
    return memorySnapshot.mixes?.[id] || null;
  }

  function clearMemorySnapshot() {
    memorySnapshot = null;
  }

  function peekSnapshot() {
    return memorySnapshot;
  }

  global.EmpMixes = {
    MIX_CACHE_KEY,
    SCHEMA_VERSION,
    MAX_HOME_MIXES,
    MAX_TRACKS_PER_MIX,
    localDateString,
    ensureMixSnapshot,
    getHomeMixes,
    getAllMixes,
    getMixById,
    clearMemorySnapshot,
    peekSnapshot,
    // Exposed for tests / debugging
    _hashSeed: hashSeed,
    _mulberry32: mulberry32
  };
})(typeof window !== "undefined" ? window : globalThis);
