"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  SECTIONS,
  SECTION_META,
  DEFAULT_SECTION,
  normalizeSettingsSection,
  shouldPushSettingsHistory,
  settingsHistoryEntry
} = require("./settings-overlay.js");

describe("settings overlay nav", () => {
  it("exposes the reference nav groups and ids", () => {
    const ids = SECTIONS.flatMap((group) => group.items.map((item) => item.id));
    assert.deepEqual(ids, [
      "general",
      "library",
      "appearance",
      "playback",
      "audio",
      "equalizer",
      "personalization",
      "listeningInsights",
      "storage",
      "updates",
      "about"
    ]);
    assert.equal(DEFAULT_SECTION, "general");
    assert.equal(SECTION_META.playback.title, "Playback");
    assert.equal(SECTION_META.appearance.title, "Appearance");
    assert.equal(SECTION_META.appearance.description, "Customize how EMP looks and feels.");
  });

  it("normalizes unknown sections to the default", () => {
    assert.equal(normalizeSettingsSection("audio"), "audio");
    assert.equal(normalizeSettingsSection("nope"), "general");
  });

  it("prevents duplicate settings history pushes", () => {
    assert.equal(shouldPushSettingsHistory({ view: "home" }), true);
    assert.equal(shouldPushSettingsHistory({ view: "settings", section: "general" }), false);
    assert.equal(shouldPushSettingsHistory(null), true);
  });

  it("builds a settings history entry with a normalized section", () => {
    assert.deepEqual(settingsHistoryEntry("equalizer"), { view: "settings", section: "equalizer" });
    assert.deepEqual(settingsHistoryEntry("missing"), { view: "settings", section: "general" });
  });
});
