"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sp = require("./smart-playlists.js");

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0); // 2026-10-29
const DAY = 24 * 60 * 60 * 1000;

function track(partial) {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    artist: partial.artist ?? "",
    album: partial.album ?? "",
    albumArtist: partial.albumArtist,
    genre: partial.genre,
    format: partial.format,
    year: partial.year,
    duration: partial.duration ?? 180,
    dateAdded: partial.dateAdded ?? 0,
    albumId: partial.albumId ?? "alb1"
  };
}

function ctx(tracks, extras = {}) {
  return {
    tracks,
    albumsById: extras.albumsById || {},
    listenStats: extras.listenStats || {},
    likedIds: extras.likedIds instanceof Set ? extras.likedIds : new Set(extras.likedIds || []),
    now: extras.now ?? NOW
  };
}

function defWithRules(children, options = {}) {
  return {
    match: options.match || "all",
    rules: {
      type: "group",
      op: options.match || "all",
      children
    },
    sort: options.sort || { field: "title", direction: "asc" },
    limit: options.limit ?? null,
    randomSeed: options.randomSeed ?? null
  };
}

describe("smart playlist validation", () => {
  it("accepts a simple valid definition", () => {
    const def = defWithRules([
      { type: "rule", field: "artist", op: "contains", value: "tool" }
    ]);
    const result = sp.validateSmartDefinition(def);
    assert.equal(result.ok, true);
  });

  it("rejects incomplete text rules", () => {
    const def = defWithRules([
      { type: "rule", field: "artist", op: "contains", value: "   " }
    ]);
    assert.equal(sp.validateSmartDefinition(def).ok, false);
  });

  it("rejects invalid operators", () => {
    const def = defWithRules([
      { type: "rule", field: "playCount", op: "contains", value: "x" }
    ]);
    assert.equal(sp.validateSmartDefinition(def).ok, false);
  });

  it("rejects nesting deeper than MAX_DEPTH", () => {
    const deep = {
      match: "all",
      rules: {
        type: "group",
        op: "all",
        children: [
          {
            type: "group",
            op: "any",
            children: [
              {
                type: "group",
                op: "all",
                children: [{ type: "rule", field: "artist", op: "is", value: "A" }]
              }
            ]
          }
        ]
      },
      sort: { field: "title", direction: "asc" },
      limit: null
    };
    assert.equal(sp.validateSmartDefinition(deep).ok, false);
  });

  it("allows one nested group level", () => {
    const nested = {
      match: "all",
      rules: {
        type: "group",
        op: "all",
        children: [
          { type: "rule", field: "playCount", op: "lt", value: 5 },
          {
            type: "group",
            op: "any",
            children: [
              { type: "rule", field: "genre", op: "contains", value: "Rock" },
              { type: "rule", field: "artist", op: "is", value: "TOOL" }
            ]
          }
        ]
      },
      sort: { field: "title", direction: "asc" },
      limit: null
    };
    assert.equal(sp.validateSmartDefinition(nested).ok, true);
  });
});

describe("text comparisons and missing metadata", () => {
  const tracks = [
    track({ id: "t1", artist: "TOOL", genre: "Metal" }),
    track({ id: "t2", artist: "Opeth", genre: "" }),
    track({ id: "t3", artist: "A Perfect Circle", genre: null }),
    track({ id: "t4", artist: "", genre: undefined })
  ];

  it("matches contains / is case-insensitively", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "artist", op: "contains", value: "tool" }]),
      ctx(tracks)
    );
    assert.deepEqual(result.trackIds, ["t1"]);
  });

  it("positive text ops do not match missing genre", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "genre", op: "contains", value: "Metal" }]),
      ctx(tracks)
    );
    assert.deepEqual(result.trackIds, ["t1"]);
  });

  it("negative text ops match missing genre", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "genre", op: "isNot", value: "Jazz" }]),
      ctx(tracks)
    );
    assert.deepEqual(result.trackIds.sort(), ["t1", "t2", "t3", "t4"]);
  });

  it("doesNotContain matches missing fields", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "genre", op: "doesNotContain", value: "Metal" }]),
      ctx(tracks)
    );
    assert.deepEqual(result.trackIds.sort(), ["t2", "t3", "t4"]);
  });
});

