"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// eq-presets.js is a browser script without module.exports — evaluate with minimal stubs.
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "eq-presets.js"), "utf8");
const sandbox = { Object, Math, Array, Number, Boolean, String };
const runner = new Function(
  "Object",
  "Math",
  "Array",
  "Number",
  "Boolean",
  "String",
  `${source}\nreturn { EQ_PRESETS, EQ_PRESET_ORDER, isEqPresetAvailable, listSelectableEqPresets };`
);
const {
  EQ_PRESETS,
  EQ_PRESET_ORDER,
  isEqPresetAvailable,
  listSelectableEqPresets
} = runner(Object, Math, Array, Number, Boolean, String);

describe("EQ presets", () => {
  it("keeps Deep in infrastructure but hides it from the selectable list", () => {
    assert.ok(EQ_PRESETS.deep);
    assert.equal(EQ_PRESETS.deep.available, false);
    assert.equal(isEqPresetAvailable("deep"), false);
    assert.ok(EQ_PRESET_ORDER.includes("deep"));
    assert.equal(listSelectableEqPresets().includes("deep"), false);
    assert.ok(listSelectableEqPresets().includes("flat"));
    assert.ok(listSelectableEqPresets().includes("treble_booster"));
  });
});
