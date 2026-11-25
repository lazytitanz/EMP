"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./home-model.js");

const DAY = 24 * 60 * 60 * 1000;
const local = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("normalize / migration", () => {
  it("creates defaults for missing or malformed documents", () => {
    for (const raw of [null, undefined, "x", [], 42]) {
      const doc = H.normalize(raw);
      assert.deepEqual(doc.pins, []);
      assert.equal(doc.pinsSeeded, false);
      assert.deepEqual(doc.sections.map((s) => s.id), H.SECTION_IDS);
      assert.deepEqual(doc.history, []);
    }
  });

  it("drops obsolete section ids, keeps order, and inserts new sections at their default slot", () => {
    const doc = H.normalize({
      sections: [
        { id: "mostPlayed", visible: false },
        { id: "recentlyAdded", visible: true },
        { id: "albums", visible: false },
        "pinned",
        { id: "pinned", visible: false }
      ]
    });
    assert.deepEqual(doc.sections.map((s) => s.id), ["continue", "mostPlayed", "pinned", "jumpBackIn", "mixes", "newInLibrary"]);
    assert.equal(doc.sections[0].visible, true);
    assert.equal(doc.sections[1].visible, false);
    assert.equal(doc.sections[2].visible, true);
  });

  it("dedupes and caps pins, rejecting unknown kinds", () => {
    const pins = [
      { kind: "album", id: "a" },
      { kind: "album", id: "a" },
      { kind: "artist", id: "Rihanna" },
      { kind: "artist", id: "rihanna" },
      { kind: "track", id: "t" },
      ...Array.from({ length: 12 }, (_, i) => ({ kind: "album", id: `x${i}` }))
    ];
    const doc = H.normalize({ pins });
    assert.equal(doc.pins.length, H.MAX_PINS);
    assert.deepEqual(doc.pins.slice(0, 2), [{ kind: "album", id: "a" }, { kind: "artist", id: "Rihanna" }]);
    assert.equal(doc.pinsSeeded, true);
  });

  it("keeps the newest history entry per destination and caps at MAX_HISTORY", () => {
    const history = Array.from({ length: 600 }, (_, i) => ({ kind: "album", id: `a${i}`, at: 1000 + i }));
    history.push({ kind: "album", id: "a5", at: 99999 }, { kind: "album", id: "bad", at: -1 });
    const doc = H.normalize({ history });
    assert.equal(doc.history.length, H.MAX_HISTORY);
    assert.deepEqual(doc.history[0], { kind: "album", id: "a5", at: 99999 });
    assert.ok(!doc.history.some((e) => e.id === "bad"));
  });
});

describe("pins", () => {
  it("add / duplicate / limit / remove / move", () => {
    const doc = H.createDefault();
    assert.deepEqual(H.addPin(doc, { kind: "album", id: "a" }), { ok: true });
    assert.deepEqual(H.addPin(doc, { kind: "album", id: "a" }), { ok: false, reason: "duplicate" });
    assert.deepEqual(H.addPin(doc, { kind: "song", id: "a" }), { ok: false, reason: "invalid" });
    for (let i = 1; i < H.MAX_PINS; i += 1) {
      H.addPin(doc, { kind: "playlist", id: `p${i}` });
    }
    assert.equal(H.pinsFull(doc), true);
    assert.deepEqual(H.addPin(doc, { kind: "mix", id: "heavy-rotation" }), { ok: false, reason: "limit" });

    assert.equal(H.movePin(doc, { kind: "album", id: "a" }, -1), false);
    assert.equal(H.movePin(doc, { kind: "album", id: "a" }, 1), true);
    assert.equal(doc.pins[1].id, "a");
    assert.equal(H.removePin(doc, { kind: "album", id: "a" }), true);
    assert.equal(H.isPinned(doc, { kind: "album", id: "a" }), false);
  });

  it("keeps a bounded label snapshot for unavailable pins", () => {
    const doc = H.createDefault();
    H.addPin(doc, { kind: "playlist", id: "p1", label: "  Late Night Drive  " });
    assert.deepEqual(doc.pins[0], { kind: "playlist", id: "p1", label: "Late Night Drive" });
    const restored = H.normalize({ pins: [{ kind: "album", id: "a", label: "x".repeat(500) }] });
    assert.equal(restored.pins[0].label.length, 200);
  });

  it("artist pins match case-insensitively", () => {
    const doc = H.createDefault();
    H.addPin(doc, { kind: "artist", id: "Bo Burnham" });
    assert.equal(H.isPinned(doc, { kind: "artist", id: "bo burnham" }), true);
  });

  it("seeds Liked Songs once, only when available, and respects later unpinning", () => {
    const doc = H.createDefault();
    assert.equal(H.seedDefaultPins(doc, { likedAvailable: false }), false);
    assert.equal(doc.pins.length, 0);
    assert.equal(H.seedDefaultPins(doc, { likedAvailable: true }), true);
    assert.deepEqual(doc.pins, [{ kind: "playlist", id: "pl_liked" }]);
    H.removePin(doc, H.LIKED_PIN);
    assert.equal(H.seedDefaultPins(doc, { likedAvailable: true }), false);
    assert.equal(doc.pins.length, 0);
    const reloaded = H.normalize(JSON.parse(JSON.stringify(doc)));
    assert.equal(H.seedDefaultPins(reloaded, { likedAvailable: true }), false);
  });

  it("user pin actions before Liked exists prevent a later automatic seed", () => {
    const doc = H.createDefault();
    H.addPin(doc, { kind: "album", id: "a" });
    assert.equal(H.seedDefaultPins(doc, { likedAvailable: true }), false);
  });
});

