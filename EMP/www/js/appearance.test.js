"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Appearance = require("./appearance.js");

describe("appearance defaults and normalization", () => {
  it("exposes dark-first defaults", () => {
    assert.deepEqual(Appearance.cloneDefaults(), {
      theme: "dark",
      accent: "emp",
      accentCustom: "#20c77a",
      density: "comfortable",
      artworkAccents: true
    });
  });

  it("normalizes missing and invalid values", () => {
    assert.deepEqual(Appearance.normalizeAppearance(null), Appearance.cloneDefaults());
    assert.deepEqual(Appearance.normalizeAppearance({
      theme: "neon",
      accent: "pink",
      accentCustom: "nope",
      density: "cozy",
      artworkAccents: "yes"
    }), {
      theme: "dark",
      accent: "emp",
      accentCustom: "#20c77a",
      density: "comfortable",
      artworkAccents: true
    });
  });

  it("accepts valid preferences including system and custom hex", () => {
    assert.deepEqual(Appearance.normalizeAppearance({
      theme: "system",
      accent: "custom",
      accentCustom: "#AbC",
      density: "compact",
      artworkAccents: false
    }), {
      theme: "system",
      accent: "custom",
      accentCustom: "#aabbcc",
      density: "compact",
      artworkAccents: false
    });
  });

  it("treats older sessions without appearance as defaults", () => {
    const storage = {
      getItem() {
        return JSON.stringify({ volume: 40, crossfade: true });
      }
    };
    assert.deepEqual(Appearance.readAppearanceFromStorage(storage), Appearance.cloneDefaults());
  });

  it("reads nested appearance from session payload", () => {
    const storage = {
      getItem() {
        return JSON.stringify({
          appearance: { theme: "light", accent: "violet", density: "compact", artworkAccents: false }
        });
      }
    };
    assert.equal(Appearance.readAppearanceFromStorage(storage).theme, "light");
    assert.equal(Appearance.readAppearanceFromStorage(storage).accent, "violet");
    assert.equal(Appearance.readAppearanceFromStorage(storage).artworkAccents, false);
  });
});

describe("theme resolution", () => {
  it("resolves explicit themes without matchMedia", () => {
    assert.equal(Appearance.resolveTheme("dark"), "dark");
    assert.equal(Appearance.resolveTheme("light"), "light");
  });

  it("resolves system from matchMedia and keeps preference as system", () => {
    const light = Appearance.resolveTheme("system", () => ({ matches: false }));
    const dark = Appearance.resolveTheme("system", () => ({ matches: true }));
    assert.equal(light, "light");
    assert.equal(dark, "dark");
    assert.equal(Appearance.normalizeAppearance({ theme: "system" }).theme, "system");
  });
});

describe("accent derivation and contrast", () => {
  it("resolves preset and custom accent hex", () => {
    assert.equal(Appearance.resolveAccentHex({ accent: "blue" }), "#3b82f6");
    assert.equal(Appearance.resolveAccentHex({ accent: "custom", accentCustom: "#112233" }), "#112233");
  });

  it("picks readable contrast foreground for filled accents", () => {
    assert.equal(Appearance.contrastForeground("#1db954"), "#121212");
    assert.equal(Appearance.contrastForeground("#000000"), "#ffffff");
    assert.equal(Appearance.contrastForeground("#ffffff"), "#121212");
  });

  it("derives surface-readable accents for light and dark themes", () => {
    const pale = Appearance.deriveAccent({ accent: "custom", accentCustom: "#f5e6a8" }, "light");
    const paleRgb = Appearance.parseHex(pale.accentReadable);
    const lightSurface = Appearance.parseHex("#f4f4f5");
    assert.ok(Appearance.contrastRatio(paleRgb, lightSurface) >= 4.5);

    const darkish = Appearance.deriveAccent({ accent: "custom", accentCustom: "#1a3320" }, "dark");
    const darkRgb = Appearance.parseHex(darkish.accentReadable);
    const darkSurface = Appearance.parseHex("#121212");
    assert.ok(Appearance.contrastRatio(darkRgb, darkSurface) >= 4.5);

    assert.ok(pale.accentContrast);
    assert.ok(pale.focusRing.includes("rgba"));
  });
});

