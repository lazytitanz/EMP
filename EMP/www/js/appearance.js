/**
 * EMP appearance preferences: theme, accent, density, artwork stage accents.
 * Pure helpers + DOM application; dual export for node:test and browser.
 */
(function (global) {
  "use strict";

  const SESSION_KEY = "emp.playback";

  const THEMES = Object.freeze(["dark", "light", "system"]);
  const DENSITIES = Object.freeze(["comfortable", "compact"]);
  const ACCENT_IDS = Object.freeze(["emp", "blue", "violet", "coral", "amber", "custom"]);

  const ACCENT_PRESETS = Object.freeze({
    emp: Object.freeze({ id: "emp", label: "EMP Green", color: "#1db954" }),
    blue: Object.freeze({ id: "blue", label: "Blue", color: "#3b82f6" }),
    violet: Object.freeze({ id: "violet", label: "Violet", color: "#8b5cf6" }),
    coral: Object.freeze({ id: "coral", label: "Coral", color: "#f07167" }),
    amber: Object.freeze({ id: "amber", label: "Amber", color: "#f59e0b" })
  });

  const DEFAULTS = Object.freeze({
    theme: "dark",
    accent: "emp",
    accentCustom: "#20c77a",
    density: "comfortable",
    artworkAccents: true
  });

  /** Fallbacks when CSS vars are unavailable (tests / pre-CSS). */
  const DENSITY_FALLBACKS = Object.freeze({
    comfortable: Object.freeze({
      trackRowHeight: 58,
      queueRowHeight: 60,
      collectionListRowHeight: 64
    }),
    compact: Object.freeze({
      trackRowHeight: 48,
      queueRowHeight: 52,
      collectionListRowHeight: 52
    })
  });

  const SURFACE_DARK = "#121212";
  const SURFACE_LIGHT = "#f4f4f5";
  const SURFACE_RAISED_DARK = "#282828";
  const SURFACE_RAISED_LIGHT = "#ffffff";

  function cloneDefaults() {
    return {
      theme: DEFAULTS.theme,
      accent: DEFAULTS.accent,
      accentCustom: DEFAULTS.accentCustom,
      density: DEFAULTS.density,
      artworkAccents: DEFAULTS.artworkAccents
    };
  }

  function normalizeHex(value, fallback = DEFAULTS.accentCustom) {
    if (typeof value !== "string") {
      return fallback;
    }
    let raw = value.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(raw)) {
      raw = `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
    }
    if (!/^#[0-9a-f]{6}$/.test(raw)) {
      return fallback;
    }
    return raw;
  }

  function normalizeAppearance(input) {
    const src = input && typeof input === "object" ? input : {};
    const theme = THEMES.includes(src.theme) ? src.theme : DEFAULTS.theme;
    const accent = ACCENT_IDS.includes(src.accent) ? src.accent : DEFAULTS.accent;
    const density = DENSITIES.includes(src.density) ? src.density : DEFAULTS.density;
    const artworkAccents = src.artworkAccents === undefined || src.artworkAccents === null
      ? DEFAULTS.artworkAccents
      : Boolean(src.artworkAccents);
    return {
      theme,
      accent,
      accentCustom: normalizeHex(src.accentCustom, DEFAULTS.accentCustom),
      density,
      artworkAccents
    };
  }

  function parseHex(hex) {
    const normalized = normalizeHex(hex, null);
    if (!normalized) {
      return null;
    }
    return [
      parseInt(normalized.slice(1, 3), 16),
      parseInt(normalized.slice(3, 5), 16),
      parseInt(normalized.slice(5, 7), 16)
    ];
  }

  function toHex([r, g, b]) {
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
    return `#${[clamp(r), clamp(g), clamp(b)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }

  function rgbToHsl([r, g, b]) {
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
    let h = 0;
    if (max === rn) {
      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    } else if (max === gn) {
      h = ((bn - rn) / d + 2) / 6;
    } else {
      h = ((rn - gn) / d + 4) / 6;
    }
    return [h, s, l];
  }

  function hslToRgb([h, s, l]) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const hue2rgb = (p, q, t) => {
      let tt = t;
      if (tt < 0) {
        tt += 1;
      }
      if (tt > 1) {
        tt -= 1;
      }
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
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    ];
  }

  function channelLuminance(channel) {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  function relativeLuminance(rgb) {
    return 0.2126 * channelLuminance(rgb[0])
      + 0.7152 * channelLuminance(rgb[1])
      + 0.0722 * channelLuminance(rgb[2]);
  }

  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function contrastForeground(hex) {
    const rgb = parseHex(hex);
    if (!rgb) {
      return "#ffffff";
    }
    const white = contrastRatio(rgb, [255, 255, 255]);
    const black = contrastRatio(rgb, [18, 18, 18]);
    return white >= black ? "#ffffff" : "#121212";
  }

  function resolveAccentHex(appearance) {
    const prefs = normalizeAppearance(appearance);
    if (prefs.accent === "custom") {
      return normalizeHex(prefs.accentCustom, ACCENT_PRESETS.emp.color);
    }
    return ACCENT_PRESETS[prefs.accent]?.color || ACCENT_PRESETS.emp.color;
  }

  function adjustLightness(hex, delta) {
    const rgb = parseHex(hex);
    if (!rgb) {
      return hex;
    }
    const [h, s, l] = rgbToHsl(rgb);
    return toHex(hslToRgb([h, s, Math.max(0, Math.min(1, l + delta))]));
  }

  function hexToRgba(hex, alpha) {
    const rgb = parseHex(hex);
    if (!rgb) {
      return `rgba(29, 185, 84, ${alpha})`;
    }
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  }

  /**
   * Ensure accent-as-text/icons remain readable on both canvas and raised surfaces.
   * Walks lightness until contrast >= minRatio against both surfaces (or closest).
   */
  function readableOnSurfaces(accentHex, theme, minRatio = 4.5) {
    const rgb = parseHex(accentHex);
    if (!rgb) {
      return ACCENT_PRESETS.emp.color;
    }
    const surfaces = theme === "light"
      ? [parseHex(SURFACE_LIGHT), parseHex(SURFACE_RAISED_LIGHT)]
      : [parseHex(SURFACE_DARK), parseHex(SURFACE_RAISED_DARK)];

    const meets = (candidate) => surfaces.every((surface) => contrastRatio(candidate, surface) >= minRatio);

    if (meets(rgb)) {
      return normalizeHex(accentHex);
    }

    const [h, s, l0] = rgbToHsl(rgb);
    const preferDarker = theme === "light";
    let best = rgb;
    let bestScore = Math.min(...surfaces.map((surface) => contrastRatio(rgb, surface)));

    for (let step = 1; step <= 40; step += 1) {
      const delta = step * 0.02 * (preferDarker ? -1 : 1);
      const l = Math.max(0.08, Math.min(0.92, l0 + delta));
      const candidate = hslToRgb([h, Math.min(1, s * 1.05), l]);
      const score = Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface)));
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
      if (meets(candidate)) {
        return toHex(candidate);
      }
    }

    for (let step = 1; step <= 40; step += 1) {
      const delta = step * 0.02 * (preferDarker ? 1 : -1);
      const l = Math.max(0.08, Math.min(0.92, l0 + delta));
      const candidate = hslToRgb([h, Math.min(1, s * 1.05), l]);
      const score = Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface)));
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
      if (meets(candidate)) {
        return toHex(candidate);
      }
    }

    return toHex(best);
  }

  function deriveAccent(appearance, resolvedTheme) {
    const prefs = normalizeAppearance(appearance);
    const theme = resolvedTheme === "light" ? "light" : "dark";
    const base = resolveAccentHex(prefs);
    const hover = theme === "light"
      ? adjustLightness(base, -0.08)
      : adjustLightness(base, 0.08);
    const readable = readableOnSurfaces(base, theme, 4.5);
    const readableHover = theme === "light"
      ? adjustLightness(readable, -0.06)
      : adjustLightness(readable, 0.06);
    return {
      accent: base,
      accentHover: hover,
      accentContrast: contrastForeground(base),
      accentSubtle: hexToRgba(base, theme === "light" ? 0.14 : 0.18),
      accentReadable: readable,
      accentReadableHover: readableHover,
      focusRing: hexToRgba(readable, 0.45)
    };
  }

  function resolveTheme(themePref, matchMediaFn) {
    const pref = THEMES.includes(themePref) ? themePref : DEFAULTS.theme;
    if (pref !== "system") {
      return pref;
    }
    try {
      const mql = typeof matchMediaFn === "function"
        ? matchMediaFn("(prefers-color-scheme: dark)")
        : (typeof global.matchMedia === "function" ? global.matchMedia("(prefers-color-scheme: dark)") : null);
      if (mql && typeof mql.matches === "boolean") {
        return mql.matches ? "dark" : "light";
      }
    } catch {
      // ignore
    }
    return "dark";
  }

  function parseCssPx(value, fallback) {
    const n = parseFloat(String(value || "").trim());
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /**
   * Read density row strides from CSS custom properties (source of truth).
   * Fallbacks only when stylesheets are not applied (unit tests).
   */
  function readDensityMetrics(root, densityPref) {
    const density = DENSITIES.includes(densityPref) ? densityPref : DEFAULTS.density;
    const fallbacks = DENSITY_FALLBACKS[density] || DENSITY_FALLBACKS.comfortable;
    if (!root || typeof global.getComputedStyle !== "function") {
      return { ...fallbacks, density };
    }
    try {
      const style = global.getComputedStyle(root);
      return {
        density,
        trackRowHeight: parseCssPx(style.getPropertyValue("--emp-track-row-height"), fallbacks.trackRowHeight),
        queueRowHeight: parseCssPx(style.getPropertyValue("--emp-queue-row-height"), fallbacks.queueRowHeight),
        collectionListRowHeight: parseCssPx(
          style.getPropertyValue("--emp-collection-list-row-height"),
          fallbacks.collectionListRowHeight
        )
      };
    } catch {
      return { ...fallbacks, density };
    }
  }

  function notifyHostChromeTheme(resolvedTheme, options = {}) {
    if (options.notifyHost === false) {
      return;
    }
    try {
      const post = options.postMessage
        || (typeof global.chrome !== "undefined"
          && global.chrome?.webview
          && typeof global.chrome.webview.postMessage === "function"
          ? global.chrome.webview.postMessage.bind(global.chrome.webview)
          : null);
      if (!post) {
        return;
      }
      post({ type: "chromeTheme", theme: resolvedTheme === "light" ? "light" : "dark" });
    } catch {
      // Host bridge is best-effort during early boot.
    }
  }

  function applyAppearance(appearance, options = {}) {
    const prefs = normalizeAppearance(appearance);
    const root = options.root
      || (typeof document !== "undefined" ? document.documentElement : null);
    const matchMediaFn = options.matchMedia || (typeof global.matchMedia === "function" ? global.matchMedia.bind(global) : null);
    const resolved = resolveTheme(prefs.theme, matchMediaFn);
    const derived = deriveAccent(prefs, resolved);

    if (root && root.setAttribute) {
      root.setAttribute("data-emp-theme", resolved);
      root.setAttribute("data-emp-density", prefs.density);
      root.setAttribute("data-bs-theme", resolved);
      if (root.style) {
        root.style.colorScheme = resolved;
        root.style.setProperty("--emp-accent", derived.accent);
        root.style.setProperty("--emp-accent-hover", derived.accentHover);
        root.style.setProperty("--emp-accent-contrast", derived.accentContrast);
        root.style.setProperty("--emp-accent-subtle", derived.accentSubtle);
        root.style.setProperty("--emp-accent-readable", derived.accentReadable);
        root.style.setProperty("--emp-accent-readable-hover", derived.accentReadableHover);
        root.style.setProperty("--emp-focus-ring", derived.focusRing);
      }
    }

    notifyHostChromeTheme(resolved, options);

    return {
      prefs,
      resolvedTheme: resolved,
      derived,
      metrics: readDensityMetrics(root, prefs.density)
    };
  }

  function readAppearanceFromStorage(storage, key = SESSION_KEY) {
    try {
      const store = storage || (typeof global.localStorage !== "undefined" ? global.localStorage : null);
      if (!store) {
        return cloneDefaults();
      }
      const raw = store.getItem(key);
      if (!raw) {
        return cloneDefaults();
      }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.appearance && typeof parsed.appearance === "object") {
        return normalizeAppearance(parsed.appearance);
      }
      return cloneDefaults();
    } catch {
      return cloneDefaults();
    }
  }

  function bootFromSession(storageKey = SESSION_KEY, options = {}) {
    const prefs = readAppearanceFromStorage(options.storage, storageKey);
    return applyAppearance(prefs, options);
  }

  let systemMediaQuery = null;
  let systemListener = null;

  function unbindSystemThemeListener() {
    if (!systemMediaQuery || !systemListener) {
      systemMediaQuery = null;
      systemListener = null;
      return;
    }
    if (typeof systemMediaQuery.removeEventListener === "function") {
      systemMediaQuery.removeEventListener("change", systemListener);
    } else if (typeof systemMediaQuery.removeListener === "function") {
      systemMediaQuery.removeListener(systemListener);
    }
    systemMediaQuery = null;
    systemListener = null;
  }

  function bindSystemThemeListener(getAppearance, onChange, matchMediaFn) {
    const media = typeof matchMediaFn === "function"
      ? matchMediaFn
      : (typeof global.matchMedia === "function" ? global.matchMedia.bind(global) : null);
    if (!media) {
      return () => {};
    }

    unbindSystemThemeListener();

    try {
      systemMediaQuery = media("(prefers-color-scheme: dark)");
    } catch {
      systemMediaQuery = null;
      return () => {};
    }

    systemListener = () => {
      const prefs = typeof getAppearance === "function" ? getAppearance() : null;
      if (!prefs || prefs.theme !== "system") {
        return;
      }
      if (typeof onChange === "function") {
        onChange(prefs);
      }
    };

    if (typeof systemMediaQuery.addEventListener === "function") {
      systemMediaQuery.addEventListener("change", systemListener);
    } else if (typeof systemMediaQuery.addListener === "function") {
      systemMediaQuery.addListener(systemListener);
    }

    return unbindSystemThemeListener;
  }

  const api = {
    SESSION_KEY,
    THEMES,
    DENSITIES,
    ACCENT_IDS,
    ACCENT_PRESETS,
    DEFAULTS,
    DENSITY_FALLBACKS,
    cloneDefaults,
    normalizeHex,
    normalizeAppearance,
    resolveTheme,
    resolveAccentHex,
    contrastForeground,
    contrastRatio,
    relativeLuminance,
    parseHex,
    readableOnSurfaces,
    deriveAccent,
    readDensityMetrics,
    applyAppearance,
    notifyHostChromeTheme,
    readAppearanceFromStorage,
    bootFromSession,
    bindSystemThemeListener,
    unbindSystemThemeListener
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.EmpAppearance = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
