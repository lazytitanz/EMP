/**
 * Artwork-derived ambient gradient for the Now Playing page.
 * Canvas color fields + continuous palette crossfade. No audio analysis.
 */
(function (global) {
  "use strict";

  const SAMPLE_SIZE = 64;
  const PALETTE_SIZE = 4;
  const CROSSFADE_MS = 1400;
  const FRAME_MIN_MS = 33;
  /** Internal tuning knob — not a user setting. 1 = calibrated calm swirl. */
  const MOTION_SCALE = 1;
  const FALLBACK_COLORS = [
    [48, 42, 58],
    [28, 52, 44],
    [62, 36, 52],
    [22, 22, 28]
  ];

  const paletteCache = new Map();
  let canvas = null;
  let ctx = null;
  let rafId = 0;
  let lastFrameAt = 0;
  let running = false;
  let visible = false;
  let reducedMotion = false;
  let resizeObserver = null;
  let visibilityHandler = null;
  let motionQuery = null;
  let motionHandler = null;

  let displayColors = clonePalette(FALLBACK_COLORS);
  let fromColors = clonePalette(FALLBACK_COLORS);
  let toColors = clonePalette(FALLBACK_COLORS);
  let fadeProgress = 1;
  let fadeStartAt = 0;
  let acceptedGeneration = 0;
  let activeCoverIdentity = "";
  let fields = createFields();

  function coverUrlIdentity(coverUrl) {
    const raw = typeof coverUrl === "string" ? coverUrl.trim() : "";
    if (!raw) {
      return "";
    }
    const query = raw.indexOf("?");
    return query < 0 ? raw : raw.slice(0, query);
  }

  function clonePalette(palette) {
    return palette.map((rgb) => [rgb[0], rgb[1], rgb[2]]);
  }

  function parseCssColor(color) {
    if (typeof color !== "string") {
      return null;
    }
    const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const value = hex[1].length === 3
        ? hex[1].split("").map((part) => part + part).join("")
        : hex[1];
      return [
        Number.parseInt(value.slice(0, 2), 16),
        Number.parseInt(value.slice(2, 4), 16),
        Number.parseInt(value.slice(4, 6), 16)
      ];
    }
    const rgb = color.match(/rgba?\(([^)]+)\)/i);
    if (!rgb) {
      return null;
    }
    const parts = rgb[1].split(",").slice(0, 3).map((part) => Number.parseFloat(part));
    return parts.length === 3 && parts.every(Number.isFinite) ? parts.map((n) => Math.round(n)) : null;
  }

  function seedPaletteFromColors(seedColors) {
    const parsed = [];
    for (const color of seedColors || []) {
      const rgb = Array.isArray(color) ? color : parseCssColor(color);
      if (rgb) {
        parsed.push(toneForAmbient(rgb));
      }
    }
    while (parsed.length < PALETTE_SIZE) {
      parsed.push(FALLBACK_COLORS[parsed.length % FALLBACK_COLORS.length].slice());
    }
    return parsed.slice(0, PALETTE_SIZE);
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) {
      return [0, 0, l];
    }
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rn) {
      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    } else if (max === gn) {
      h = ((bn - rn) / d + 2) / 6;
    } else {
      h = ((rn - gn) / d + 4) / 6;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
      const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      if (tt < 1 / 6) {
        return p + (q - p) * 6 * tt;
      }
      if (tt < 1 / 2) {
        return q;
      }
      if (tt < 2 / 3) {
        return p + (q - p) * (2 / 3 - tt) * 6;
      }
      return p;
    };
    return [
      Math.round(channel(h + 1 / 3) * 255),
      Math.round(channel(h) * 255),
      Math.round(channel(h - 1 / 3) * 255)
    ];
  }

  function toneForAmbient(rgb) {
    let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const wasMuted = s < 0.12;
    if (wasMuted) {
      // Keep greyscale / near-mono character; lift slightly so fields read on stage.
      s = Math.min(s, 0.1);
      l = Math.min(0.42, Math.max(0.14, l * 0.9));
    } else {
      s = Math.min(0.68, Math.max(0.28, s * 0.95));
      l = Math.min(0.52, Math.max(0.18, l * 0.92));
    }
    return hslToRgb(h, s, l);
  }

  function medianCutPalette(pixels, depth) {
    if (depth === 0 || pixels.length <= 1) {
      const avg = [0, 0, 0];
      for (const p of pixels) {
        avg[0] += p[0];
        avg[1] += p[1];
        avg[2] += p[2];
      }
      const n = pixels.length || 1;
      return [[Math.round(avg[0] / n), Math.round(avg[1] / n), Math.round(avg[2] / n)]];
    }

    let maxRange = 0;
    let maxChannel = 0;
    for (let ch = 0; ch < 3; ch += 1) {
      let lo = 255;
      let hi = 0;
      for (const p of pixels) {
        if (p[ch] < lo) {
          lo = p[ch];
        }
        if (p[ch] > hi) {
          hi = p[ch];
        }
      }
      if (hi - lo > maxRange) {
        maxRange = hi - lo;
        maxChannel = ch;
      }
    }

    pixels.sort((a, b) => a[maxChannel] - b[maxChannel]);
    const mid = Math.floor(pixels.length / 2);
    return [
      ...medianCutPalette(pixels.slice(0, mid), depth - 1),
      ...medianCutPalette(pixels.slice(mid), depth - 1)
    ];
  }

  function scoreSwatch(rgb) {
    const [, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    if (l < 0.05 || l > 0.92) {
      return -1;
    }
    // Prefer mid luminance; reward saturation without requiring it.
    return s * 1.4 + (1 - Math.abs(l - 0.35)) * 0.8;
  }

  function extractPaletteFromImageData(data) {
    const vivid = [];
    const all = [];
    let satSum = 0;
    let satCount = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 200) {
        continue;
      }
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lightness = (max + min) / 2;
      const saturation = max === 0 ? 0 : (max - min) / max;
      satSum += saturation;
      satCount += 1;
      all.push([r, g, b]);
      if (saturation > 0.12 && lightness > 18 && lightness < 230) {
        vivid.push([r, g, b]);
      }
    }

    const pool = vivid.length >= 24 ? vivid : all;
    if (!pool.length) {
      return clonePalette(FALLBACK_COLORS);
    }

    const meanSat = satCount ? satSum / satCount : 0;
    const depth = meanSat < 0.1 ? 2 : 3;
    const cuts = medianCutPalette(pool.slice(), depth);
    const ranked = cuts
      .map((rgb) => ({ rgb, score: scoreSwatch(rgb) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score);

    const picked = [];
    const used = [];
    for (const entry of ranked) {
      if (picked.length >= PALETTE_SIZE) {
        break;
      }
      const tooClose = used.some((other) => colorDistance(entry.rgb, other) < 28);
      if (tooClose) {
        continue;
      }
      used.push(entry.rgb);
      picked.push(toneForAmbient(entry.rgb));
    }

    while (picked.length < PALETTE_SIZE) {
      const base = picked[picked.length - 1] || FALLBACK_COLORS[picked.length];
      const [, s, l] = rgbToHsl(base[0], base[1], base[2]);
      picked.push(hslToRgb((picked.length * 0.17) % 1, Math.min(s, 0.2), Math.max(0.1, l * 0.7)));
    }

    return picked.slice(0, PALETTE_SIZE);
  }

  function colorDistance(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      // Same-origin virtual host (app.emp) — no crossOrigin needed; matches extractVibrantColor.
      img.src = src;
    });
  }

  async function extractPalette(coverUrl) {
    const identity = coverUrlIdentity(coverUrl);
    if (!identity) {
      return clonePalette(FALLBACK_COLORS);
    }
    if (paletteCache.has(identity)) {
      return clonePalette(paletteCache.get(identity));
    }

    const img = await loadImage(coverUrl);
    if (!img) {
      return clonePalette(FALLBACK_COLORS);
    }

    try {
      const offscreen = document.createElement("canvas");
      offscreen.width = SAMPLE_SIZE;
      offscreen.height = SAMPLE_SIZE;
      const offCtx = offscreen.getContext("2d", { willReadFrequently: true });
      if (!offCtx) {
        return clonePalette(FALLBACK_COLORS);
      }
      offCtx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const imageData = offCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const palette = extractPaletteFromImageData(imageData.data);
      paletteCache.set(identity, clonePalette(palette));
      return palette;
    } catch (_err) {
      // Tainted canvas or decode failure — fall back quietly.
      return clonePalette(FALLBACK_COLORS);
    }
  }

  function blendPalettes(a, b, t) {
    const amount = Math.min(1, Math.max(0, t));
    const out = [];
    for (let i = 0; i < PALETTE_SIZE; i += 1) {
      const left = a[i] || FALLBACK_COLORS[i];
      const right = b[i] || FALLBACK_COLORS[i];
      out.push([
        Math.round(left[0] + (right[0] - left[0]) * amount),
        Math.round(left[1] + (right[1] - left[1]) * amount),
        Math.round(left[2] + (right[2] - left[2]) * amount)
      ]);
    }
    return out;
  }

  function currentBlendedColors() {
    if (fadeProgress >= 1) {
      return clonePalette(toColors);
    }
    return blendPalettes(fromColors, toColors, fadeProgress);
  }

  function beginTransition(nextPalette, { immediate = false } = {}) {
    const next = clonePalette(nextPalette);
    if (immediate || reducedMotion) {
      fromColors = clonePalette(next);
      toColors = clonePalette(next);
      displayColors = clonePalette(next);
      fadeProgress = 1;
      paintStatic();
      return;
    }

    fromColors = currentBlendedColors();
    toColors = next;
    fadeProgress = 0;
    fadeStartAt = performance.now();
  }

  /**
   * Field motion notes (why the old animation felt static):
   * - Speeds ~0.01 rad/s ⇒ one orbit took 6+ minutes; 5s of watch ≈ 3°.
   * - Radii 0.5–0.88 of the stage ⇒ everything was one soft wash; overlaps never shifted.
   * New fields use elliptical orbits (~25–55s), mid-size blobs, and stretch/spin so
   * silhouettes and blend boundaries evolve within a few seconds.
   */
  function createFields() {
    return [
      {
        cx: 0.28, cy: 0.32, orbitRx: 0.22, orbitRy: 0.16,
        baseR: 0.42, rPulse: 0.08, speed: 0.14, spin: 0.045, phase: 0.2,
        stretchPhase: 0.4, stretchAmp: 0.22, color: 0, dir: 1
      },
      {
        cx: 0.74, cy: 0.28, orbitRx: 0.2, orbitRy: 0.24,
        baseR: 0.38, rPulse: 0.07, speed: 0.11, spin: -0.038, phase: 2.1,
        stretchPhase: 1.6, stretchAmp: 0.28, color: 1, dir: -1
      },
      {
        cx: 0.55, cy: 0.7, orbitRx: 0.26, orbitRy: 0.14,
        baseR: 0.48, rPulse: 0.1, speed: 0.085, spin: 0.03, phase: 3.8,
        stretchPhase: 2.8, stretchAmp: 0.18, color: 2, dir: 1
      },
      {
        cx: 0.18, cy: 0.68, orbitRx: 0.16, orbitRy: 0.2,
        baseR: 0.34, rPulse: 0.06, speed: 0.165, spin: -0.055, phase: 5.2,
        stretchPhase: 0.9, stretchAmp: 0.3, color: 3, dir: -1
      },
      {
        cx: 0.86, cy: 0.62, orbitRx: 0.18, orbitRy: 0.18,
        baseR: 0.36, rPulse: 0.09, speed: 0.12, spin: 0.05, phase: 1.1,
        stretchPhase: 3.5, stretchAmp: 0.25, color: 1, dir: 1
      },
      {
        cx: 0.48, cy: 0.42, orbitRx: 0.14, orbitRy: 0.22,
        baseR: 0.3, rPulse: 0.05, speed: 0.195, spin: -0.07, phase: 4.4,
        stretchPhase: 2.2, stretchAmp: 0.34, color: 0, dir: -1
      }
    ];
  }

  function resizeCanvas() {
    if (!canvas || !ctx) {
      return false;
    }
    // Size from the page host, not a fixed canvas.style width/height. Locking
    // CSS pixels broke inset:0 fluid fill and made ResizeObserver on the canvas
    // miss sidebar/window resizes (right/bottom black strips).
    const host = canvas.parentElement;
    const cssW = Math.max(1, host?.clientWidth || canvas.clientWidth || 0);
    const cssH = Math.max(1, host?.clientHeight || canvas.clientHeight || 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(cssW * dpr));
    const height = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      return true;
    }
    return false;
  }

  function paintFrame(now) {
    if (!ctx || !canvas) {
      return;
    }
    resizeCanvas();
    const w = canvas.width;
    const h = canvas.height;
    if (w < 2 || h < 2) {
      return;
    }

    if (fadeProgress < 1) {
      fadeProgress = Math.min(1, (now - fadeStartAt) / CROSSFADE_MS);
      displayColors = blendPalettes(fromColors, toColors, fadeProgress);
    } else {
      displayColors = clonePalette(toColors);
    }

    ctx.clearRect(0, 0, w, h);
    const base = displayColors[3] || displayColors[0];
    const mid = displayColors[0] || base;
    const baseGrad = ctx.createLinearGradient(0, 0, w, h);
    baseGrad.addColorStop(0, `rgb(${mid[0]}, ${mid[1]}, ${mid[2]})`);
    baseGrad.addColorStop(1, `rgb(${base[0]}, ${base[1]}, ${base[2]})`);
    ctx.fillStyle = baseGrad;
    ctx.fillRect(0, 0, w, h);

    // Elapsed seconds — motion is time-based, not frame-count-based.
    const t = (now / 1000) * MOTION_SCALE;
    const stage = Math.max(w, h);

    for (const field of fields) {
      const orbit = t * field.speed * field.dir + field.phase;
      // Second harmonic keeps paths from looking like a perfect loop.
      const drift = t * field.speed * 0.37 + field.phase * 0.5;
      const px = (field.cx + Math.cos(orbit) * field.orbitRx + Math.cos(drift) * field.orbitRx * 0.18) * w;
      const py = (field.cy + Math.sin(orbit) * field.orbitRy + Math.sin(drift * 1.15) * field.orbitRy * 0.2) * h;

      const breathe = 1 + Math.sin(t * field.speed * 1.4 + field.stretchPhase) * field.rPulse;
      const radius = field.baseR * breathe * stage;
      const stretchX = 1 + Math.sin(t * field.speed * 0.9 + field.stretchPhase) * field.stretchAmp;
      const stretchY = 1 + Math.cos(t * field.speed * 1.1 + field.stretchPhase * 1.3) * field.stretchAmp;
      const rotation = t * field.spin + field.phase * 0.35;

      const color = displayColors[field.color % displayColors.length];
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rotation);
      ctx.scale(stretchX, stretchY);
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      gradient.addColorStop(0, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.88)`);
      gradient.addColorStop(0.35, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.48)`);
      gradient.addColorStop(0.7, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.16)`);
      gradient.addColorStop(1, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0)`);
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.globalCompositeOperation = "source-over";
    const vignette = ctx.createRadialGradient(
      w * 0.5,
      h * 0.42,
      Math.min(w, h) * 0.2,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.78
    );
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(0.55, "rgba(0, 0, 0, 0.14)");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.48)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  function paintStatic() {
    paintFrame(performance.now());
  }

  function tick(now) {
    rafId = 0;
    if (!running || !visible) {
      return;
    }
    if (reducedMotion) {
      paintStatic();
      return;
    }
    if (document.hidden) {
      // Stop the rAF chain while hidden; visibilitychange resumes it.
      return;
    }
    if (now - lastFrameAt >= FRAME_MIN_MS) {
      lastFrameAt = now;
      paintFrame(now);
    }
    schedule();
  }

  function schedule() {
    if (!running || !visible || rafId) {
      return;
    }
    if (reducedMotion) {
      paintStatic();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function setVisible(next) {
    visible = Boolean(next);
    if (visible) {
      schedule();
      paintStatic();
    } else {
      stopLoop();
    }
  }

  function syncMotionPreference() {
    reducedMotion = Boolean(motionQuery?.matches);
    if (visible) {
      paintStatic();
      if (!reducedMotion) {
        schedule();
      } else {
        stopLoop();
      }
    }
  }

  function mount(targetCanvas) {
    if (!(targetCanvas instanceof HTMLCanvasElement)) {
      return;
    }
    unmount();
    canvas = targetCanvas;
    canvas.style.removeProperty("width");
    canvas.style.removeProperty("height");
    ctx = canvas.getContext("2d", { alpha: false });
    running = true;
    visible = true;
    fields = createFields();
    resizeCanvas();

    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        if (resizeCanvas() || visible) {
          paintStatic();
        }
      });
      // Observe the page host so sidebar collapse / window resize are detected.
      const host = canvas.parentElement;
      if (host) {
        resizeObserver.observe(host);
      }
    }

    visibilityHandler = () => {
      if (!document.hidden && visible && !reducedMotion) {
        schedule();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    motionQuery = global.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
    if (motionQuery) {
      motionHandler = () => syncMotionPreference();
      if (typeof motionQuery.addEventListener === "function") {
        motionQuery.addEventListener("change", motionHandler);
      } else if (typeof motionQuery.addListener === "function") {
        motionQuery.addListener(motionHandler);
      }
    }
    syncMotionPreference();
    paintStatic();
    schedule();
  }

  function unmount() {
    running = false;
    visible = false;
    stopLoop();
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
    if (motionQuery && motionHandler) {
      if (typeof motionQuery.removeEventListener === "function") {
        motionQuery.removeEventListener("change", motionHandler);
      } else if (typeof motionQuery.removeListener === "function") {
        motionQuery.removeListener(motionHandler);
      }
    }
    motionQuery = null;
    motionHandler = null;
    canvas = null;
    ctx = null;
    activeCoverIdentity = "";
  }

  async function setArtwork(coverUrl, options = {}) {
    const generation = Number(options.generation) || 0;
    if (generation < acceptedGeneration) {
      return;
    }
    acceptedGeneration = generation;

    const identity = coverUrlIdentity(coverUrl);
    const seed = seedPaletteFromColors(options.seedColors);
    const immediate = options.immediate === true;

    if (!identity) {
      activeCoverIdentity = "";
      beginTransition(seed.length ? seed : FALLBACK_COLORS, { immediate });
      return;
    }

    if (identity && identity === activeCoverIdentity) {
      return;
    }

    // Seed immediately so UI doesn't flash fallback while decoding.
    beginTransition(seed, { immediate: immediate || !activeCoverIdentity });

    const palette = await extractPalette(coverUrl);
    if (generation < acceptedGeneration) {
      return;
    }
    activeCoverIdentity = identity;
    beginTransition(palette, { immediate: false });
  }

  const api = {
    mount,
    unmount,
    setArtwork,
    setVisible,
    coverUrlIdentity,
    FALLBACK_COLORS
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpNowPlayingAmbient = api;
})(typeof window !== "undefined" ? window : globalThis);