describe("listening history", () => {
  it("records only destination sources and maps smart playlists to playlists", () => {
    const doc = H.createDefault();
    assert.equal(H.recordPlay(doc, { kind: "songs" }, 10), false);
    assert.equal(H.recordPlay(doc, { kind: "library" }, 10), false);
    assert.equal(H.recordPlay(doc, { kind: "album" }, 10), false);
    assert.equal(H.recordPlay(doc, { kind: "smart", id: "pl_1" }, 20), true);
    assert.equal(H.recordPlay(doc, { kind: "album", id: "a" }, 30), true);
    assert.equal(H.recordPlay(doc, { kind: "smart", id: "pl_1" }, 40), true);
    assert.deepEqual(doc.history, [
      { kind: "playlist", id: "pl_1", at: 40 },
      { kind: "album", id: "a", at: 30 }
    ]);
  });

  it("derived album times stay albums and never become playlist/mix entries", () => {
    const merged = H.mergeHistory(
      [{ kind: "playlist", id: "p", at: 50 }, { kind: "album", id: "a", at: 10 }],
      [{ id: "a", at: 40 }, { id: "b", at: 30 }, { id: "p", at: 99 }]
    );
    assert.deepEqual(merged.map((e) => [e.kind, e.id, e.at, e.origin]), [
      ["album", "p", 99, "track"],
      ["playlist", "p", 50, "context"],
      ["album", "a", 40, "track"],
      ["album", "b", 30, "track"]
    ]);
  });

  it("skips pinned entries only while enough others fill the row, keeping chronology", () => {
    const entries = ["a", "b", "c", "d"].map((id, i) => ({ kind: "album", id, at: 100 - i }));
    const pinned = (e) => e.id === "a" || e.id === "c";
    const many = H.pickJumpBackIn(entries, { limit: 2, isPinned: pinned });
    assert.deepEqual(many.map((r) => r.entry.id), ["b", "d"]);
    const few = H.pickJumpBackIn(entries, { limit: 3, isPinned: pinned });
    assert.deepEqual(few.map((r) => r.entry.id), ["a", "b", "d"]);
    const unresolved = H.pickJumpBackIn(entries, { limit: 4, resolve: (e) => (e.id === "b" ? null : e) });
    assert.deepEqual(unresolved.map((r) => r.entry.id), ["a", "c", "d"]);
  });
});

describe("dates", () => {
  const now = local(2026, 11, 24, 17);

  it("relative labels follow local calendar days", () => {
    assert.equal(H.relativeDay(local(2026, 11, 24, 0, 5), now), "Today");
    assert.equal(H.relativeDay(local(2026, 11, 23, 23, 59), now), "Yesterday");
    assert.equal(H.relativeDay(local(2026, 11, 21), now), "3 days ago");
    assert.equal(H.relativeDay(local(2026, 11, 15), now), "Last week");
    assert.equal(H.relativeDay(local(2026, 11, 3), now), "3 weeks ago");
    assert.match(H.relativeDay(local(2026, 9, 2), now, "en-US"), /Sep/);
    assert.match(H.relativeDay(local(2025, 9, 2), now, "en-US"), /2025/);
  });

  it("minute-level times for the resume card", () => {
    assert.equal(H.relativeTime(now - 20 * 1000, now), "just now");
    assert.equal(H.relativeTime(now - 12 * 60 * 1000, now), "12 min ago");
    assert.equal(H.relativeTime(now - 3 * 3600 * 1000, now), "3 hr ago");
    assert.equal(H.relativeTime(local(2026, 11, 23, 22), now), "yesterday");
    assert.equal(H.relativeTime(local(2026, 11, 20), now), "4 days ago");
  });

  it("month keys and rollover timing use local time", () => {
    assert.equal(H.monthKey(local(2026, 11, 30, 23, 59)), "2026-11");
    assert.equal(H.monthKey(local(2026, 12, 1, 0, 0)), "2026-12");
    const lateNight = local(2026, 11, 30, 23, 0);
    assert.equal(H.msUntilNextMonth(lateNight), local(2026, 12, 1, 0, 0) - lateNight);
    assert.equal(H.monthKey(lateNight + H.msUntilNextMonth(lateNight)), "2026-12");
  });
});

