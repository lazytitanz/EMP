"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const A = require("./artist-overview.js");

const DAY = 24 * 60 * 60 * 1000;
const track = (id, extra = {}) => ({ id, title: id, album: "LP", albumId: "al1", trackNumber: 1, duration: 200, ...extra });
const statsFrom = (plays = {}, last = {}) => ({
  playCount: (id) => plays[id] || 0,
  lastPlayedAt: (id) => last[id] || 0
});

describe("topSongs", () => {
  it("ranks by qualified plays with deterministic ties", () => {
    const tracks = ["a", "b", "c", "d"].map((id) => track(id));
    const result = A.topSongs(tracks, statsFrom({ a: 3, b: 9, c: 3, d: 3 }, { a: 100, c: 300, d: 300 }));
    assert.equal(result.title, "Your top songs");
    assert.deepEqual(result.rows.map((row) => row.track.id), ["b", "c", "d", "a"]);
    assert.ok(result.rows.every((row) => row.ranked));
  });

  it("fills with unplayed songs flagged as unranked, never above played ones", () => {
    const tracks = [
      track("old", { albumId: "x", album: "Old" }),
      track("new", { albumId: "y", album: "New" }),
      track("hit")
    ];
    const years = { x: 1999, y: 2020, al1: 2010 };
    const result = A.topSongs(tracks, { ...statsFrom({ hit: 1 }), albumYear: (t) => years[t.albumId] });
    assert.deepEqual(result.rows.map((row) => [row.track.id, row.ranked]), [["hit", true], ["new", false], ["old", false]]);
  });

  it("uses the neutral title and default order with no listening history", () => {
    const tracks = [track("b", { trackNumber: 2 }), track("a", { trackNumber: 1 })];
    const result = A.topSongs(tracks, statsFrom());
    assert.equal(result.title, "Songs");
    assert.equal(result.byPlays, false);
    assert.deepEqual(result.rows.map((row) => row.track.id), ["a", "b"]);
    assert.ok(result.rows.every((row) => !row.ranked));
  });

  it("caps at five and reports whether more exist", () => {
    const six = Array.from({ length: 6 }, (_, i) => track(`t${i}`));
    assert.equal(A.topSongs(six, statsFrom()).rows.length, 5);
    assert.equal(A.topSongs(six, statsFrom()).hasMore, true);
    assert.equal(A.topSongs(six.slice(0, 5), statsFrom()).hasMore, false);
    assert.equal(A.topSongs(six.slice(0, 1), statsFrom()).rows.length, 1);
  });

  it("handles hundreds of songs and duplicate ids", () => {
    const many = Array.from({ length: 800 }, (_, i) => track(`t${i}`));
    many.push(track("t5"));
    const plays = Object.fromEntries(many.map((t, i) => [t.id, i % 37]));
    const result = A.topSongs(many, statsFrom(plays));
    assert.equal(result.total, 800);
    assert.equal(result.rows.length, 5);
    assert.ok(result.rows.every((row) => row.plays === 36));
  });
});

describe("summary", () => {
  const tracks = [track("a", { duration: 100, dateAdded: 5000 }), track("b", { duration: 50, dateAdded: 9000 }), track("a", { duration: 100 })];

  it("aggregates unique tracks only", () => {
    const result = A.summary(tracks, {
      ...statsFrom({ a: 4, b: 2 }, { a: 10, b: 20 }),
      isLiked: (id) => id === "b",
      dateAdded: (t) => t.dateAdded
    });
    assert.deepEqual(
      { songs: result.songs, duration: result.duration, plays: result.plays, liked: result.liked, last: result.lastPlayedAt },
      { songs: 2, duration: 150, plays: 6, liked: 1, last: 20 }
    );
  });

  it("labels the tracking baseline honestly", () => {
    const base = A.summary(tracks, { dateAdded: (t) => t.dateAdded, baselineAt: 5000 });
    assert.deepEqual(base.added, { kind: "baseline", at: 5000 });
    assert.match(A.addedLabel(base.added, { locale: "en-US" }).value, /or earlier$/);

    const tracked = A.summary(tracks, { dateAdded: (t) => t.dateAdded, baselineAt: 1000 });
    assert.deepEqual(tracked.added, { kind: "tracked", at: 5000 });
    assert.doesNotMatch(A.addedLabel(tracked.added, { locale: "en-US" }).value, /earlier/);
  });

  it("omits the addition date when none is known and reports zero plays plainly", () => {
    const result = A.summary([track("x")], { dateAdded: () => 0 });
    assert.equal(result.added, null);
    assert.equal(A.addedLabel(result.added), null);
    assert.equal(result.plays, 0);
    assert.equal(result.lastPlayedAt, 0);
  });
});

describe("lastPlayedLabel", () => {
  const now = new Date(2026, 10, 24, 15).getTime();
  it("describes recency in plain words", () => {
    assert.equal(A.lastPlayedLabel(0, { now }), "Never played");
    assert.equal(A.lastPlayedLabel(now - 60_000, { now }), "Today");
    assert.equal(A.lastPlayedLabel(now - DAY, { now }), "Yesterday");
    assert.equal(A.lastPlayedLabel(now - 3 * DAY, { now }), "3 days ago");
    assert.equal(A.lastPlayedLabel(new Date(2026, 2, 3).getTime(), { now, locale: "en-US" }), "Mar 3");
    assert.equal(A.lastPlayedLabel(new Date(2025, 2, 3).getTime(), { now, locale: "en-US" }), "Mar 3, 2025");
  });
});