describe("density metrics", () => {
  it("returns fallbacks when computed style is unavailable", () => {
    assert.deepEqual(Appearance.readDensityMetrics(null, "comfortable"), {
      ...Appearance.DENSITY_FALLBACKS.comfortable,
      density: "comfortable"
    });
    assert.deepEqual(Appearance.readDensityMetrics(null, "compact"), {
      ...Appearance.DENSITY_FALLBACKS.compact,
      density: "compact"
    });
  });
});

describe("applyAppearance", () => {
  it("sets document attributes and CSS variables", () => {
    const props = {};
    const attrs = {};
    const root = {
      style: {
        colorScheme: "",
        setProperty(name, value) {
          props[name] = value;
        }
      },
      setAttribute(name, value) {
        attrs[name] = value;
      }
    };
    const result = Appearance.applyAppearance({
      theme: "light",
      accent: "coral",
      density: "compact",
      artworkAccents: false
    }, { root, matchMedia: () => ({ matches: true }) });

    assert.equal(result.resolvedTheme, "light");
    assert.equal(attrs["data-emp-theme"], "light");
    assert.equal(attrs["data-emp-density"], "compact");
    assert.equal(attrs["data-bs-theme"], "light");
    assert.equal(root.style.colorScheme, "light");
    assert.equal(props["--emp-accent"], "#f07167");
    assert.ok(props["--emp-accent-readable"]);
    assert.ok(props["--emp-accent-contrast"]);
    assert.ok(props["--emp-focus-ring"]);
  });

  it("bootFromSession applies stored appearance", () => {
    const attrs = {};
    const root = {
      style: { colorScheme: "", setProperty() {} },
      setAttribute(name, value) {
        attrs[name] = value;
      }
    };
    const storage = {
      getItem() {
        return JSON.stringify({ appearance: { theme: "light", density: "compact" } });
      }
    };
    Appearance.bootFromSession("emp.playback", {
      root,
      storage,
      matchMedia: () => ({ matches: true }),
      notifyHost: false
    });
    assert.equal(attrs["data-emp-theme"], "light");
    assert.equal(attrs["data-emp-density"], "compact");
  });

  it("notifies host chrome theme on apply", () => {
    const messages = [];
    const root = {
      style: { colorScheme: "", setProperty() {} },
      setAttribute() {}
    };
    Appearance.applyAppearance({ theme: "light" }, {
      root,
      matchMedia: () => ({ matches: true }),
      postMessage(message) {
        messages.push(message);
      }
    });
    assert.deepEqual(messages, [{ type: "chromeTheme", theme: "light" }]);
  });
});

describe("system theme listener", () => {
  it("invokes callback only when preference is system", () => {
    let listener = null;
    const mql = {
      matches: true,
      addEventListener(_type, fn) {
        listener = fn;
      },
      removeEventListener() {
        listener = null;
      }
    };
    let calls = 0;
    Appearance.bindSystemThemeListener(
      () => ({ theme: "system" }),
      () => {
        calls += 1;
      },
      () => mql
    );
    listener();
    assert.equal(calls, 1);

    Appearance.bindSystemThemeListener(
      () => ({ theme: "dark" }),
      () => {
        calls += 1;
      },
      () => mql
    );
    listener();
    assert.equal(calls, 1);
    Appearance.unbindSystemThemeListener();
  });
});

describe("reset defaults", () => {
  it("cloneDefaults matches reset target", () => {
    const dirty = Appearance.normalizeAppearance({
      theme: "light",
      accent: "custom",
      accentCustom: "#abcdef",
      density: "compact",
      artworkAccents: false
    });
    assert.notDeepEqual(dirty, Appearance.cloneDefaults());
    assert.deepEqual(Appearance.normalizeAppearance(Appearance.DEFAULTS), Appearance.cloneDefaults());
  });
});
