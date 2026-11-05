"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Q = require("./queue-model.js");

function freshState(ids = ["a", "b", "c", "d"], startId = "a") {
  const state = {
    entries: [],
    queue: [],
    shuffleBag: [],
    index: -1,
    orderRevision: 0,
    playNextCount: 0,
    queueDirty: false,
    preloadGeneration: 0,
    shuffle: false,
    queueSource: { kind: "album", id: "alb1" }
  };
  Q.replaceQueue(state, ids, startId, { source: state.queueSource });
  return state;
}

describe("queue mutations", () => {
  beforeEach(() => {
    Q.resetUidCounter(0);
  });

  it("play next inserts FIFO after current and ahead of later play-nexts", () => {
    const state = freshState();
    Q.playNextTracks(state, ["x"]);
    Q.playNextTracks(state, ["y"]);
    assert.deepEqual(Q.trackIdsFromEntries(state.entries), ["a", "x", "y", "b", "c", "d"]);
    assert.equal(state.playNextCount, 2);
    assert.equal(state.entries[1].origin, Q.ORIGIN_USER);
    assert.equal(state.queueDirty, true);
    assert.deepEqual(state.queue, Q.trackIdsFromEntries(state.entries));
  });

  it("add to queue appends without affecting play-next block", () => {
    const state = freshState();
    Q.playNextTracks(state, ["x"]);
    Q.addToQueueTracks(state, ["z"]);
    assert.deepEqual(Q.trackIdsFromEntries(state.entries), ["a", "x", "b", "c", "d", "z"]);
    assert.equal(state.playNextCount, 1);
  });

  it("remove only one duplicate occurrence by uid", () => {
    const state = freshState(["a", "b", "a", "c"], "a");
    const secondA = state.entries[2];
    Q.removeEntry(state, secondA.uid);
    assert.deepEqual(Q.trackIdsFromEntries(state.entries), ["a", "b", "c"]);
    assert.equal(state.entries.filter((entry) => entry.trackId === "a").length, 1);
  });

  it("clear upcoming leaves current and blocks resurrection via empty remainder", () => {
    const state = freshState();
    Q.playNextTracks(state, ["x"]);
    const { removed } = Q.clearUpcoming(state);
    assert.deepEqual(Q.trackIdsFromEntries(state.entries), ["a"]);
    assert.equal(removed.length, 4);
    assert.equal(state.playNextCount, 0);
    assert.equal(Q.peekNextTrackId(state, { wrap: false }), null);
  });

  it("move upcoming promotes origin to user", () => {
    const state = freshState();
    const last = state.entries[state.entries.length - 1];
    Q.moveUpcomingEntry(state, last.uid, 0);
    assert.equal(state.entries[1].trackId, "d");
    assert.equal(state.entries[1].origin, Q.ORIGIN_USER);
  });

  it("move upcoming downward lands on the indicated slot", () => {
    const state = freshState(["a", "b", "c", "d", "e"], "a");
    const firstUpcoming = state.entries[1];
    Q.moveUpcomingEntry(state, firstUpcoming.uid, 2);
    assert.deepEqual(Q.trackIdsFromEntries(state.entries), ["a", "c", "d", "b", "e"]);
  });
});

describe("shuffle provenance", () => {
  beforeEach(() => {
    Q.resetUidCounter(0);
  });

  it("preserves user upcoming order and shuffles only source remainder", () => {
    const state = freshState(["a", "b", "c", "d", "e"], "a");
    Q.playNextTracks(state, ["u1", "u2"]);
    Q.setShuffle(state, true, (list) => {
      list.reverse();
      return list;
    });
    assert.deepEqual(Q.trackIdsFromEntries(state.entries), ["a", "u1", "u2", "e", "d", "c", "b"]);
    assert.equal(state.playNextCount, 2);
    assert.ok(state.entries.slice(1, 3).every((entry) => entry.origin === Q.ORIGIN_USER));
  });

  it("disable shuffle keeps the post-shuffle order", () => {
    const state = freshState(["a", "b", "c", "d"], "a");
    Q.setShuffle(state, true, (list) => {
      list.reverse();
      return list;
    });
    const afterEnable = Q.trackIdsFromEntries(state.entries).slice();
    Q.setShuffle(state, false);
    assert.deepEqual(Q.trackIdsFromEntries(state.entries), afterEnable);
    assert.equal(state.shuffle, false);
  });
});