describe("playlistsContaining", () => {
  it("uses real membership, counts unique tracks, sorts and caps", () => {
    const playlists = [
      { id: "p1", name: "Road", trackIds: ["a", "a", "z"] },
      { id: "p2", name: "Gym", trackIds: ["a", "b"] },
      { id: "p3", name: "None", trackIds: ["z"] },
      { id: "p4", name: "Chill", trackIds: ["b"] }
    ];
    const result = A.playlistsContaining(new Set(["a", "b"]), playlists, { limit: 2 });
    assert.equal(result.total, 3);
    assert.deepEqual(result.items.map((item) => [item.id, item.count]), [["p2", 2], ["p4", 1]]);
  });
});

describe("releases", () => {
  const albums = [
    { id: "1", title: "B", year: 2005, releaseType: "album" },
    { id: "2", title: "A", year: 2011, releaseType: "single" },
    { id: "3", title: "Z", year: null },
    { id: "4", title: "C", year: 2005, releaseType: "album", releaseSecondaryTypes: ["live"] }
  ];

  it("sorts newest first with unknown years last and stable ties", () => {
    assert.deepEqual(A.sortReleases(albums).map((album) => album.id), ["2", "1", "4", "3"]);
  });

  it("labels from tags only, never from track counts", () => {
    assert.equal(A.releaseLabel({ releaseType: "ep" }), "EP");
    assert.equal(A.releaseLabel(albums[3]), "Live album");
    assert.equal(A.releaseLabel({ releaseType: "album", releaseSecondaryTypes: ["compilation"] }), "Compilation");
    assert.equal(A.releaseLabel({ isSingle: true, trackIds: ["only"] }), "Release");
    assert.equal(A.releaseTypeOf({ releaseType: "bogus" }), null);
  });

  it("only offers filters that narrow the list", () => {
    assert.deepEqual(A.discographyFilters(albums), ["all", "album", "single"]);
    assert.deepEqual(A.discographyFilters([{ releaseType: "album" }, { releaseType: "album" }]), []);
    assert.deepEqual(A.discographyFilters([{ releaseType: "album" }, {}]), ["all", "album"]);
    assert.deepEqual(A.discographyFilters([{}, {}]), []);
    assert.deepEqual(A.filterReleases(albums, "single").map((a) => a.id), ["2"]);
    assert.equal(A.filterReleases(albums, "all").length, 4);
  });
});

describe("partitionReleases", () => {
  const tracks = {
    own1: { id: "own1", artist: "Ross", albumId: "own", albumArtist: "Ross" },
    comp1: { id: "comp1", artist: "Ross", albumId: "comp", albumArtist: "Various Artists" },
    comp2: { id: "comp2", artist: "Other", albumId: "comp", albumArtist: "Various Artists" },
    feat1: { id: "feat1", artist: "Ross", albumId: "feat", albumArtist: "Someone" },
    untag1: { id: "untag1", artist: "Ross", albumId: "untag" },
    mixed1: { id: "mixed1", artist: "Ross", albumId: "mixed", albumArtist: "One" },
    mixed2: { id: "mixed2", artist: "X", albumId: "mixed", albumArtist: "Two" },
    first1: { id: "first1", artist: "Ross", albumId: "first", albumArtist: "Various Artists" }
  };
  const albums = [
    { id: "own", artist: "Ross", trackIds: ["own1"] },
    { id: "comp", artist: "Other", trackIds: ["comp1", "comp2"] },
    { id: "feat", artist: "Someone", trackIds: ["feat1"] },
    { id: "untag", artist: "Someone Else", trackIds: ["untag1"] },
    { id: "mixed", artist: "One", trackIds: ["mixed1", "mixed2"] },
    { id: "first", artist: "Ross", trackIds: ["first1"] },
    { id: "own", artist: "Ross", trackIds: ["own1"] }
  ];
  const matches = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const artistTracks = Object.values(tracks).filter((t) => matches(t.artist, "ross"));

  const result = A.partitionReleases({ name: "ROSS", albums, artistTracks, trackById: (id) => tracks[id], matches });

  it("keeps the artist's own releases (deduplicated) as primary", () => {
    assert.deepEqual(result.primary.map((a) => a.id), ["own"]);
  });

  it("puts tagged releases by someone else in Appears on", () => {
    assert.deepEqual(result.appearsOn.map((a) => a.id).sort(), ["comp", "feat", "first"]);
  });

  it("never guesses untagged or conflicting releases into Appears on", () => {
    const ids = [...result.primary, ...result.appearsOn].map((a) => a.id);
    assert.ok(!ids.includes("untag"));
    assert.ok(!ids.includes("mixed"));
  });
});

describe("heroMetaParts", () => {
  it("drops empties and duplicates", () => {
    assert.deepEqual(
      A.heroMetaParts({ genres: ["Post-grunge", "Alternative Rock", "Rock"], origin: "Escatawpa, Mississippi", songsLabel: "48 songs, 3 hr 2 min" }),
      ["Post-grunge, Alternative Rock", "Escatawpa, Mississippi", "48 songs, 3 hr 2 min"]
    );
    assert.deepEqual(A.heroMetaParts({ genres: [], origin: " ", songsLabel: "1 song" }), ["1 song"]);
    assert.deepEqual(A.heroMetaParts({ genres: ["Rock"], origin: "rock" }), ["Rock"]);
  });
});
