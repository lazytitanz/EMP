"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const S = require("./session-restore.js");

describe("clampPosition", () => {
  it("keeps a mid-track position", () => {
    assert.equal(S.clampPosition(42.5, 180), 42.5);
  });

  it("floors invalid values at 0", () => {
    assert.equal(S.clampPosition(-3, 180), 0);
    assert.equal(S.clampPosition("nope", 180), 0);
    assert.equal(S.clampPosition(undefined, 180), 0);
  });

  it("keeps non-negative position when duration is unknown", () => {
    assert.equal(S.clampPosition(12, 0), 12);
    assert.equal(S.clampPosition(12, NaN), 12);
    assert.equal(S.clampPosition(12, null), 12);
  });

  it("restarts at 0 when saved position is at or past the end", () => {
    assert.equal(S.clampPosition(180, 180), 0);
    assert.equal(S.clampPosition(200, 180), 0);
  });
});

describe("resolveTrackId", () => {
  const exists = (id) => id === "a" || id === "b";

  it("prefers the saved track when it still exists", () => {
    assert.equal(S.resolveTrackId({ trackId: "b" }, { trackExists: exists, fallbackIds: ["a"] }), "b");
  });

  it("falls back when the saved track is missing", () => {
    assert.equal(
      S.resolveTrackId({ trackId: "gone" }, { trackExists: exists, fallbackIds: ["missing", "a"] }),
      "a"
    );
  });

  it("returns null when nothing valid remains", () => {
    assert.equal(S.resolveTrackId({ trackId: "gone" }, { trackExists: exists, fallbackIds: ["x"] }), null);
    assert.equal(S.resolveTrackId({}, { trackExists: exists, fallbackIds: [] }), null);
  });
});

describe("shouldHoldCuePosition", () => {
  it("holds a restored cue across a pre-seek 0 snapshot", () => {
    assert.equal(S.shouldHoldCuePosition(90, 0, { playing: false }), true);
  });

  it("releases once the engine reports a real position or is playing", () => {
    assert.equal(S.shouldHoldCuePosition(90, 89.5, { playing: false }), false);
    assert.equal(S.shouldHoldCuePosition(90, 0, { playing: true }), false);
  });

  it("does not hold a near-zero cue", () => {
    assert.equal(S.shouldHoldCuePosition(0.2, 0, { playing: false }), false);
  });
});

describe("cuePositionConfirmed", () => {
  it("confirms when the snapshot is near the cue", () => {
    assert.equal(S.cuePositionConfirmed(90, 90.4), true);
    assert.equal(S.cuePositionConfirmed(90, 10), false);
  });
});

describe("pickPersistPosition", () => {
  it("prefers a live mid-track position", () => {
    assert.equal(
      S.pickPersistPosition(42, { trackId: "a", lastTrackId: "a", lastPosition: 10 }),
      42
    );
  });

  it("keeps the last good position when Stop has already zeroed live", () => {
    assert.equal(
      S.pickPersistPosition(0, { trackId: "a", lastTrackId: "a", lastPosition: 77 }),
      77
    );
  });

  it("does not reuse another track's last position", () => {
    assert.equal(
      S.pickPersistPosition(0, { trackId: "b", lastTrackId: "a", lastPosition: 77 }),
      0
    );
  });
});