describe("navigation with duplicates and play next", () => {
  beforeEach(() => {
    Q.resetUidCounter(0);
  });

  it("steps next/previous by index through duplicate track ids", () => {
    const state = freshState(["a", "b", "a"], "a");
    const first = Q.stepNextIndex(state);
    assert.equal(first.entry.trackId, "b");
    const second = Q.stepNextIndex(state);
    assert.equal(second.entry.trackId, "a");
    assert.notEqual(second.entry.uid, state.entries[0].uid);
    const prev = Q.stepPreviousIndex(state);
    assert.equal(prev.entry.trackId, "b");
  });

  it("advanceToTrackId prefers the immediate next duplicate", () => {
    const state = freshState(["x", "y", "y"], "x");
    assert.equal(Q.advanceToTrackId(state, "y"), true);
    assert.equal(state.index, 1);
    assert.equal(Q.advanceToTrackId(state, "y"), true);
    assert.equal(state.index, 2);
  });

  it("consumes play-next count when stepping forward", () => {
    const state = freshState();
    Q.playNextTracks(state, ["x", "y"]);
    assert.equal(state.playNextCount, 2);
    Q.stepNextIndex(state);
    assert.equal(state.playNextCount, 1);
    assert.equal(state.entries[state.index].trackId, "x");
  });
});

describe("session persistence", () => {
  beforeEach(() => {
    Q.resetUidCounter(0);
  });

  it("round-trips entries, duplicates, dirty flag, and play-next count", () => {
    const state = freshState(["a", "b", "a", "c"], "a");
    Q.playNextTracks(state, ["z"]);
    Q.moveUpcomingEntry(state, state.entries[4].uid, 1);
    const payload = Q.serializeQueueSession(state);

    const restored = {
      entries: [],
      queue: [],
      shuffleBag: [],
      index: -1,
      orderRevision: 0,
      playNextCount: 0,
      queueDirty: false,
      preloadGeneration: 0,
      shuffle: false,
      queueSource: null
    };
    Q.restoreQueueSession(restored, { ...payload, trackId: "a" }, { trackExists: () => true });
    assert.deepEqual(Q.trackIdsFromEntries(restored.entries), Q.trackIdsFromEntries(state.entries));
    assert.equal(restored.entries[1].origin, Q.ORIGIN_USER);
    assert.equal(restored.queueDirty, true);
    assert.equal(restored.index, 0);
    assert.ok(restored.entries.every((entry) => entry.uid));
  });

  it("refuses compact session when user modifications exist", () => {
    const state = freshState(["a", "b", "c"], "a");
    state.queueSource = { kind: "library" };
    assert.equal(Q.canCompactSessionQueue(state, { queueMatchesFullLibrary: () => true }), true);
    Q.playNextTracks(state, ["x"]);
    assert.equal(Q.canCompactSessionQueue(state, { queueMatchesFullLibrary: () => true }), false);
    Q.clearUpcoming(state);
    assert.equal(Q.canCompactSessionQueue(state, { queueMatchesFullLibrary: () => true }), false);
  });
});

describe("stale Sonora preload plans", () => {
  beforeEach(() => {
    Q.resetUidCounter(0);
  });

  it("bumps generation so older preload plans are rejected", () => {
    const state = freshState();
    const first = Q.planNextPreload(state, { wrap: false, shouldPreload: true });
    assert.equal(first.action, "preload");
    assert.equal(first.nextTrackId, "b");
    assert.equal(Q.isPreloadPlanCurrent(state, first.generation), true);

    Q.playNextTracks(state, ["x"]);
    const second = Q.planNextPreload(state, { wrap: false, shouldPreload: true });
    assert.equal(second.nextTrackId, "x");
    assert.equal(Q.isPreloadPlanCurrent(state, first.generation), false);
    assert.equal(Q.isPreloadPlanCurrent(state, second.generation), true);
  });

  it("plans clear when repeat-one or no successor", () => {
    const state = freshState(["a"], "a");
    const plan = Q.planNextPreload(state, { wrap: false, shouldPreload: true });
    assert.equal(plan.action, "clear");
    assert.equal(plan.nextTrackId, null);

    const multi = freshState();
    const repeatOne = Q.planNextPreload(multi, { wrap: true, repeatOne: true, shouldPreload: true });
    assert.equal(repeatOne.action, "clear");
  });
});
