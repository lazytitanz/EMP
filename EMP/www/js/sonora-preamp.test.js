"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  PREAMP_MIN_DB,
  PREAMP_MAX_DB,
  PREAMP_UI_STEP_DB,
  PREAMP_SNAP_TO_ZERO_DB,
  clampPreampDb,
  quantizePreampDb,
  composePreampDb,
  formatPreampDb
} = require("./sonora-preamp.js");

describe("Sonora preamp composition", () => {
  it("uses Sonora's ±24 dB range", () => {
    assert.equal(PREAMP_MIN_DB, -24);
    assert.equal(PREAMP_MAX_DB, 24);
    assert.equal(clampPreampDb(-30), -24);
    assert.equal(clampPreampDb(30), 24);
    assert.equal(clampPreampDb(Number.NaN), 0);
  });

  it("sums user preamp and ReplayGain then clamps", () => {
    assert.equal(composePreampDb(0, 0), 0);
    assert.equal(composePreampDb(3, -1.5), 1.5);
    assert.equal(composePreampDb(20, 10), 24);
    assert.equal(composePreampDb(-20, -10), -24);
  });

  it("formats display values with sign and one decimal", () => {
    assert.equal(formatPreampDb(0), "0.0 dB");
    assert.equal(formatPreampDb(1.25), "+1.3 dB");
    assert.equal(formatPreampDb(-2), "-2.0 dB");
  });

  it("quantizes to 0.5 dB steps and snaps near unity", () => {
    assert.equal(PREAMP_UI_STEP_DB, 0.5);
    assert.equal(PREAMP_SNAP_TO_ZERO_DB, 0.75);
    assert.equal(quantizePreampDb(1.2), 1);
    assert.equal(quantizePreampDb(-1.24), -1);
    assert.equal(quantizePreampDb(0.5), 0);
    assert.equal(quantizePreampDb(-0.5), 0);
    assert.equal(quantizePreampDb(0), 0);
    assert.equal(quantizePreampDb(30), 24);
  });
});
