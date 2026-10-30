"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  nextBindGeneration,
  capturePlaybackSnapshot,
  queueStateUnchanged,
  positionWithinTolerance,
  lyricsAligned,
  listenSessionIntegrity,
  resolveIncomingAfterRebuild
} = require("./audio-graph-recovery.js");

describe("audio graph recovery", () => {
  it("increments listener bind generation", () => {
    assert.equal(nextBindGeneration(0), 1);
    assert.equal(nextBindGeneration(4), 5);
  });

  it("captures and compares queue state", () => {
    const snap = capturePlaybackSnapshot({
      trackId: "a",
      position: 12.5,
      queue: ["a", "b"],
      shuffleBag: ["a", "b"],
      index: 0,
      shuffle: true,
      repeat: "all",
      incomingTrackId: "b",
      nextId: "b",
      lyricsTrackId: "a",
      listenOccurrenceIds: ["occ-1"]
    });
    assert.equal(queueStateUnchanged(snap, {
      ...snap,
      queue: ["a", "b"]
    }), true);
    assert.equal(queueStateUnchanged(snap, {
      ...snap,
      index: 1
    }), false);
  });

  it("checks position tolerance and lyrics alignment", () => {
    const snap = capturePlaybackSnapshot({ trackId: "a", position: 10, lyricsTrackId: "a" });
    assert.equal(positionWithinTolerance(snap, { trackId: "a", position: 10.2 }), true);
    assert.equal(positionWithinTolerance(snap, { trackId: "a", position: 11 }), false);
    assert.equal(lyricsAligned(snap, "a"), true);
    assert.equal(lyricsAligned(snap, "b"), false);
  });

  it("preserves listen-session integrity without phantom occurrences", () => {
    assert.equal(listenSessionIntegrity(["occ-1"], ["occ-1"]), true);
    assert.equal(listenSessionIntegrity(["occ-1"], ["occ-1", "occ-2"]), false);
    assert.equal(listenSessionIntegrity(["occ-1", "occ-2"], ["occ-1"]), true);
  });

  it("resolves incoming preload after rebuild", () => {
    assert.equal(resolveIncomingAfterRebuild({
      incomingTrackId: "b",
      nextId: "b"
    }), "b");
    assert.equal(resolveIncomingAfterRebuild({
      incomingTrackId: "stale",
      nextId: "b"
    }), "b");
    assert.equal(resolveIncomingAfterRebuild({
      incomingTrackId: null,
      nextId: null
    }), null);
  });
});
