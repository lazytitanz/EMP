"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  localDateKey,
  nextLocalMidnightMs,
  splitListenMsByLocalDate
} = require("./listen-date-split.js");

function sumBuckets(buckets) {
  return Object.values(buckets).reduce((a, b) => a + b, 0);
}

describe("splitListenMsByLocalDate", () => {
  it("returns empty for non-positive mono delta", () => {
    assert.deepEqual(splitListenMsByLocalDate(0, 1_000, 900), {});
    assert.deepEqual(splitListenMsByLocalDate(-5, 1_000, 900), {});
  });

  it("same-day continuous tick keeps mono magnitude on one day", () => {
    const end = new Date(2026, 5, 15, 15, 0, 0, 400).getTime();
    const prev = end - 400;
    const buckets = splitListenMsByLocalDate(400, end, prev);
    assert.equal(sumBuckets(buckets), 400);
    assert.equal(Object.keys(buckets).length, 1);
    assert.equal(buckets[localDateKey(end)], 400);
  });

  it("splits across local midnight using wall checkpoints", () => {
    const midnight = nextLocalMidnightMs(new Date(2026, 5, 15, 12, 0, 0).getTime());
    const prev = midnight - 150;
    const end = midnight + 250;
    const mono = 400;
    const buckets = splitListenMsByLocalDate(mono, end, prev);
    assert.equal(sumBuckets(buckets), mono);
    const dayA = localDateKey(prev);
    const dayB = localDateKey(end);
    assert.notEqual(dayA, dayB);
    assert.ok(buckets[dayA] > 0);
    assert.ok(buckets[dayB] > 0);
    assert.equal(buckets[dayA], 150);
    assert.equal(buckets[dayB], 250);
  });

  it("backward wall checkpoint attributes all mono to end date", () => {
    const end = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const prev = end + 60_000;
    const buckets = splitListenMsByLocalDate(400, end, prev);
    assert.deepEqual(buckets, { [localDateKey(end)]: 400 });
  });

  it("missing previous checkpoint attributes all mono to end date", () => {
    const end = new Date(2026, 5, 15, 10, 0, 0).getTime();
    const buckets = splitListenMsByLocalDate(400, end, 0);
    assert.deepEqual(buckets, { [localDateKey(end)]: 400 });
  });

  it("forward wall discontinuity does not inflate mono duration", () => {
    const end = new Date(2026, 5, 16, 10, 0, 0).getTime();
    const prev = end - 3_600_000;
    const mono = 400;
    const buckets = splitListenMsByLocalDate(mono, end, prev);
    assert.equal(sumBuckets(buckets), mono);
    assert.deepEqual(buckets, { [localDateKey(end)]: mono });
  });

  it("never produces negative bucket values", () => {
    const midnight = nextLocalMidnightMs(new Date(2026, 0, 1, 12, 0, 0).getTime());
    const prev = midnight - 1;
    const end = midnight + 1;
    const buckets = splitListenMsByLocalDate(3, end, prev);
    assert.equal(sumBuckets(buckets), 3);
    for (const value of Object.values(buckets)) {
      assert.ok(value >= 0);
    }
  });
});
