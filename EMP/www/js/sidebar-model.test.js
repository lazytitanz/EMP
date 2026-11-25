"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const S = require("./sidebar-model.js");
const H = require("./home-model.js");

const item = (kind, id, title, recency = 0, extra = []) => ({ kind, id, title, recency, search: [title, ...extra] });

function catalog() {
  return {
    playlists: [item("playlist", "pl_liked", "Liked Songs", 50), item("playlist", "pl_drive", "Late Night Drive", 300)],
    albums: [
      item("album", "al_inside", "INSIDE", 100, ["Bo Burnham"]),
      item("album", "al_heart", "Heartbreak Anniversary", 400, ["GIVĒON"]),
      item("album", "al_watch", "watch u sleep", 200, ["Braden Ross"])
    ],
    artists: [item("artist", "Braden Ross", "Braden Ross", 250)],
    folders: [item("folder", "D:\\Music", "Music"), item("folder", "E:\\Archive", "Archive")]
  };
}

function resolverFor(cat, extra = {}) {
  const all = [...cat.playlists, ...cat.albums, ...cat.artists];
  return (pin) => extra[S.itemKey(pin)] || all.find((entry) => S.itemKey(entry) === S.itemKey(pin)) || null;
}

const keys = (rows) => rows.map((row) => row.key);

describe("filter and sort state", () => {
  it("toggles a filter and clears it when the active one is chosen again", () => {
    assert.equal(S.toggleFilter(null, "albums"), "albums");
    assert.equal(S.toggleFilter("albums", "albums"), null);
    assert.equal(S.toggleFilter("albums", "folders"), "folders");
    assert.equal(S.toggleFilter("albums", "tracks"), null);
  });

  it("normalizes unknown and legacy values", () => {
    assert.equal(S.normalizeFilter("tracks"), null);
    assert.equal(S.normalizeFilter("playlists"), "playlists");
    assert.equal(S.normalizeSort(undefined), "recent");
    assert.equal(S.normalizeSort("title"), "title");
  });
});

describe("buildList", () => {
  it("mixes playlists, albums and artists (no folders) by recency when unfiltered", () => {
    const cat = catalog();
    const list = S.buildList({ catalog: cat, resolvePin: resolverFor(cat) });
    assert.deepEqual(keys(list.rest), [
      "album:al_heart", "playlist:pl_drive", "artist:braden ross", "album:al_watch", "album:al_inside", "playlist:pl_liked"
    ]);
    assert.ok(!list.rest.some((row) => row.item.kind === "folder"));
  });

  it("sorts A–Z with the supplied comparer", () => {
    const cat = catalog();
    const list = S.buildList({ catalog: cat, sort: "title" });
    assert.deepEqual(list.rest.map((row) => row.item.title), [
      "Braden Ross", "Heartbreak Anniversary", "INSIDE", "Late Night Drive", "Liked Songs", "watch u sleep"
    ]);
  });

  it("shows folders only under the Folders filter", () => {
    const cat = catalog();
    const list = S.buildList({ catalog: cat, filter: "folders", sort: "title" });
    assert.deepEqual(keys(list.rest), ["folder:e:\\archive", "folder:d:\\music"]);
  });

  it("puts pins first in user order without duplicating them below", () => {
    const cat = catalog();
    const pins = [{ kind: "album", id: "al_inside" }, { kind: "playlist", id: "pl_liked" }];
    const list = S.buildList({ catalog: cat, pins, resolvePin: resolverFor(cat) });
    assert.deepEqual(keys(list.pinned), ["album:al_inside", "playlist:pl_liked"]);
    assert.ok(!keys(list.rest).includes("album:al_inside"));
    assert.ok(!keys(list.rest).includes("playlist:pl_liked"));
  });

  it("respects the active filter and filter text for pins", () => {
    const cat = catalog();
    const pins = [{ kind: "album", id: "al_inside" }, { kind: "playlist", id: "pl_liked" }];
    const resolvePin = resolverFor(cat);
    assert.deepEqual(keys(S.buildList({ catalog: cat, pins, resolvePin, filter: "playlists" }).pinned), ["playlist:pl_liked"]);
    assert.deepEqual(keys(S.buildList({ catalog: cat, pins, resolvePin, query: "burnham" }).pinned), ["album:al_inside"]);
  });

  it("matches artist pins case-insensitively, consistent with Home pin keys", () => {
    const cat = catalog();
    const pin = { kind: "artist", id: "braden ROSS" };
    assert.equal(S.itemKey(pin), H.pinKey(pin));
    const list = S.buildList({ catalog: cat, pins: [pin], resolvePin: resolverFor(cat) });
    assert.deepEqual(keys(list.pinned), ["artist:braden ross"]);
    assert.ok(!keys(list.rest).includes("artist:braden ross"));
  });

  it("keeps unavailable pins as labelled rows and filters them by their label", () => {
    const cat = catalog();
    const pins = [{ kind: "album", id: "al_gone", label: "Offline Album" }, { kind: "album", id: "al_inside" }];
    const list = S.buildList({ catalog: cat, pins, resolvePin: resolverFor(cat) });
    assert.deepEqual(list.pinned.map((row) => [row.key, row.unavailable]), [["album:al_gone", true], ["album:al_inside", false]]);
    assert.equal(list.pinned[0].pin.label, "Offline Album");
    assert.equal(S.buildList({ catalog: cat, pins, resolvePin: resolverFor(cat), query: "offline" }).pinned.length, 1);
    assert.equal(S.buildList({ catalog: cat, pins, resolvePin: resolverFor(cat), filter: "artists" }).pinned.length, 0);
  });

  it("shows pinned mixes only in the unfiltered view", () => {
    const cat = catalog();
    const mix = item("mix", "mix_daily_1", "Daily Mix 1");
    const pins = [{ kind: "mix", id: "mix_daily_1" }];
    const resolvePin = resolverFor(cat, { "mix:mix_daily_1": mix });
    assert.deepEqual(keys(S.buildList({ catalog: cat, pins, resolvePin }).pinned), ["mix:mix_daily_1"]);
    for (const filter of S.FILTERS) {
      assert.equal(S.buildList({ catalog: cat, pins, resolvePin, filter }).pinned.length, 0, filter);
    }
  });

  it("excludes unavailable pins from the collapsed rail but keeps order", () => {
    const cat = catalog();
    const pins = [{ kind: "album", id: "al_gone" }, { kind: "album", id: "al_inside" }];
    const rows = S.railRows(S.buildList({ catalog: cat, pins, resolvePin: resolverFor(cat) }));
    assert.equal(rows[0].key, "album:al_inside");
    assert.ok(!rows.some((row) => row.key === "album:al_gone"));
  });

  it("does not mutate inputs", () => {
    const cat = catalog();
    const snapshot = JSON.stringify(cat);
    const pins = [{ kind: "album", id: "al_inside" }];
    S.buildList({ catalog: cat, pins, resolvePin: resolverFor(cat), sort: "title" });
    assert.equal(JSON.stringify(cat), snapshot);
    assert.deepEqual(pins, [{ kind: "album", id: "al_inside" }]);
  });
});

