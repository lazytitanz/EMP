"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ArtistProfile = require("./artist-profile.js");

describe("hasArtistProfileData", () => {
  it("detects enrichment fields", () => {
    assert.equal(ArtistProfile.hasArtistProfileData({ name: "A" }), false);
    assert.equal(ArtistProfile.hasArtistProfileData({ name: "A", genres: ["Rock"] }), true);
    assert.equal(ArtistProfile.hasArtistProfileData({ name: "A", musicBrainzId: "x" }), true);
    assert.equal(ArtistProfile.hasArtistProfileData({ name: "A", biography: "Hi" }), true);
    assert.equal(ArtistProfile.hasArtistProfileData({ name: "A", image: { url: "https://artist-art.emp/a.jpg" } }), true);
  });
});

describe("URL safety", () => {
  it("accepts only artist-art.emp image URLs", () => {
    assert.equal(ArtistProfile.isSafeArtistImageUrl("https://artist-art.emp/abc.jpg"), true);
    assert.equal(ArtistProfile.isSafeArtistImageUrl("https://app.emp/artwork/a.jpg"), false);
    assert.equal(ArtistProfile.isSafeArtistImageUrl("https://evil.test/a.jpg"), false);
    assert.equal(ArtistProfile.isSafeArtistImageUrl("javascript:alert(1)"), false);
  });

  it("accepts http(s) links for wikipedia attribution", () => {
    assert.equal(ArtistProfile.isSafeHttpUrl("https://en.wikipedia.org/wiki/Audioslave"), true);
    assert.equal(ArtistProfile.isSafeHttpUrl("ftp://example"), false);
  });
});

describe("biography helpers", () => {
  it("escapes biography paragraphs", () => {
    const html = ArtistProfile.artistBiographyParagraphs("Hello <script> & friends");
    assert.equal(html, "<p>Hello &lt;script&gt; &amp; friends</p>");
  });

  it("collapses long biographies", () => {
    const long = "x".repeat(500);
    const result = ArtistProfile.collapseBiography(long, 420);
    assert.equal(result.needsToggle, true);
    assert.ok(result.shortText.endsWith("…"));
    assert.equal(result.fullText.length, 500);
  });
});

describe("artistMonogram", () => {
  it("builds initials from artist names", () => {
    assert.equal(ArtistProfile.artistMonogram("Julia Wolf"), "JW");
    assert.equal(ArtistProfile.artistMonogram("Cher"), "CH");
    assert.equal(ArtistProfile.artistMonogram(""), "?");
  });
});

describe("shouldApplyArtistInfo", () => {
  it("blocks stale artist updates", () => {
    const match = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    assert.equal(ArtistProfile.shouldApplyArtistInfo(
      { name: "Audioslave" },
      { view: "artist", artist: "Audioslave" },
      "Audioslave",
      match), true);
    assert.equal(ArtistProfile.shouldApplyArtistInfo(
      { name: "Audioslave" },
      { view: "album", artist: "Audioslave" },
      "Audioslave",
      match), false);
    assert.equal(ArtistProfile.shouldApplyArtistInfo(
      { name: "Audioslave" },
      { view: "artist", artist: "Rage Against the Machine" },
      "Rage Against the Machine",
      match), false);
  });
});

describe("humanizeArtistArea", () => {
  it("collapses long hierarchies to first and last parts", () => {
    assert.equal(
      ArtistProfile.humanizeArtistArea("London, Greater London, England, United Kingdom"),
      "London, United Kingdom");
    assert.equal(ArtistProfile.humanizeArtistArea("Los Angeles, United States"), "Los Angeles, United States");
    assert.equal(ArtistProfile.humanizeArtistArea(""), "");
  });
});

