const EQ_MIN_DB = -12;
const EQ_MAX_DB = 12;
const EQ_GAIN_MATCH_EPSILON = 0.051;
const EQ_FLAT_GAINS = Object.freeze([0, 0, 0, 0, 0, 0]);

const EQ_BANDS = Object.freeze([
  Object.freeze({ id: "60", hz: 60, label: "60Hz", type: "lowshelf", q: 1 }),
  Object.freeze({ id: "150", hz: 150, label: "150Hz", type: "peaking", q: 1 }),
  Object.freeze({ id: "400", hz: 400, label: "400Hz", type: "peaking", q: 1 }),
  Object.freeze({ id: "1k", hz: 1000, label: "1KHz", type: "peaking", q: 1 }),
  Object.freeze({ id: "2k4", hz: 2400, label: "2.4KHz", type: "peaking", q: 1 }),
  Object.freeze({ id: "15k", hz: 15000, label: "15KHz", type: "highshelf", q: 1 })
]);

// Built-in gains from PianoNic/SpotifyEqExport PRESETS, extracted from the
// Spotify desktop client (60 Hz lowshelf, four peaking bands, 15 kHz highshelf).
// Deep appears in the Spotify UI list but is not in that dump (the dump has
// treble_booster / treble_reducer / vocal_booster instead). No equally reliable
// source was found, so Deep is listed as unavailable and has no gain array.
const EQ_PRESETS = Object.freeze({
  flat: Object.freeze({ id: "flat", name: "Flat", gains: Object.freeze([0, 0, 0, 0, 0, 0]) }),
  acoustic: Object.freeze({ id: "acoustic", name: "Acoustic", gains: Object.freeze([4.9, 3.95, 2.15, 1.75, 3.5, 2.15]) }),
  bass_booster: Object.freeze({ id: "bass_booster", name: "Bass booster", gains: Object.freeze([4.25, 3.5, 1.25, 0, 0, 0]) }),
  bass_reducer: Object.freeze({ id: "bass_reducer", name: "Bass reducer", gains: Object.freeze([-4.25, -3.5, -1.25, 0, 0, 0]) }),
  classical: Object.freeze({ id: "classical", name: "Classical", gains: Object.freeze([3.75, 3, -1.5, -1.5, 0, 3.75]) }),
  dance: Object.freeze({ id: "dance", name: "Dance", gains: Object.freeze([6.55, 4.99, 1.92, 3.65, 5.15, 0]) }),
  deep: Object.freeze({ id: "deep", name: "Deep", available: false }),
  electronic: Object.freeze({ id: "electronic", name: "Electronic", gains: Object.freeze([3.8, 1.2, -2.15, 2.25, 0.85, 4.8]) }),
  hiphop: Object.freeze({ id: "hiphop", name: "HipHop", gains: Object.freeze([4.25, 1.5, -1, -1, 1.5, 3]) }),
  jazz: Object.freeze({ id: "jazz", name: "Jazz", gains: Object.freeze([3, 1.5, -1.5, -1.5, 0, 3.75]) }),
  latin: Object.freeze({ id: "latin", name: "Latin", gains: Object.freeze([3, 0, -1.5, -1.5, -1.5, 4.5]) }),
  loudness: Object.freeze({ id: "loudness", name: "Loudness", gains: Object.freeze([4, 0, -2, 0, -1, 1]) }),
  lounge: Object.freeze({ id: "lounge", name: "Lounge", gains: Object.freeze([-1.5, -0.5, 4, 2.5, 0, 1]) }),
  piano: Object.freeze({ id: "piano", name: "Piano", gains: Object.freeze([2, 0, 3, 1.5, 3.5, 3.5]) }),
  pop: Object.freeze({ id: "pop", name: "Pop", gains: Object.freeze([-1, 0, 4, 4, 2, -1.5]) }),
  rnb: Object.freeze({ id: "rnb", name: "RnB", gains: Object.freeze([6.92, 5.65, -2.19, -1.5, 2.32, 3.75]) }),
  rock: Object.freeze({ id: "rock", name: "Rock", gains: Object.freeze([4, 3, -0.5, -1, 0.5, 4.5]) }),
  small_speakers: Object.freeze({ id: "small_speakers", name: "Small speakers", gains: Object.freeze([4.25, 3.5, 1.25, 0, -1.25, -4.25]) }),
  spoken_word: Object.freeze({ id: "spoken_word", name: "Spoken word", gains: Object.freeze([-0.47, 0, 3.46, 4.61, 4.84, 0]) }),
  treble_booster: Object.freeze({ id: "treble_booster", name: "Treble booster", gains: Object.freeze([0, 0, 0, 1.25, 2.5, 5.5]) }),
  treble_reducer: Object.freeze({ id: "treble_reducer", name: "Treble reducer", gains: Object.freeze([0, 0, 0, -1.25, -2.5, -5.5]) }),
  manual: Object.freeze({ id: "manual", name: "Manual" })
});

const EQ_PRESET_ORDER = Object.freeze([
  "flat",
  "acoustic",
  "bass_booster",
  "bass_reducer",
  "classical",
  "dance",
  "deep",
  "electronic",
  "hiphop",
  "jazz",
  "latin",
  "loudness",
  "lounge",
  "piano",
  "pop",
  "rnb",
  "rock",
  "small_speakers",
  "spoken_word",
  "treble_booster",
  "treble_reducer"
]);

function cloneEqGains(gains) {
  return [gains[0], gains[1], gains[2], gains[3], gains[4], gains[5]];
}

function eqGainsAreFlat(gains) {
  return eqGainsMatch(gains, EQ_FLAT_GAINS);
}

function eqGainsMatch(left, right) {
  if (!left || !right || left.length !== 6 || right.length !== 6) {
    return false;
  }
  for (let i = 0; i < 6; i += 1) {
    if (Math.abs(left[i] - right[i]) > EQ_GAIN_MATCH_EPSILON) {
      return false;
    }
  }
  return true;
}

function isEqPresetAvailable(id) {
  const preset = EQ_PRESETS[id];
  return Boolean(preset && preset.available !== false && Array.isArray(preset.gains) && preset.gains.length === 6);
}

function sanitizeEqGains(value) {
  if (!Array.isArray(value) || value.length !== 6) {
    return cloneEqGains(EQ_FLAT_GAINS);
  }

  const gains = [];
  for (let i = 0; i < 6; i += 1) {
    const number = typeof value[i] === "number" ? value[i] : Number(value[i]);
    if (!Number.isFinite(number)) {
      return cloneEqGains(EQ_FLAT_GAINS);
    }
    gains.push(Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, number)));
  }
  return gains;
}

function matchEqPresetId(gains) {
  for (const id of EQ_PRESET_ORDER) {
    if (!isEqPresetAvailable(id)) {
      continue;
    }
    if (eqGainsMatch(gains, EQ_PRESETS[id].gains)) {
      return id;
    }
  }
  return eqGainsAreFlat(gains) ? "flat" : "manual";
}

function resolveEqPresetId(id, gains) {
  if (id === "manual") {
    return eqGainsAreFlat(gains) ? "flat" : "manual";
  }
  if (isEqPresetAvailable(id) && eqGainsMatch(gains, EQ_PRESETS[id].gains)) {
    return id;
  }
  return eqGainsAreFlat(gains) ? "flat" : "manual";
}

function eqPresetLabel(id) {
  return EQ_PRESETS[id]?.name ?? "Manual";
}
