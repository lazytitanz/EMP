const test = require("node:test");
const assert = require("node:assert/strict");
const {
  affectsTransport,
  isStale,
  sanitizeMessage,
  titleFor,
  OPERATIONS
} = require("./sonora-playback-errors.js");

test("affectsTransport: load/play/seek stop UI transport; preload/device do not", () => {
  assert.equal(affectsTransport(OPERATIONS.load), true);
  assert.equal(affectsTransport(OPERATIONS.play), true);
  assert.equal(affectsTransport(OPERATIONS.seek), true);
  assert.equal(affectsTransport(""), true);
  assert.equal(affectsTransport(OPERATIONS.preload), false);
  assert.equal(affectsTransport(OPERATIONS.outputDevice), false);
});

test("isStale: ignores older generations only", () => {
  assert.equal(isStale(3, 5), true);
  assert.equal(isStale(5, 5), false);
  assert.equal(isStale(6, 5), false);
  assert.equal(isStale(0, 5), false);
});

test("sanitizeMessage: strips Windows and UNC paths", () => {
  const raw = "The audio source 'C:\\Music\\Flyleaf\\sick.m4a' could not be opened.";
  const cleaned = sanitizeMessage(raw);
  assert.equal(cleaned.includes("C:\\"), false);
  assert.equal(cleaned.includes("Flyleaf"), false);
  assert.match(cleaned.toLowerCase(), /could not be opened|source/);

  assert.equal(sanitizeMessage("\\\\server\\share\\track.mp3 failed").includes("\\\\server"), false);
});

test("titleFor: preload vs load wording", () => {
  assert.equal(titleFor(OPERATIONS.preload), "Couldn't prepare next track");
  assert.equal(titleFor(OPERATIONS.load), "Couldn't play track");
});