describe("numeric comparisons", () => {
  const tracks = [
    track({ id: "t1", year: 2001, duration: 300 }),
    track({ id: "t2", year: null, duration: 0 }),
    track({ id: "t3", duration: 120 })
  ];

  it("compares year and duration", () => {
    const byYear = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "year", op: "gte", value: 2000 }]),
      ctx(tracks, { albumsById: { alb1: { year: 1999 } } })
    );
    assert.deepEqual(byYear.trackIds, ["t1"]);

    const byDuration = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "duration", op: "lt", value: 200 }]),
      ctx(tracks)
    );
    assert.deepEqual(byDuration.trackIds, ["t3"]);
  });

  it("missing year/duration fails numeric comparisons", () => {
    const missingYear = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "year", op: "lt", value: 3000 }]),
      ctx([track({ id: "x", year: null })], { albumsById: {} })
    );
    assert.deepEqual(missingYear.trackIds, []);

    const missingDuration = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "duration", op: "gt", value: 0 }]),
      ctx([track({ id: "y", duration: 0 })])
    );
    assert.deepEqual(missingDuration.trackIds, []);
  });

  it("falls back to album year when track year missing", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "year", op: "eq", value: 1997 }]),
      ctx([track({ id: "t", year: null, albumId: "a1" })], {
        albumsById: { a1: { year: 1997 } }
      })
    );
    assert.deepEqual(result.trackIds, ["t"]);
  });

  it("treats missing playCount as zero", () => {
    const tracks2 = [track({ id: "a" }), track({ id: "b" })];
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "playCount", op: "eq", value: 0 }]),
      ctx(tracks2, { listenStats: { b: { playCount: 3, lastPlayedAt: NOW } } })
    );
    assert.deepEqual(result.trackIds, ["a"]);
  });
});

describe("date and never-played semantics", () => {
  const tracks = [
    track({ id: "never", dateAdded: NOW - 10 * DAY }),
    track({ id: "recent", dateAdded: NOW - 2 * DAY }),
    track({ id: "old", dateAdded: NOW - 100 * DAY }),
    track({ id: "noDate", dateAdded: 0 })
  ];

  const listenStats = {
    recent: { playCount: 2, lastPlayedAt: NOW - 2 * DAY },
    old: { playCount: 5, lastPlayedAt: NOW - 60 * DAY }
  };

  it("withinLastDays / olderThanDays for dateAdded require known date", () => {
    const recent = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "dateAdded", op: "withinLastDays", value: { days: 30 } }]),
      ctx(tracks)
    );
    assert.deepEqual(recent.trackIds.sort(), ["never", "recent"]);

    const missing = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "dateAdded", op: "olderThanDays", value: { days: 1 } }]),
      ctx([track({ id: "z", dateAdded: 0 })])
    );
    assert.deepEqual(missing.trackIds, []);
  });

  it("lastPlayed olderThanDays does not match never-played tracks", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "lastPlayed", op: "olderThanDays", value: { days: 30 } }]),
      ctx(tracks, { listenStats })
    );
    assert.deepEqual(result.trackIds, ["old"]);
  });

  it("lastPlayed withinLastDays does not match never-played tracks", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "lastPlayed", op: "withinLastDays", value: { days: 7 } }]),
      ctx(tracks, { listenStats })
    );
    assert.deepEqual(result.trackIds, ["recent"]);
  });

  it("explicit neverPlayed matches only never-played tracks", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "neverPlayed", op: "isTrue", value: true }]),
      ctx(tracks, { listenStats })
    );
    assert.deepEqual(result.trackIds.sort(), ["never", "noDate"]);
  });

  it("lastPlayed never operator matches never-played", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "lastPlayed", op: "never", value: null }]),
      ctx(tracks, { listenStats })
    );
    assert.deepEqual(result.trackIds.sort(), ["never", "noDate"]);
  });
});

