"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const L = require("./lyrics-prefs.js");

describe("normalize", () => {
  it("falls back to defaults for missing or malformed data", () => {
    for (const raw of [null, undefined, "x", [], 5]) {
      assert.deepEqual(L.normalize(raw), L.createDefault());
    }
  });

  it("keeps valid text scales and meaningful track entries only", () => {
    const prefs = L.normalize({
      textScale: 1.3,
      tracks: {
        a: { offsetMs: 500, at: 10 },
        b: { hidden: true, at: 20 },
        c: { offsetMs: 0, hidden: false, at: 30 },
        "": { hidden: true },
        d: "nope"
      }
    });
    assert.equal(prefs.textScale, 1.3);
    assert.deepEqual(Object.keys(prefs.tracks).sort(), ["a", "b"]);
    assert.equal(L.normalize({ textScale: 7 }).textScale, 1);
  });

  it("snaps and clamps stored offsets", () => {
    const prefs = L.normalize({ tracks: { a: { offsetMs: 610 }, b: { offsetMs: -99999 } } });
    assert.equal(prefs.tracks.a.offsetMs, 500);
    assert.equal(prefs.tracks.b.offsetMs, -L.MAX_OFFSET_MS);
  });

  it("caps stored songs, keeping the most recently changed", () => {
    const tracks = {};
    for (let i = 0; i < L.MAX_TRACKS + 5; i += 1) {
      tracks[`t${i}`] = { hidden: true, at: i };
    }
    const prefs = L.normalize({ tracks });
    assert.equal(Object.keys(prefs.tracks).length, L.MAX_TRACKS);
    assert.ok(prefs.tracks[`t${L.MAX_TRACKS + 4}`]);
    assert.ok(!prefs.tracks.t0);
  });
});

describe("text size", () => {
  it("steps within the allowed scales", () => {
    const prefs = L.createDefault();
    assert.equal(L.textScaleLabel(prefs.textScale), "100%");
    assert.ok(L.stepTextScale(prefs, 1));
    assert.equal(prefs.textScale, 1.15);
    while (L.stepTextScale(prefs, 1)) { /* to max */ }
    assert.equal(prefs.textScale, 1.5);
    assert.equal(L.canStepTextScale(prefs, 1), false);
    while (L.stepTextScale(prefs, -1)) { /* to min */ }
    assert.equal(prefs.textScale, 0.85);
    assert.equal(L.canStepTextScale(prefs, -1), false);
  });
});

describe("timing offset", () => {
  it("nudges per song in fixed steps, clamped, and resets", () => {
    const prefs = L.createDefault();
    assert.equal(L.nudgeOffset(prefs, "a", 250, 1), 250);
    assert.equal(L.nudgeOffset(prefs, "a", 250, 2), 500);
    assert.equal(L.offsetMs(prefs, "a"), 500);
    assert.equal(L.offsetMs(prefs, "b"), 0);
    for (let i = 0; i < 100; i += 1) {
      L.nudgeOffset(prefs, "a", 250, 3);
    }
    assert.equal(L.offsetMs(prefs, "a"), L.MAX_OFFSET_MS);
    assert.ok(L.resetOffset(prefs, "a", 4));
    assert.equal(L.offsetMs(prefs, "a"), 0);
    assert.ok(!prefs.tracks.a, "an entry with nothing set is dropped");
  });

  it("describes what the adjustment does", () => {
    assert.equal(L.describeOffset(0), "In sync");
    assert.equal(L.describeOffset(500), "0.5s later");
    assert.equal(L.describeOffset(-250), "0.25s earlier");
    assert.equal(L.describeOffset(2000), "2s later");
  });

  it("shifts the position lyrics see and the seek target symmetrically", () => {
    // Lyrics running early → delay them: at 10s of audio the lyrics act as if it were 9.5s.
    assert.equal(L.effectivePosition(10, 500), 9.5);
    assert.equal(L.seekTimeForLine(9.5, 500), 10);
    assert.equal(L.seekTimeForLine(0.2, -500), 0);
  });
});

describe("hidden songs", () => {
  it("hides and shows lyrics per song", () => {
    const prefs = L.createDefault();
    assert.equal(L.isHidden(prefs, "a"), false);
    assert.ok(L.setHidden(prefs, "a", true, 1));
    assert.equal(L.isHidden(prefs, "a"), true);
    assert.equal(L.setHidden(prefs, "a", true, 2), false, "no-op change reports false");
    assert.ok(L.setHidden(prefs, "a", false, 3));
    assert.equal(L.isHidden(prefs, "a"), false);
  });

  it("keeps the offset when hiding and unhiding", () => {
    const prefs = L.createDefault();
    L.nudgeOffset(prefs, "a", 500, 1);
    L.setHidden(prefs, "a", true, 2);
    L.setHidden(prefs, "a", false, 3);
    assert.equal(L.offsetMs(prefs, "a"), 500);
  });
});

describe("breakProgress", () => {
  const lines = [
    { time: 10, text: "Sing" },
    { time: 20, text: "" },
    { time: 30, text: "Again" },
    { time: 40, text: "" }
  ];

  it("measures progress through an instrumental break", () => {
    assert.equal(L.breakProgress(lines, 1, 20), 0);
    assert.equal(L.breakProgress(lines, 1, 25), 0.5);
    assert.equal(L.breakProgress(lines, 1, 31), 1);
  });

  it("returns null for sung lines and trailing breaks", () => {
    assert.equal(L.breakProgress(lines, 0, 12), null);
    assert.equal(L.breakProgress(lines, 3, 45), null);
    assert.equal(L.breakProgress(null, 0, 1), null);
  });
});

describe("sourceCredit", () => {
  it("names where the lyrics came from", () => {
    assert.equal(L.sourceCredit("file", "Lullaby.lrc"), "Lyrics from Lullaby.lrc");
    assert.equal(L.sourceCredit("file", ""), "Lyrics from a file next to this song");
    assert.equal(L.sourceCredit("embedded"), "Lyrics from this song's file");
    assert.equal(L.sourceCredit("lrclib"), "Lyrics from LRCLIB");
    assert.equal(L.sourceCredit(undefined), "Lyrics from LRCLIB");
  });
});
