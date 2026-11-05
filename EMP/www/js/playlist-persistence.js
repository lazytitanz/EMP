(function (global) {
  "use strict";

  function playlistPersistenceScore(playlists) {
    if (!Array.isArray(playlists) || !playlists.length) {
      return 0;
    }
    let score = playlists.length * 1000;
    for (const playlist of playlists) {
      if (Array.isArray(playlist?.trackIds)) {
        score += playlist.trackIds.length;
      }
    }
    return score;
  }

  function normalizeHostBackup(raw) {
    if (!raw) {
      return { revision: 0, playlists: [] };
    }
    if (Array.isArray(raw)) {
      const playlists = raw;
      return {
        revision: playlists.length ? 1 : 0,
        playlists
      };
    }
    if (typeof raw === "object") {
      const playlists = Array.isArray(raw.playlists) ? raw.playlists : [];
      const revision = Number.isFinite(Number(raw.revision)) ? Math.max(0, Number(raw.revision)) : (playlists.length ? 1 : 0);
      return { revision, playlists };
    }
    return { revision: 0, playlists: [] };
  }

  /**
   * Choose authoritative playlist snapshot by revision.
   * When both revisions are 0 (legacy), fall back to persistence score.
   * Intentional empties win when their revision is strictly higher.
   */
  function chooseAuthoritativePlaylists({ memoryPlaylists = [], memoryRevision = 0, storedPlaylists = [], storedRevision = 0, hostPlaylists = [], hostRevision = 0 } = {}) {
    const candidates = [
      { source: "memory", playlists: memoryPlaylists, revision: Math.max(0, Number(memoryRevision) || 0) },
      { source: "stored", playlists: storedPlaylists, revision: Math.max(0, Number(storedRevision) || 0) },
      { source: "host", playlists: hostPlaylists, revision: Math.max(0, Number(hostRevision) || 0) }
    ];

    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (candidate.revision > best.revision) {
        best = candidate;
        continue;
      }
      if (candidate.revision < best.revision) {
        continue;
      }
      // Equal revision (often all 0 for legacy): prefer richer nonempty, else keep best.
      const candidateScore = playlistPersistenceScore(candidate.playlists);
      const bestScore = playlistPersistenceScore(best.playlists);
      if (candidateScore > bestScore) {
        best = candidate;
      }
    }

    return {
      playlists: Array.isArray(best.playlists) ? best.playlists : [],
      revision: best.revision,
      source: best.source
    };
  }

  /**
   * Cold preference writes must not replace durable playlists with an empty/cold snapshot.
   * Playlist commits pass allowCommit=true and may shrink or clear with a bumped revision.
   */
  function protectPlaylistsForSessionWrite({
    outgoingPlaylists,
    storedPlaylists,
    hostPlaylists,
    playlistsHydrated,
    allowPlaylistCommit
  }) {
    const next = Array.isArray(outgoingPlaylists) ? outgoingPlaylists : [];
    const stored = Array.isArray(storedPlaylists) ? storedPlaylists : [];
    const host = Array.isArray(hostPlaylists) ? hostPlaylists : [];
    const nextScore = playlistPersistenceScore(next);
    const storedScore = playlistPersistenceScore(stored);
    const hostScore = playlistPersistenceScore(host);

    if (allowPlaylistCommit) {
      return next;
    }

    if (!playlistsHydrated) {
      if (storedScore > 0 || hostScore > 0) {
        return storedScore >= hostScore ? stored : host;
      }
      return next;
    }

    if (nextScore === 0 && Math.max(storedScore, hostScore) > 0) {
      return storedScore >= hostScore ? stored : host;
    }

    return next;
  }

  const api = {
    playlistPersistenceScore,
    normalizeHostBackup,
    chooseAuthoritativePlaylists,
    protectPlaylistsForSessionWrite
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.EmpPlaylistPersistence = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