describe("artistDateFact", () => {
  it("labels Person birth years as Born", () => {
    assert.deepEqual(
      ArtistProfile.artistDateFact({ artistType: "Person", beginYear: 1987 }),
      { label: "Born", value: "1987" });
  });

  it("labels group start as Formed and ranges as Active", () => {
    assert.deepEqual(
      ArtistProfile.artistDateFact({ artistType: "Group", beginYear: 2016 }),
      { label: "Formed", value: "2016" });
    assert.deepEqual(
      ArtistProfile.artistDateFact({ artistType: "Group", beginYear: 2001, endYear: 2007 }),
      { label: "Active", value: "2001–2007" });
  });

  it("does not invent Formed/Born from a bare year without type", () => {
    assert.equal(ArtistProfile.artistDateFact({ beginYear: 1994 }), null);
    assert.deepEqual(
      ArtistProfile.artistDateFact({ beginYear: 1994, endYear: 2000 }),
      { label: "Active", value: "1994–2000" });
  });
});

describe("artistHeroDescriptor", () => {
  it("uses genre, place, and Formed without inventing band or nationality", () => {
    assert.equal(
      ArtistProfile.artistHeroDescriptor({
        artistType: "Group",
        genres: ["Alternative Metal", "Progressive Metal"],
        area: "London, England, United Kingdom",
        beginYear: 2016
      }),
      "Alternative Metal · London, United Kingdom · Formed 2016");
  });

  it("keeps Born secondary when genre or place exists", () => {
    assert.equal(
      ArtistProfile.artistHeroDescriptor({
        artistType: "Person",
        genres: ["Electropop"],
        area: "Stockholm, Sweden",
        beginYear: 1987
      }),
      "Electropop · Stockholm, Sweden");
  });

  it("omits unsupported labels rather than inventing them", () => {
    assert.equal(ArtistProfile.artistHeroDescriptor({ artistType: "Person" }), "");
    assert.equal(
      ArtistProfile.artistHeroDescriptor({ artistType: "Person", beginYear: 1990 }),
      "Born 1990");
  });
});

describe("artistDetailsFacts", () => {
  it("builds origin, semantic date, and up to two genres", () => {
    assert.deepEqual(
      ArtistProfile.artistDetailsFacts({
        artistType: "Group",
        genres: ["Rock", "Alternative Rock", "Post-Grunge"],
        area: "Los Angeles, California, United States",
        beginYear: 2001,
        endYear: 2007
      }),
      [
        { label: "Origin", value: "Los Angeles, United States" },
        { label: "Active", value: "2001–2007" },
        { label: "Genres", value: "Rock, Alternative Rock" }
      ]);
  });
});

describe("artistAboutLayoutMode", () => {
  it("uses split when biography and details both exist", () => {
    assert.equal(
      ArtistProfile.artistAboutLayoutMode({
        biography: "A band.",
        artistType: "Group",
        beginYear: 2016,
        area: "London, United Kingdom",
        genres: ["Metal"]
      }),
      "split");
  });

  it("uses bio when only biography exists", () => {
    assert.equal(
      ArtistProfile.artistAboutLayoutMode({ biography: "Only a bio." }),
      "bio");
  });

  it("uses facts when only structured metadata exists", () => {
    assert.equal(
      ArtistProfile.artistAboutLayoutMode({
        artistType: "Person",
        genres: ["Electropop"],
        area: "Stockholm, Sweden",
        beginYear: 1987
      }),
      "facts");
  });

  it("uses none when neither biography nor details exist", () => {
    assert.equal(ArtistProfile.artistAboutLayoutMode({ name: "Unknown" }), "none");
    assert.equal(ArtistProfile.artistAboutLayoutMode({ artistType: "Person" }), "none");
  });
});

describe("shouldAcceptArtistInfoReply", () => {
  it("accepts matching requestIds and replies without ids", () => {
    assert.equal(
      ArtistProfile.shouldAcceptArtistInfoReply({ name: "Post Malone", requestId: 3 }, 3),
      true);
    assert.equal(
      ArtistProfile.shouldAcceptArtistInfoReply({ name: "Post Malone" }, 3),
      true);
  });

  it("rejects stale requestIds from older opens/refreshes", () => {
    assert.equal(
      ArtistProfile.shouldAcceptArtistInfoReply({ name: "Post Malone", requestId: 2 }, 3),
      false);
  });
});

