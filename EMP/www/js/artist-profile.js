/**
 * Artist profile helpers — dual export for node:test and browser.
 * Keeps Artist-page enrichment logic testable without the full player DOM.
 */
(function (global) {
  "use strict";

  const ARTIST_BIO_COLLAPSE_CHARS = 420;
  const ARTIST_IMAGE_HOST = "artist-art.emp";

  function hasArtistProfileData(info) {
    const genres = Array.isArray(info?.genres) ? info.genres.filter(Boolean) : [];
    return genres.length > 0
      || Boolean(info?.beginYear)
      || Boolean(info?.area)
      || Boolean(info?.artistType)
      || Boolean(info?.biography)
      || Boolean(info?.image?.url)
      || Boolean(info?.musicBrainzId);
  }

  function isSafeHttpUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
      return false;
    }
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }

  function isSafeArtistImageUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
      return false;
    }
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === ARTIST_IMAGE_HOST;
    } catch {
      return false;
    }
  }

  function artistBiographyParagraphs(text, escapeHtml) {
    const escape = typeof escapeHtml === "function"
      ? escapeHtml
      : (value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    return String(text || "")
      .split(/\n+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => `<p>${escape(part)}</p>`)
      .join("");
  }

  function collapseBiography(text, limit = ARTIST_BIO_COLLAPSE_CHARS) {
    const fullText = String(text || "").trim();
    if (fullText.length <= limit) {
      return { fullText, shortText: fullText, needsToggle: false };
    }
    return {
      fullText,
      shortText: `${fullText.slice(0, limit).trim()}…`,
      needsToggle: true
    };
  }

  function artistMonogram(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      return "?";
    }
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return `${parts[0][0] || ""}${parts[parts.length - 1][0] || ""}`.toUpperCase();
  }

  function shouldApplyArtistInfo(info, state, pendingName, artistsMatch) {
    if (!info?.name || typeof info.name !== "string") {
      return false;
    }
    if (!state || state.view !== "artist") {
      return false;
    }
    if (typeof artistsMatch === "function") {
      if (!artistsMatch(info.name, state.artist)) {
        return false;
      }
      if (pendingName && !artistsMatch(info.name, pendingName)) {
        return false;
      }
      return true;
    }
    return String(info.name).toLowerCase() === String(state.artist || "").toLowerCase();
  }

  function areaParts(area) {
    return String(area || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  /** Collapse long MusicBrainz hierarchies to a concise place label (not a nationality). */
  function humanizeArtistArea(area) {
    const parts = areaParts(area);
    if (!parts.length) {
      return "";
    }
    if (parts.length >= 3) {
      return `${parts[0]}, ${parts[parts.length - 1]}`;
    }
    return parts.join(", ");
  }

  function primaryArtistGenres(info, limit = 2) {
    const genres = Array.isArray(info?.genres) ? info.genres.filter(Boolean) : [];
    return genres.slice(0, Math.max(0, limit));
  }

  function isPersonArtist(info) {
    return /^person$/i.test(String(info?.artistType || "").trim());
  }

  function isGroupLikeArtist(info) {
    return /^(group|orchestra|choir|ensemble)$/i.test(String(info?.artistType || "").trim());
  }

  /**
   * Semantic date fact from verified type + years.
   * Born = individual birth; Formed = group start; Active = group start–end.
   * Returns null when a year alone is not enough to label safely.
   */
  function artistDateFact(info) {
    const begin = info?.beginYear != null && String(info.beginYear).trim()
      ? String(info.beginYear).trim()
      : "";
    if (!begin) {
      return null;
    }
    const end = info?.endYear != null && String(info.endYear).trim()
      ? String(info.endYear).trim()
      : "";

    if (isPersonArtist(info)) {
      return { label: "Born", value: begin };
    }
    if (isGroupLikeArtist(info)) {
      if (end) {
        return { label: "Active", value: `${begin}–${end}` };
      }
      return { label: "Formed", value: begin };
    }

    // Unknown entity type: only emit Active when both bounds exist.
    if (end) {
      return { label: "Active", value: `${begin}–${end}` };
    }
    return null;
  }

  /**
   * Concise hero line from verified genre / place / formation only.
   * Never invents occupations or nationalities from MusicBrainz types/areas.
   */
  function artistHeroDescriptor(info) {
    const clauses = [];
    const genres = primaryArtistGenres(info, 1);
    if (genres[0]) {
      clauses.push(genres[0]);
    }

    const place = humanizeArtistArea(info?.area);
    if (place) {
      clauses.push(place);
    }

    const date = artistDateFact(info);
    if (date) {
      // Birth dates stay secondary when other verified clauses exist.
      if (!(date.label === "Born" && clauses.length > 0)) {
        clauses.push(`${date.label} ${date.value}`);
      }
    }

    return clauses.join(" · ");
  }

  function artistDetailsFacts(info) {
    const facts = [];
    const place = humanizeArtistArea(info?.area);
    if (place) {
      facts.push({ label: "Origin", value: place });
    }

    const date = artistDateFact(info);
    if (date) {
      facts.push({ label: date.label, value: date.value });
    }

    const genres = primaryArtistGenres(info, 2);
    if (genres.length) {
      facts.push({ label: "Genres", value: genres.join(", ") });
    }

    return facts;
  }

  /**
   * Content-aware About section mode.
   * - split: biography + details
   * - bio: biography only
   * - facts: details only (compact strip, no About heading)
   * - none: omit section
   */
  function artistAboutLayoutMode(info) {
    const hasBio = Boolean(typeof info?.biography === "string" && info.biography.trim());
    const hasDetails = artistDetailsFacts(info).length > 0;
    if (hasBio && hasDetails) {
      return "split";
    }
    if (hasBio) {
      return "bio";
    }
    if (hasDetails) {
      return "facts";
    }
    return "none";
  }

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  /**
   * Normalize FaceDetector (or plain) boxes into 0–1 image space.
   * Pixel boxes are accepted; already-normalized boxes pass through.
   */
  function normalizeHeroFaceBoxes(faces, imageWidth, imageHeight) {
    const iw = Number(imageWidth) || 0;
    const ih = Number(imageHeight) || 0;
    if (!Array.isArray(faces) || faces.length === 0 || iw < 32 || ih < 32) {
      return [];
    }

    const out = [];
    for (const face of faces) {
      const box = face?.boundingBox || face;
      let x = Number(box?.x);
      let y = Number(box?.y);
      let width = Number(box?.width);
      let height = Number(box?.height);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        continue;
      }

      const looksNormalized = x <= 1.5 && y <= 1.5 && width <= 1.5 && height <= 1.5
        && x + width <= 1.6 && y + height <= 1.6;
      if (!looksNormalized) {
        x /= iw;
        y /= ih;
        width /= iw;
        height /= ih;
      }

      x = clamp01(x);
      y = clamp01(y);
      width = Math.min(width, 1 - x);
      height = Math.min(height, 1 - y);
      if (width <= 0 || height <= 0) {
        continue;
      }

      // Ignore tiny / noisy detections (under ~0.15% of the frame).
      if (width * height < 0.0015) {
        continue;
      }
      if (width * height > 0.85 && faces.length === 1) {
        continue;
      }

      out.push({ x, y, width, height, area: width * height });
    }

    return out;
  }

  /**
   * Subject region for framing: combined bounds for groups, eye-line focal point.
   * Coordinates are 0–1 in image space.
   */
  function selectHeroFaceSubject(normalizedFaces) {
    if (!Array.isArray(normalizedFaces) || normalizedFaces.length === 0) {
      return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let sumX = 0;
    let sumY = 0;
    let weight = 0;
    for (const face of normalizedFaces) {
      const w = Math.sqrt(face.area || face.width * face.height);
      const cx = face.x + face.width / 2;
      // Eye-line sits in the upper third of a typical face box.
      const eyeY = face.y + face.height * 0.33;
      sumX += cx * w;
      sumY += eyeY * w;
      weight += w;
      minX = Math.min(minX, face.x);
      minY = Math.min(minY, face.y);
      maxX = Math.max(maxX, face.x + face.width);
      maxY = Math.max(maxY, face.y + face.height);
    }

    if (!(weight > 0) || ![minX, minY, maxX, maxY].every(Number.isFinite)) {
      return null;
    }

    const isGroup = normalizedFaces.length > 1;
    const box = {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY)
    };

    let fx;
    let fy;
    if (isGroup) {
      fx = box.x + box.width / 2;
      fy = box.y + box.height * 0.33;
    } else {
      fx = sumX / weight;
      fy = sumY / weight;
    }

    return {
      box,
      focal: { x: clamp01(fx), y: clamp01(fy) },
      isGroup
    };
  }

  /**
   * Legacy focal helper — accepts pixel or normalized face boxes.
   */
  function selectHeroFaceFocalPoint(faces, imageWidth, imageHeight) {
    const normalized = normalizeHeroFaceBoxes(faces, imageWidth, imageHeight);
    const subject = selectHeroFaceSubject(normalized);
    return subject ? subject.focal : null;
  }

  /** object-fit:cover metrics for a replaced image filling the container. */
  function coverCropMetrics(containerWidth, containerHeight, imageWidth, imageHeight) {
    const cw = Number(containerWidth) || 0;
    const ch = Number(containerHeight) || 0;
    const iw = Number(imageWidth) || 0;
    const ih = Number(imageHeight) || 0;
    if (cw < 1 || ch < 1 || iw < 1 || ih < 1) {
      return null;
    }
    const scale = Math.max(cw / iw, ch / ih);
    const renderedW = iw * scale;
    const renderedH = ih * scale;
    const overflowX = Math.max(0, renderedW - cw);
    const overflowY = Math.max(0, renderedH - ch);
    return {
      cw,
      ch,
      iw,
      ih,
      scale,
      renderedW,
      renderedH,
      overflowX,
      overflowY,
      visibleW: cw / renderedW,
      visibleH: ch / renderedH
    };
  }

  /** Visible image rect (0–1) for a cover crop at object-position (ox, oy) in 0–1. */
  function visibleCoverRect(ox, oy, metrics) {
    const left = metrics.overflowX > 0 ? (clamp01(ox) * metrics.overflowX) / metrics.renderedW : 0;
    const top = metrics.overflowY > 0 ? (clamp01(oy) * metrics.overflowY) / metrics.renderedH : 0;
    return {
      x: left,
      y: top,
      width: metrics.visibleW,
      height: metrics.visibleH
    };
  }

  function rectsIntersectEnough(subject, visible, minOverlap = 0.55) {
    const x1 = Math.max(subject.x, visible.x);
    const y1 = Math.max(subject.y, visible.y);
    const x2 = Math.min(subject.x + subject.width, visible.x + visible.width);
    const y2 = Math.min(subject.y + subject.height, visible.y + visible.height);
    const overlapW = Math.max(0, x2 - x1);
    const overlapH = Math.max(0, y2 - y1);
    const overlap = overlapW * overlapH;
    const subjectArea = Math.max(1e-9, subject.width * subject.height);
    return overlap / subjectArea >= minOverlap;
  }

  /**
   * Shift cover object-position so the subject stays inside the visible crop.
   * When the subject is larger than the viewport on an axis, center on that axis.
   */
  function keepSubjectVisibleInCover(ox, oy, subjectBox, metrics) {
    let nextX = clamp01(ox);
    let nextY = clamp01(oy);
    const pad = 0.02;

    if (metrics.overflowX > 0) {
      if (subjectBox.width <= metrics.visibleW) {
        let left = (nextX * metrics.overflowX) / metrics.renderedW;
        const subjectLeft = subjectBox.x;
        const subjectRight = subjectBox.x + subjectBox.width;
        if (subjectLeft < left + pad) {
          left = Math.max(0, subjectLeft - pad);
        }
        if (subjectRight > left + metrics.visibleW - pad) {
          left = Math.min(1 - metrics.visibleW, subjectRight + pad - metrics.visibleW);
        }
        nextX = (left * metrics.renderedW) / metrics.overflowX;
      } else {
        const left = clamp01(subjectBox.x + subjectBox.width / 2 - metrics.visibleW / 2);
        nextX = (left * metrics.renderedW) / metrics.overflowX;
      }
    }

    if (metrics.overflowY > 0) {
      if (subjectBox.height <= metrics.visibleH) {
        let top = (nextY * metrics.overflowY) / metrics.renderedH;
        const subjectTop = subjectBox.y;
        const subjectBottom = subjectBox.y + subjectBox.height;
        if (subjectTop < top + pad) {
          top = Math.max(0, subjectTop - pad);
        }
        if (subjectBottom > top + metrics.visibleH - pad) {
          top = Math.min(1 - metrics.visibleH, subjectBottom + pad - metrics.visibleH);
        }
        nextY = (top * metrics.renderedH) / metrics.overflowY;
      } else {
        const top = clamp01(subjectBox.y + subjectBox.height / 2 - metrics.visibleH / 2);
        nextY = (top * metrics.renderedH) / metrics.overflowY;
      }
    }

    return { x: clamp01(nextX), y: clamp01(nextY) };
  }

  /**
   * Prefer a right-biased eye-line composition so faces clear left-aligned title/controls.
   * Groups stay nearer center so edge faces are not sacrificed.
   */
  function heroCompositionTargets(subject) {
    if (!subject) {
      return { targetX: 0.62, targetY: 0.34 };
    }
    return {
      targetX: subject.isGroup ? 0.56 : 0.68,
      targetY: 0.34
    };
  }

  function shouldUseContainHeroFit(subjectBox, metrics) {
    if (!subjectBox || !metrics) {
      return false;
    }
    const aspect = metrics.ch / metrics.cw;
    const shallow = aspect < 0.36;
    const cannotFitH = subjectBox.height > metrics.visibleH * 0.97;
    const cannotFitW = subjectBox.width > metrics.visibleW * 0.97;
    if (cannotFitH && cannotFitW) {
      return true;
    }
    if (shallow && subjectBox.height > metrics.visibleH * 0.82) {
      return true;
    }
    if (shallow && cannotFitH) {
      return true;
    }
    return false;
  }

  /**
   * Crop-aware framing from cached normalized faces + current hero size.
   * Returns { fit, objectPosition, position, subject } or null.
   */
  function computeArtistHeroFraming(normalizedFaces, containerWidth, containerHeight, imageWidth, imageHeight) {
    const subject = selectHeroFaceSubject(normalizedFaces);
    if (!subject) {
      return null;
    }

    const metrics = coverCropMetrics(containerWidth, containerHeight, imageWidth, imageHeight);
    if (!metrics) {
      return {
        fit: "cover",
        objectPosition: `${(subject.focal.x * 100).toFixed(2)}% ${(subject.focal.y * 100).toFixed(2)}%`,
        position: { x: subject.focal.x, y: subject.focal.y },
        subject
      };
    }

    if (shouldUseContainHeroFit(subject.box, metrics)) {
      return {
        fit: "contain",
        objectPosition: "50% 42%",
        position: { x: 0.5, y: 0.42 },
        subject
      };
    }

    const targets = heroCompositionTargets(subject);
    let ox = metrics.overflowX > 0
      ? (subject.focal.x * metrics.renderedW - targets.targetX * metrics.cw) / metrics.overflowX
      : subject.focal.x;
    let oy = metrics.overflowY > 0
      ? (subject.focal.y * metrics.renderedH - targets.targetY * metrics.ch) / metrics.overflowY
      : subject.focal.y;
    ox = clamp01(ox);
    oy = clamp01(oy);

    const kept = keepSubjectVisibleInCover(ox, oy, subject.box, metrics);
    return {
      fit: "cover",
      objectPosition: `${(kept.x * 100).toFixed(2)}% ${(kept.y * 100).toFixed(2)}%`,
      position: kept,
      subject,
      metrics
    };
  }

  /**
   * Maps a focal point to CSS object-position for cover fit.
   * Prefer computeArtistHeroFraming when face boxes are available.
   */
  function heroObjectPositionFromFocalPoint(focal, containerWidth, containerHeight, imageWidth, imageHeight) {
    if (!focal || ![focal.x, focal.y].every(Number.isFinite)) {
      return null;
    }
    const proxyFace = {
      x: clamp01(focal.x) - 0.05,
      y: clamp01(focal.y) - 0.05,
      width: 0.1,
      height: 0.12,
      area: 0.012
    };
    const framing = computeArtistHeroFraming(
      [proxyFace],
      containerWidth,
      containerHeight,
      imageWidth,
      imageHeight);
    if (framing?.objectPosition) {
      return framing.objectPosition;
    }
    return `${(clamp01(focal.x) * 100).toFixed(2)}% ${(clamp01(focal.y) * 100).toFixed(2)}%`;
  }

  /** Test helper: subject stays sufficiently visible across a set of hero sizes. */
  function subjectVisibleAcrossSizes(normalizedFaces, imageWidth, imageHeight, sizes, minOverlap = 0.5) {
    return sizes.every((size) => {
      const framing = computeArtistHeroFraming(
        normalizedFaces,
        size.width,
        size.height,
        imageWidth,
        imageHeight);
      if (!framing) {
        return false;
      }
      if (framing.fit === "contain") {
        return true;
      }
      const visible = visibleCoverRect(framing.position.x, framing.position.y, framing.metrics);
      return rectsIntersectEnough(framing.subject.box, visible, minOverlap);
    });
  }

  /**
   * Whether an artistInfo host reply should apply for the active request.
   * Stale requestIds (from an older open/refresh) must be ignored.
   */
  function shouldAcceptArtistInfoReply(info, activeRequestId) {
    if (!info || typeof info.name !== "string") {
      return false;
    }
    if (info.requestId == null || activeRequestId == null) {
      return true;
    }
    return Number(info.requestId) === Number(activeRequestId);
  }

  /** Soft-retry delay after a transient artistInfo reply (ms). */
  const ARTIST_INFO_SOFT_RETRY_MS = 4000;

  function shouldScheduleArtistInfoSoftRetry(info, { fromCache = false } = {}) {
    if (fromCache || !info) {
      return false;
    }
    return String(info.status || "").toLowerCase() === "transient";
  }

  function createArtistFaceDetector() {
    if (typeof FaceDetector !== "function") {
      return null;
    }
    try {
      return new FaceDetector({ fastMode: true, maxDetectedFaces: 8 });
    } catch {
      return null;
    }
  }

  /**
   * Detect faces once per image. Returns normalized boxes (0–1) or [] when unavailable.
   * Callers cache the result and recompute framing on resize without re-detecting.
   */
  async function detectArtistHeroFaces(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      return [];
    }
    const detector = createArtistFaceDetector();
    if (!detector) {
      return [];
    }
    try {
      const faces = await detector.detect(img);
      return normalizeHeroFaceBoxes(faces, img.naturalWidth, img.naturalHeight);
    } catch {
      return [];
    }
  }

  /** @deprecated Prefer detectArtistHeroFaces + computeArtistHeroFraming for resize-safe framing. */
  async function detectArtistHeroObjectPosition(img, container) {
    const faces = await detectArtistHeroFaces(img);
    if (!faces.length) {
      return null;
    }
    const rect = container?.getBoundingClientRect?.();
    const framing = computeArtistHeroFraming(
      faces,
      rect?.width || 0,
      rect?.height || 0,
      img.naturalWidth,
      img.naturalHeight);
    return framing?.objectPosition || null;
  }

  const api = {
    ARTIST_BIO_COLLAPSE_CHARS,
    ARTIST_IMAGE_HOST,
    hasArtistProfileData,
    isSafeHttpUrl,
    isSafeArtistImageUrl,
    artistBiographyParagraphs,
    collapseBiography,
    artistMonogram,
    shouldApplyArtistInfo,
    humanizeArtistArea,
    primaryArtistGenres,
    artistDateFact,
    artistHeroDescriptor,
    artistDetailsFacts,
    artistAboutLayoutMode,
    normalizeHeroFaceBoxes,
    selectHeroFaceSubject,
    selectHeroFaceFocalPoint,
    coverCropMetrics,
    visibleCoverRect,
    keepSubjectVisibleInCover,
    shouldUseContainHeroFit,
    computeArtistHeroFraming,
    heroObjectPositionFromFocalPoint,
    subjectVisibleAcrossSizes,
    createArtistFaceDetector,
    detectArtistHeroFaces,
    detectArtistHeroObjectPosition,
    shouldAcceptArtistInfoReply,
    ARTIST_INFO_SOFT_RETRY_MS,
    shouldScheduleArtistInfoSoftRetry
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.EmpArtistProfile = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