describe("boolean favorite", () => {
  it("matches liked membership", () => {
    const tracks = [track({ id: "a" }), track({ id: "b" })];
    const liked = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "favorite", op: "isTrue", value: true }]),
      ctx(tracks, { likedIds: ["a"] })
    );
    assert.deepEqual(liked.trackIds, ["a"]);
    const unliked = sp.evaluateSmartPlaylist(
      defWithRules([{ type: "rule", field: "favorite", op: "isFalse", value: true }]),
      ctx(tracks, { likedIds: ["a"] })
    );
    assert.deepEqual(unliked.trackIds, ["b"]);
  });
});

describe("nested AND/OR groups", () => {
  it("evaluates nested any inside all", () => {
    const tracks = [
      track({ id: "rock-tool", artist: "TOOL", genre: "Rock", playCount: 0 }),
      track({ id: "metal-other", artist: "Other", genre: "Metal" }),
      track({ id: "rock-other", artist: "Other", genre: "Rock" })
    ];
    // Force play counts via stats for playCount rule
    const def = {
      match: "all",
      rules: {
        type: "group",
        op: "all",
        children: [
          { type: "rule", field: "playCount", op: "lt", value: 5 },
          {
            type: "group",
            op: "any",
            children: [
              { type: "rule", field: "genre", op: "contains", value: "Rock" },
              { type: "rule", field: "artist", op: "is", value: "TOOL" }
            ]
          }
        ]
      },
      sort: { field: "title", direction: "asc" },
      limit: null
    };
    const result = sp.evaluateSmartPlaylist(def, ctx(tracks, {
      listenStats: {
        "rock-tool": { playCount: 1, lastPlayedAt: NOW },
        "metal-other": { playCount: 1, lastPlayedAt: NOW },
        "rock-other": { playCount: 1, lastPlayedAt: NOW }
      }
    }));
    assert.deepEqual(result.trackIds.sort(), ["rock-other", "rock-tool"]);
  });

  it("empty all group is vacuously true; empty any is false", () => {
    const tracks = [track({ id: "only" })];
    const allEmpty = sp.evaluateSmartPlaylist({
      match: "all",
      rules: { type: "group", op: "all", children: [] },
      sort: { field: "title", direction: "asc" },
      limit: null
    }, ctx(tracks));
    // validate would reject, but evaluator honors empty-group semantics when allowed
    assert.deepEqual(allEmpty.trackIds, ["only"]);

    const anyEmpty = sp.evaluateSmartPlaylist({
      match: "any",
      rules: { type: "group", op: "any", children: [] },
      sort: { field: "title", direction: "asc" },
      limit: null
    }, ctx(tracks));
    assert.deepEqual(anyEmpty.trackIds, []);
  });
});

describe("sort, limit, and stable random", () => {
  const tracks = [
    track({ id: "c", title: "C", artist: "Z", dateAdded: 30 }),
    track({ id: "a", title: "A", artist: "Y", dateAdded: 10 }),
    track({ id: "b", title: "B", artist: "X", dateAdded: 20 })
  ];

  it("sorts and applies limit after filter", () => {
    const result = sp.evaluateSmartPlaylist(
      defWithRules(
        [{ type: "rule", field: "title", op: "isNot", value: "nope" }],
        { sort: { field: "title", direction: "asc" }, limit: 2 }
      ),
      ctx(tracks)
    );
    assert.deepEqual(result.trackIds, ["a", "b"]);
    assert.equal(result.totalMatches, 3);
  });

  it("keeps random order stable for the same seed", () => {
    const def = defWithRules(
      [{ type: "rule", field: "title", op: "isNot", value: "zzz" }],
      { sort: { field: "random", direction: "asc" }, randomSeed: 42 }
    );
    const first = sp.evaluateSmartPlaylist(def, ctx(tracks));
    const second = sp.evaluateSmartPlaylist(def, ctx(tracks));
    assert.deepEqual(first.trackIds, second.trackIds);
    const other = sp.evaluateSmartPlaylist(
      { ...def, randomSeed: 99 },
      ctx(tracks)
    );
    // Extremely likely different; if equal, still proves determinism of each seed
    assert.deepEqual(
      sp.evaluateSmartPlaylist({ ...def, randomSeed: 99 }, ctx(tracks)).trackIds,
      other.trackIds
    );
  });
});