describe("shouldScheduleArtistInfoSoftRetry", () => {
  it("schedules only for live transient replies", () => {
    assert.equal(
      ArtistProfile.shouldScheduleArtistInfoSoftRetry({ name: "Post Malone", status: "transient" }),
      true);
    assert.equal(
      ArtistProfile.shouldScheduleArtistInfoSoftRetry(
        { name: "Post Malone", status: "transient" },
        { fromCache: true }),
      false);
    assert.equal(
      ArtistProfile.shouldScheduleArtistInfoSoftRetry({ name: "Post Malone", status: "ok" }),
      false);
  });
});

describe("hero face focal point", () => {
  it("returns null when detection is empty or unreliable", () => {
    assert.equal(ArtistProfile.selectHeroFaceFocalPoint([], 1000, 800), null);
    assert.equal(ArtistProfile.selectHeroFaceFocalPoint(
      [{ x: 10, y: 10, width: 2, height: 2 }],
      1000,
      800), null);
  });

  it("uses an eye-line focal for a single reliable face", () => {
    const focal = ArtistProfile.selectHeroFaceFocalPoint(
      [{ x: 400, y: 100, width: 200, height: 240 }],
      1000,
      800);
    assert.ok(focal);
    assert.ok(Math.abs(focal.x - 0.5) < 0.02);
    // Eye-line ≈ y + 0.33*height → (100 + 79.2) / 800 ≈ 0.224
    assert.ok(focal.y > 0.18 && focal.y < 0.32);
  });

  it("frames group photos on the combined face bounds", () => {
    const subject = ArtistProfile.selectHeroFaceSubject(
      ArtistProfile.normalizeHeroFaceBoxes(
        [
          { x: 100, y: 120, width: 120, height: 140 },
          { x: 700, y: 140, width: 120, height: 140 }
        ],
        1000,
        800));
    assert.ok(subject);
    assert.equal(subject.isGroup, true);
    // Combined bounds center: (100 + 820) / 2 / 1000 = 0.46
    assert.ok(Math.abs(subject.focal.x - 0.46) < 0.05);
    assert.ok(subject.box.width > 0.6);
  });

  it("builds object-position from focal point and leaves null when missing", () => {
    assert.equal(ArtistProfile.heroObjectPositionFromFocalPoint(null, 800, 400, 1000, 800), null);
    const pos = ArtistProfile.heroObjectPositionFromFocalPoint(
      { x: 0.5, y: 0.3 },
      800,
      400,
      1000,
      800);
    assert.match(pos, /^\d+(\.\d+)?% \d+(\.\d+)?%$/);
  });
});