describe("new in your library", () => {
  const now = local(2026, 11, 24, 17);
  const baseline = local(2026, 10, 1, 9);
  const dates = {
    old1: baseline, old2: baseline,
    bonus: local(2026, 11, 23, 10),
    n1: local(2026, 11, 24, 9), n2: local(2026, 11, 24, 9, 1),
    m1: local(2026, 11, 20)
  };
  const albums = [
    { id: "baselineOnly", title: "Old", trackIds: ["old1"] },
    { id: "deluxe", title: "Deluxe", trackIds: ["old2", "bonus"] },
    { id: "fresh", title: "Fresh", trackIds: ["n1", "n2"] },
    { id: "mid", title: "Mid", trackIds: ["m1"] }
  ];
  const dateAddedOf = (id) => dates[id] || 0;

  it("never presents the baseline as new and distinguishes updated albums", () => {
    const groups = H.groupNewAdditions(albums, { dateAddedOf, baselineAt: baseline, now, locale: "en-US" });
    assert.equal(groups.total, 3);
    assert.deepEqual(groups.map((g) => g.label).slice(0, 2), ["Tue, Nov 24", "Mon, Nov 23"]);
    const flat = groups.flatMap((g) => g.entries);
    assert.deepEqual(flat.map((e) => [e.album.id, e.kind, e.newTrackCount, e.trackCount]), [
      ["fresh", "new", 2, 2],
      ["deluxe", "updated", 1, 2],
      ["mid", "new", 1, 1]
    ]);
  });

  it("returns nothing when the baseline is unknown", () => {
    assert.equal(H.groupNewAdditions(albums, { dateAddedOf, baselineAt: 0, now }).length, 0);
  });

  it("respects the display limit but reports the total", () => {
    const groups = H.groupNewAdditions(albums, { dateAddedOf, baselineAt: baseline, now, limit: 1 });
    assert.equal(groups.flatMap((g) => g.entries).length, 1);
    assert.equal(groups.total, 3);
  });
});

describe("sections", () => {
  it("pairs New + Most played only when both render and are adjacent", () => {
    const doc = H.createDefault();
    assert.deepEqual(H.layoutBlocks(doc).map((b) => b.ids), [["continue"], ["pinned"], ["jumpBackIn"], ["mixes"], ["newInLibrary", "mostPlayed"]]);

    const noPlays = H.layoutBlocks(doc, (id) => id !== "mostPlayed");
    assert.deepEqual(noPlays.at(-1), { type: "single", ids: ["newInLibrary"] });

    H.moveSection(doc, "mostPlayed", -1);
    H.moveSection(doc, "mostPlayed", -1);
    assert.deepEqual(H.layoutBlocks(doc).map((b) => b.type), ["single", "single", "single", "single", "single", "single"]);

    // Hiding the section between them makes them adjacent among visible sections.
    const between = H.createDefault();
    H.moveSection(between, "mixes", 1);
    assert.deepEqual(between.sections.map((s) => s.id).slice(3), ["newInLibrary", "mixes", "mostPlayed"]);
    H.setSectionVisible(between, "mixes", false);
    assert.deepEqual(H.layoutBlocks(between).at(-1), { type: "pair", ids: ["newInLibrary", "mostPlayed"] });
  });

  it("restoring the default layout keeps pins and history", () => {
    const doc = H.createDefault();
    H.addPin(doc, { kind: "album", id: "a" });
    H.recordPlay(doc, { kind: "album", id: "a" }, 5);
    H.setSectionVisible(doc, "pinned", false);
    H.moveSection(doc, "mostPlayed", -3);
    assert.equal(H.isDefaultLayout(doc), false);
    H.restoreDefaultLayout(doc);
    assert.equal(H.isDefaultLayout(doc), true);
    assert.equal(doc.pins.length, 1);
    assert.equal(doc.history.length, 1);
  });
});

describe("top tracks response guard", () => {
  it("drops stale requests and responses for a previous month", () => {
    const response = { requestId: 4, month: "2026-11", tracks: [] };
    assert.equal(H.acceptTopTracksResponse(response, { latestRequestId: 4, currentMonth: "2026-11" }), true);
    assert.equal(H.acceptTopTracksResponse(response, { latestRequestId: 5, currentMonth: "2026-11" }), false);
    assert.equal(H.acceptTopTracksResponse(response, { latestRequestId: 4, currentMonth: "2026-12" }), false);
    assert.equal(H.acceptTopTracksResponse({ ...response, tracks: null }, { latestRequestId: 4, currentMonth: "2026-11" }), false);
  });
});

describe("resume point", () => {
  it("persists only valid pause points and reports them per track", () => {
    const doc = H.createDefault();
    assert.equal(H.pausedAtFor(doc, "t1"), 0);
    assert.equal(H.setResumePoint(doc, "t1", 1000), true);
    assert.equal(H.setResumePoint(doc, "t1", 1000), false);
    assert.equal(H.setResumePoint(doc, "", 2000), false);
    assert.equal(H.pausedAtFor(doc, "t1"), 1000);
    assert.equal(H.pausedAtFor(doc, "t2"), 0);
    const reloaded = H.normalize(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(reloaded.resume, { trackId: "t1", pausedAt: 1000 });
    assert.equal(H.normalize({ resume: { trackId: "x", pausedAt: -5 } }).resume, null);
  });
});