describe("preview session staleness", () => {
  it("ignores stale generation ids", () => {
    const session = sp.createPreviewSession();
    const gen1 = session.next();
    const gen2 = session.next();
    assert.equal(session.isCurrent(gen1), false);
    assert.equal(session.isCurrent(gen2), true);
  });

  it("preview uses the same evaluator membership order", () => {
    const tracks = [
      track({ id: "a", title: "A" }),
      track({ id: "b", title: "B" }),
      track({ id: "c", title: "C" })
    ];
    const def = defWithRules(
      [{ type: "rule", field: "title", op: "isNot", value: "nope" }],
      { sort: { field: "title", direction: "asc" }, limit: null }
    );
    const full = sp.evaluateSmartPlaylist(def, ctx(tracks));
    const preview = sp.previewSmartPlaylist(def, ctx(tracks), 2);
    assert.equal(preview.totalMatches, full.totalMatches);
    assert.deepEqual(preview.trackIds, full.trackIds.slice(0, 2));
  });
});

describe("normalize and templates", () => {
  it("preserves smart definition shape", () => {
    const raw = {
      match: "any",
      rules: {
        type: "group",
        op: "any",
        children: [{ type: "rule", field: "artist", op: "is", value: "X" }]
      },
      sort: { field: "playCount", direction: "desc" },
      limit: 50,
      randomSeed: 7,
      templatesHint: "most-played"
    };
    const normalized = sp.normalizeSmartDefinition(raw);
    assert.equal(normalized.match, "any");
    assert.equal(normalized.limit, 50);
    assert.equal(normalized.sort.field, "playCount");
    assert.equal(sp.validateSmartDefinition(normalized).ok, true);
  });

  it("lists templates with availability gating", () => {
    const disabled = sp.listTemplates({ dateAdded: false, stats: false, liked: false });
    const recent = disabled.find((t) => t.id === "recently-added");
    assert.equal(recent.enabled, false);
    const enabled = sp.listTemplates({ dateAdded: true, stats: true, liked: true });
    assert.ok(enabled.every((t) => t.enabled));
  });
});

describe("dependencies", () => {
  it("tags stats and dateRelative deps", () => {
    const def = defWithRules([
      { type: "rule", field: "lastPlayed", op: "olderThanDays", value: { days: 10 } }
    ]);
    const deps = sp.definitionDependencies(def);
    assert.equal(deps.stats, true);
    assert.equal(deps.dateRelative, true);
  });
});

describe("filter then sort then limit", () => {
  it("applies pipeline in order and keeps totalMatches pre-limit", () => {
    const tracks = [
      track({ id: "a", title: "A", playCount: 0 }),
      track({ id: "b", title: "B", playCount: 0 }),
      track({ id: "c", title: "C", playCount: 0 }),
      track({ id: "d", title: "D", playCount: 9 })
    ];
    const result = sp.evaluateSmartPlaylist(
      defWithRules(
        [{ type: "rule", field: "playCount", op: "eq", value: 0 }],
        { sort: { field: "title", direction: "desc" }, limit: 2 }
      ),
      ctx(tracks, { listenStats: { d: { playCount: 9, lastPlayedAt: NOW } } })
    );
    assert.equal(result.totalMatches, 3);
    assert.deepEqual(result.trackIds, ["c", "b"]);
  });
});