describe("responsive artist hero framing", () => {
  const portraitFace = ArtistProfile.normalizeHeroFaceBoxes(
    [{ x: 420, y: 180, width: 220, height: 280 }],
    1000,
    1400);
  const landscapeFace = ArtistProfile.normalizeHeroFaceBoxes(
    [{ x: 1100, y: 220, width: 260, height: 300 }],
    1800,
    1000);
  const squareFace = ArtistProfile.normalizeHeroFaceBoxes(
    [{ x: 360, y: 280, width: 280, height: 300 }],
    1000,
    1000);
  const groupFaces = ArtistProfile.normalizeHeroFaceBoxes(
    [
      { x: 180, y: 220, width: 140, height: 170 },
      { x: 480, y: 200, width: 150, height: 180 },
      { x: 780, y: 240, width: 140, height: 170 }
    ],
    1200,
    800);

  const sizes = {
    narrow: { width: 720, height: 300 },
    default: { width: 1100, height: 380 },
    maximized: { width: 1680, height: 420 },
    shallowWide: { width: 1600, height: 280 }
  };

  it("normalizes pixel face boxes once into 0-1 space", () => {
    assert.equal(portraitFace.length, 1);
    assert.ok(portraitFace[0].x > 0.3 && portraitFace[0].x < 0.5);
    assert.ok(portraitFace[0].width > 0.15 && portraitFace[0].width < 0.3);
  });

  it("keeps a portrait subject visible from narrow to maximized", () => {
    assert.equal(
      ArtistProfile.subjectVisibleAcrossSizes(
        portraitFace,
        1000,
        1400,
        [sizes.narrow, sizes.default, sizes.maximized],
        0.5),
      true);
  });

  it("biases solo faces toward the right for left-aligned titles", () => {
    const framing = ArtistProfile.computeArtistHeroFraming(
      landscapeFace,
      sizes.default.width,
      sizes.default.height,
      1800,
      1000);
    assert.ok(framing);
    assert.equal(framing.fit, "cover");
    // Right-biased target should pull object-position right of center for a rightish face.
    assert.ok(framing.position.x > 0.45);
  });

  it("keeps landscape and near-square subjects visible across resize", () => {
    assert.equal(
      ArtistProfile.subjectVisibleAcrossSizes(
        landscapeFace,
        1800,
        1000,
        [sizes.narrow, sizes.default, sizes.maximized],
        0.45),
      true);
    assert.equal(
      ArtistProfile.subjectVisibleAcrossSizes(
        squareFace,
        1000,
        1000,
        [sizes.narrow, sizes.default, sizes.maximized],
        0.5),
      true);
  });

  it("frames groups on combined bounds and keeps them visible", () => {
    const subject = ArtistProfile.selectHeroFaceSubject(groupFaces);
    assert.ok(subject?.isGroup);
    assert.ok(subject.box.width > 0.5);
    assert.equal(
      ArtistProfile.subjectVisibleAcrossSizes(
        groupFaces,
        1200,
        800,
        [sizes.narrow, sizes.default, sizes.maximized],
        0.45),
      true);
  });

  it("clamps cover positioning to achievable crop ranges", () => {
    // Use a mid hero height so cover remains viable for a portrait face.
    const framing = ArtistProfile.computeArtistHeroFraming(
      portraitFace,
      1100,
      480,
      1000,
      1400);
    assert.ok(framing);
    assert.equal(framing.fit, "cover");
    assert.ok(framing.position.x >= 0 && framing.position.x <= 1);
    assert.ok(framing.position.y >= 0 && framing.position.y <= 1);
    const visible = ArtistProfile.visibleCoverRect(
      framing.position.x,
      framing.position.y,
      framing.metrics);
    assert.ok(visible.width > 0 && visible.height > 0);
  });

  it("falls back to contain when a maximized shallow hero cannot keep a tall portrait", () => {
    const framing = ArtistProfile.computeArtistHeroFraming(
      portraitFace,
      sizes.maximized.width,
      sizes.maximized.height,
      1000,
      1400);
    assert.ok(framing);
    assert.equal(framing.fit, "contain");
  });

  it("uses contain fallback for genuinely shallow heroes that cannot keep the subject", () => {
    // Tall face box relative to a very shallow cover viewport.
    const tallFace = ArtistProfile.normalizeHeroFaceBoxes(
      [{ x: 300, y: 100, width: 400, height: 900 }],
      1000,
      1400);
    const framing = ArtistProfile.computeArtistHeroFraming(
      tallFace,
      sizes.shallowWide.width,
      sizes.shallowWide.height,
      1000,
      1400);
    assert.ok(framing);
    assert.equal(framing.fit, "contain");
    assert.equal(framing.objectPosition, "50% 42%");
  });

  it("recomputes different object-positions when the hero aspect changes", () => {
    const a = ArtistProfile.computeArtistHeroFraming(
      landscapeFace,
      sizes.narrow.width,
      sizes.narrow.height,
      1800,
      1000);
    const b = ArtistProfile.computeArtistHeroFraming(
      landscapeFace,
      sizes.maximized.width,
      sizes.maximized.height,
      1800,
      1000);
    assert.ok(a && b);
    assert.notEqual(a.objectPosition, b.objectPosition);
  });
});
