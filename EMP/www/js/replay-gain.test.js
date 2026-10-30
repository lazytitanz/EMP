"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  dbToLinear,
  clampGainDb,
  clampPeak,
  normalizeMode,
  selectReplayGain,
  computeReplayGainLinear
} = require("./replay-gain.js");

describe("ReplayGain helpers", () => {
  it("converts decibels to linear amplitude", () => {
    assert.ok(Math.abs(dbToLinear(0) - 1) < 1e-12);
    assert.ok(Math.abs(dbToLinear(6) - 1.9952623149688795) < 1e-9);
    assert.ok(Math.abs(dbToLinear(-6) - 0.5011872336272722) < 1e-9);
  });

  it("rejects invalid gain and peak values", () => {
    assert.equal(clampGainDb(Number.NaN), null);
    assert.equal(clampGainDb(Infinity), null);
    assert.equal(clampGainDb(30), null);
    assert.equal(clampGainDb(-30), null);
    assert.equal(clampGainDb(3.5), 3.5);
    assert.equal(clampPeak(0), null);
    assert.equal(clampPeak(-1), null);
    assert.equal(clampPeak(9), null);
    assert.equal(clampPeak(0.95), 0.95);
  });

  it("defaults normalize mode to track", () => {
    assert.equal(normalizeMode("album"), "album");
    assert.equal(normalizeMode("track"), "track");
    assert.equal(normalizeMode("nope"), "track");
  });

  it("selects track gain in track mode", () => {
    const selected = selectReplayGain({
      replayGainTrackGain: -2,
      replayGainTrackPeak: 0.9,
      replayGainAlbumGain: -5,
      replayGainAlbumPeak: 0.8
    }, "track");
    assert.equal(selected.source, "track");
    assert.equal(selected.gainDb, -2);
    assert.equal(selected.peak, 0.9);
  });

  it("selects album gain in album mode and falls back to track", () => {
    const album = selectReplayGain({
      replayGainTrackGain: -2,
      replayGainAlbumGain: -5,
      replayGainAlbumPeak: 0.85
    }, "album");
    assert.equal(album.source, "album");
    assert.equal(album.gainDb, -5);
    assert.equal(album.peak, 0.85);

    const fallback = selectReplayGain({
      replayGainTrackGain: -1.5,
      replayGainTrackPeak: 0.99
    }, "album");
    assert.equal(fallback.source, "track");
    assert.equal(fallback.gainDb, -1.5);
  });

  it("returns unity when disabled or untagged", () => {
    assert.equal(computeReplayGainLinear({ replayGainTrackGain: -3 }, { enabled: false }), 1);
    assert.equal(computeReplayGainLinear({}, { enabled: true, mode: "track" }), 1);
    assert.equal(computeReplayGainLinear({ replayGainTrackGain: Number.NaN }, { enabled: true }), 1);
  });

  it("applies peak cap when linear gain would exceed unity peak", () => {
    const linear = computeReplayGainLinear({
      replayGainTrackGain: 6,
      replayGainTrackPeak: 0.9
    }, { enabled: true, mode: "track" });
    assert.ok(Math.abs(linear - (1 / 0.9)) < 1e-9);
  });

  it("does not label missing metadata as ReplayGain", () => {
    const selected = selectReplayGain({}, "track");
    assert.equal(selected.source, "none");
    assert.equal(selected.gainDb, null);
  });
});
