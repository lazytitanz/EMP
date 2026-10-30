"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  peakProtectMixGains,
  bypassStrategy,
  applyCompressorParams,
  COMPRESSOR
} = require("./peak-protect.js");

describe("peak protect", () => {
  it("uses dry/wet gains for click-free bypass", () => {
    assert.deepEqual(peakProtectMixGains(true), { dry: 0, wet: 1 });
    assert.deepEqual(peakProtectMixGains(false), { dry: 1, wet: 0 });
  });

  it("documents a non-disconnect bypass strategy", () => {
    const strategy = bypassStrategy();
    assert.equal(strategy.disconnectsLivePath, false);
    assert.equal(strategy.kind, "dry-wet-gain-ramp");
    assert.ok(strategy.rampTimeConstant > 0);
  });

  it("applies conservative compressor parameters", () => {
    const compressor = {
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 1 },
      attack: { value: 0 },
      release: { value: 0 }
    };
    applyCompressorParams(compressor);
    assert.equal(compressor.threshold.value, COMPRESSOR.threshold);
    assert.equal(compressor.ratio.value, COMPRESSOR.ratio);
  });
});
