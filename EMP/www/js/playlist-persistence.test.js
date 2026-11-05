"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const P = require("./playlist-persistence.js");

describe("playlistPersistenceScore", () => {
  it("scores playlist count and tracks", () => {
    assert.equal(P.playlistPersistenceScore([]), 0);
    assert.equal(P.playlistPersistenceScore([{ trackIds: ["a", "b"] }]), 1002);
    assert.equal(P.playlistPersistenceScore([{ trackIds: [] }, { trackIds: ["x"] }]), 2001);
  });
});

describe("normalizeHostBackup", () => {
  it("accepts legacy arrays and revision objects", () => {
    assert.deepEqual(P.normalizeHostBackup([{ id: "p1" }]), {
      revision: 1,
      playlists: [{ id: "p1" }]
    });
    assert.deepEqual(P.normalizeHostBackup({ revision: 4, playlists: [{ id: "p2" }] }), {
      revision: 4,
      playlists: [{ id: "p2" }]
    });
    assert.deepEqual(P.normalizeHostBackup(null), { revision: 0, playlists: [] });
  });
});

describe("chooseAuthoritativePlaylists", () => {
  it("prefers higher revision even when poorer", () => {
    const chosen = P.chooseAuthoritativePlaylists({
      memoryPlaylists: [{ id: "pl_liked", trackIds: ["only"] }],
      memoryRevision: 5,
      storedPlaylists: [{ id: "pl_liked", trackIds: ["a", "b", "c"] }, { id: "mix", trackIds: ["x"] }],
      storedRevision: 2,
      hostPlaylists: [{ id: "pl_liked", trackIds: ["a", "b", "c"] }, { id: "mix", trackIds: ["x"] }],
      hostRevision: 2
    });
    assert.equal(chosen.revision, 5);
    assert.equal(chosen.source, "memory");
    assert.equal(chosen.playlists[0].trackIds.length, 1);
  });

  it("falls back to score when all revisions are zero", () => {
    const chosen = P.chooseAuthoritativePlaylists({
      memoryPlaylists: [],
      memoryRevision: 0,
      storedPlaylists: [{ id: "pl_liked", trackIds: ["a"] }],
      storedRevision: 0,
      hostPlaylists: [{ id: "pl_liked", trackIds: ["a", "b"] }, { id: "mix", trackIds: [] }],
      hostRevision: 0
    });
    assert.equal(chosen.source, "host");
    assert.equal(chosen.playlists.length, 2);
  });
});

describe("protectPlaylistsForSessionWrite", () => {
  it("blocks cold empty writes when durable data exists", () => {
    const protectedPlaylists = P.protectPlaylistsForSessionWrite({
      outgoingPlaylists: [],
      storedPlaylists: [{ id: "mix", trackIds: ["a"] }],
      hostPlaylists: [],
      playlistsHydrated: false,
      allowPlaylistCommit: false
    });
    assert.equal(protectedPlaylists.length, 1);
  });

  it("allows intentional playlist commits to shrink", () => {
    const protectedPlaylists = P.protectPlaylistsForSessionWrite({
      outgoingPlaylists: [{ id: "pl_liked", trackIds: ["only"] }],
      storedPlaylists: [{ id: "pl_liked", trackIds: ["a", "b", "c"] }, { id: "mix", trackIds: ["x"] }],
      hostPlaylists: [{ id: "pl_liked", trackIds: ["a", "b", "c"] }, { id: "mix", trackIds: ["x"] }],
      playlistsHydrated: true,
      allowPlaylistCommit: true
    });
    assert.equal(protectedPlaylists.length, 1);
    assert.deepEqual(protectedPlaylists[0].trackIds, ["only"]);
  });

  it("blocks accidental empty wipe after hydration", () => {
    const protectedPlaylists = P.protectPlaylistsForSessionWrite({
      outgoingPlaylists: [],
      storedPlaylists: [{ id: "mix", trackIds: ["a"] }],
      hostPlaylists: [],
      playlistsHydrated: true,
      allowPlaylistCommit: false
    });
    assert.equal(protectedPlaylists[0].id, "mix");
  });
});
