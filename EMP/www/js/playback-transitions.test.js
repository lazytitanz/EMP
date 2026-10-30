"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  clampCrossfadeSeconds,
  applyTransitionExclusivity,
  crossfadeDurationMs,
  shouldStartCrossfade,
  shouldStartGapless,
  shouldPreloadNext,
  isIncomingPreloadValid,
  CROSSFADE_DEFAULT_SECONDS
} = require("./playback-transitions.js");

describe("playback transitions", () => {
  it("clamps crossfade duration to 1–12 with default 8", () => {
    assert.equal(clampCrossfadeSeconds(undefined), CROSSFADE_DEFAULT_SECONDS);
    assert.equal(clampCrossfadeSeconds(0), 1);
    assert.equal(clampCrossfadeSeconds(20), 12);
    assert.equal(clampCrossfadeSeconds(5), 5);
  });

  it("makes crossfade and gapless mutually exclusive", () => {
    assert.deepEqual(
      applyTransitionExclusivity("crossfade", true, { crossfade: false, gapless: true }),
      { crossfade: true, gapless: false }
    );
    assert.deepEqual(
      applyTransitionExclusivity("gapless", true, { crossfade: true, gapless: false }),
      { crossfade: false, gapless: true }
    );
  });

  it("schedules crossfade duration from remaining time", () => {
    assert.equal(crossfadeDurationMs(8, 3), 3000);
    assert.equal(crossfadeDurationMs(8, 20), 8000);
    assert.equal(crossfadeDurationMs(8, 0.1), 500);
  });

  it("detects crossfade and gapless start windows", () => {
    assert.equal(shouldStartCrossfade(8, 8), true);
    assert.equal(shouldStartCrossfade(0.04, 8), false);
    assert.equal(shouldStartGapless(0.1), true);
    assert.equal(shouldStartGapless(0.2), false);
  });

  it("gates preload on transition settings and horizon", () => {
    assert.equal(shouldPreloadNext({
      remote: false,
      connecting: false,
      transitioning: false,
      repeatOne: false,
      crossfade: true,
      gapless: false,
      remainingSeconds: 15,
      crossfadeSeconds: 8
    }), true);
    assert.equal(shouldPreloadNext({
      remote: false,
      connecting: false,
      transitioning: false,
      repeatOne: false,
      crossfade: false,
      gapless: false,
      remainingSeconds: 5,
      crossfadeSeconds: 8
    }), false);
    assert.equal(shouldPreloadNext({
      remote: true,
      connecting: false,
      transitioning: false,
      repeatOne: false,
      crossfade: true,
      gapless: false,
      remainingSeconds: 5,
      crossfadeSeconds: 8
    }), false);
  });

  it("validates incoming preload against scheduled next id", () => {
    assert.equal(isIncomingPreloadValid("a", "a"), true);
    assert.equal(isIncomingPreloadValid("a", "b"), false);
    assert.equal(isIncomingPreloadValid(null, null), true);
    assert.equal(isIncomingPreloadValid("a", null), false);
  });
});