describe("empty reasons", () => {
  const empty = { playlists: [], albums: [], artists: [], folders: [] };

  it("reports genuinely empty collections per filter", () => {
    assert.equal(S.buildList({ catalog: empty }).emptyReason, "library-empty");
    assert.equal(S.buildList({ catalog: empty, filter: "playlists" }).emptyReason, "no-playlists");
    assert.equal(S.buildList({ catalog: empty, filter: "albums" }).emptyReason, "no-albums");
    assert.equal(S.buildList({ catalog: empty, filter: "artists" }).emptyReason, "no-artists");
    assert.equal(S.buildList({ catalog: empty, filter: "folders" }).emptyReason, "no-folders");
  });

  it("distinguishes a filter that matched nothing from an empty collection", () => {
    const cat = catalog();
    assert.equal(S.buildList({ catalog: cat, query: "zzz" }).emptyReason, "no-matches");
    assert.equal(S.buildList({ catalog: cat, filter: "playlists", query: "zzz" }).emptyReason, "no-matches");
    assert.equal(S.buildList({ catalog: cat }).emptyReason, "");
  });

  it("treats an unavailable pin as non-empty so creation prompts are not shown", () => {
    const list = S.buildList({ catalog: empty, pins: [{ kind: "playlist", id: "pl_x", label: "X" }], filter: "playlists" });
    assert.equal(list.emptyReason, "");
    assert.equal(list.pinned[0].unavailable, true);
  });
});

describe("playingKey", () => {
  const base = { hasTrack: true, entryOrigin: "source" };

  it("attributes albums, playlists, smart playlists, artists and mixes from the queue source", () => {
    assert.equal(S.playingKey({ ...base, source: { kind: "album", id: "al_1" } }), "album:al_1");
    assert.equal(S.playingKey({ ...base, source: { kind: "playlist", id: "pl_1" } }), "playlist:pl_1");
    assert.equal(S.playingKey({ ...base, source: { kind: "smart", id: "pl_s" } }), "playlist:pl_s");
    assert.equal(S.playingKey({ ...base, source: { kind: "artist", id: "Bo Burnham" } }), "artist:bo burnham");
    assert.equal(S.playingKey({ ...base, source: { kind: "mix", id: "mix_1" } }), "mix:mix_1");
  });

  it("does not attribute manually queued tracks or collection-less sources", () => {
    assert.equal(S.playingKey({ ...base, entryOrigin: "user", source: { kind: "album", id: "al_1" } }), "");
    for (const kind of ["library", "songs", "recents", "homeTop"]) {
      assert.equal(S.playingKey({ ...base, source: { kind } }), "", kind);
    }
    assert.equal(S.playingKey({ ...base, hasTrack: false, source: { kind: "album", id: "al_1" } }), "");
    assert.equal(S.playingKey({ ...base, source: null }), "");
  });
});

describe("folders", () => {
  const roots = { a1: ["D:\\Music"], a2: ["E:\\Archive", "D:/Music/"], a3: ["D:\\Music2"] };

  it("matches albums to a watched folder case- and separator-insensitively", () => {
    assert.equal(S.albumInFolder(roots, "a1", "d:\\music\\"), true);
    assert.equal(S.albumInFolder(roots, "a2", "D:\\Music"), true);
    assert.equal(S.albumInFolder(roots, "a2", "E:/Archive"), true);
    assert.equal(S.albumInFolder(roots, "missing", "D:\\Music"), false);
  });

  it("does not treat a sibling prefix as the same folder", () => {
    assert.equal(S.albumInFolder(roots, "a3", "D:\\Music"), false);
  });
});

describe("formatCount", () => {
  it("formats non-negative integers", () => {
    assert.equal(S.formatCount(2418, "en-US"), "2,418");
    assert.equal(S.formatCount(-3, "en-US"), "0");
    assert.equal(S.formatCount("x", "en-US"), "0");
  });
});
