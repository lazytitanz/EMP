"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { userVolumeGain } = require("./sonora-volume.js");

describe("Sonora volume mapping", () => {
  it("maps UI percent through power² to linear gain", () => {
    assert.equal(userVolumeGain(0, false), 0);
    assert.equal(userVolumeGain(100, false), 1);
    assert.equal(userVolumeGain(50, false), 0.25);
    assert.ok(Math.abs(userVolumeGain(80, false) - 0.64) < 1e-12);
  });

  it("mute forces zero even when slider percent is non-zero", () => {
    assert.equal(userVolumeGain(80, true), 0);
    assert.equal(userVolumeGain(100, true), 0);
  });

  it("clamps out-of-range percents", () => {
    assert.equal(userVolumeGain(-10, false), 0);
    assert.equal(userVolumeGain(150, false), 1);
  });
});
