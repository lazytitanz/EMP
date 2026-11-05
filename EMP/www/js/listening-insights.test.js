"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const insights = require("./listening-insights.js");

describe("listening insights helpers", () => {
  it("formats listen time for summary copy", () => {
    assert.equal(insights.formatListenTime(0).detail, "0 min");
    assert.equal(insights.formatListenTime(0).display, "0m");
    assert.equal(insights.formatListenTime(90 * 60_000).detail, "1 hr 30 min");
    assert.equal(insights.formatListenTime(90 * 60_000).display, "1h 30m");
    assert.equal(insights.formatListenTime(120 * 60_000).primary, "2");
    assert.equal(insights.formatListenTime(120 * 60_000).display, "2h");
    assert.equal(insights.formatCompactDuration(566 * 60_000), "9h 26m");
  });

  it("ignores stale request ids and inactive section", () => {
    insights.clearActiveRequests();
    const first = insights.requestInsights("last30");
    const latest = insights.requestInsights("all");
    assert.notEqual(first, latest);

    assert.equal(
      insights.applyInsightsPayload(
        { requestId: first, range: "last30", totalListenMs: 1 },
        { settingsOpen: true, settingsSection: "listeningInsights" }
      ),
      false
    );

    assert.equal(
      insights.applyInsightsPayload(
        { requestId: latest, range: "all", totalListenMs: 5 },
        { settingsOpen: true, settingsSection: "general" }
      ),
      false
    );

    assert.equal(
      insights.applyInsightsPayload(
        {
          requestId: latest,
          range: "all",
          showGenericEmpty: false,
          totalListenMs: 5,
          totalPlays: 1,
          uniqueTracks: 1,
          uniqueArtists: 0,
          artistRankingCoverage: "unavailable",
          topTracks: [],
          topArtists: [],
          activity: [],
          habits: [],
          hasLifetimeData: true,
          hasDailyData: false
        },
        { settingsOpen: true, settingsSection: "listeningInsights" }
      ),
      true
    );
    assert.equal(insights.getActivePayload().totalListenMs, 5);
  });

  it("builds playable queues from in-library tracks only", () => {
    const payload = {
      topTracks: [
        { trackId: "a", inLibrary: true },
        { trackId: "b", inLibrary: false },
        { trackId: "c", inLibrary: true },
        { trackId: "missing", inLibrary: true }
      ]
    };
    const library = {
      a: { id: "a" },
      c: { id: "c" }
    };
    assert.deepEqual(
      insights.playableQueue(payload, (id) => library[id] || null),
      ["a", "c"]
    );
  });
});
