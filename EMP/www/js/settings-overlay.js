(() => {
  const SECTIONS = Object.freeze([
    Object.freeze({
      group: "GENERAL",
      items: Object.freeze([
        Object.freeze({ id: "general", label: "General", icon: "bi-display" }),
        Object.freeze({ id: "home", label: "Home", icon: "bi-house" }),
        Object.freeze({ id: "library", label: "Library", icon: "bi-folder2" }),
        Object.freeze({ id: "appearance", label: "Appearance", icon: "bi-palette" }),
        Object.freeze({ id: "playback", label: "Playback", icon: "bi-play-fill" }),
        Object.freeze({ id: "audio", label: "Audio", icon: "bi-speaker" }),
        Object.freeze({ id: "equalizer", label: "Equalizer", icon: "bi-sliders" })
      ])
    }),
    Object.freeze({
      group: "YOUR MUSIC",
      items: Object.freeze([
        Object.freeze({ id: "listeningInsights", label: "Listening Insights", icon: "bi-bar-chart" })
      ])
    }),
    Object.freeze({
      group: "DATA",
      items: Object.freeze([
        Object.freeze({ id: "storage", label: "Storage", icon: "bi-database" })
      ])
    }),
    Object.freeze({
      group: "UPDATES",
      items: Object.freeze([
        Object.freeze({ id: "updates", label: "Updates", icon: "bi-download" }),
        Object.freeze({ id: "about", label: "About", icon: "bi-info-circle" })
      ])
    })
  ]);

  const SECTION_META = Object.freeze({
    general: Object.freeze({ title: "General", description: "Startup and window behaviour." }),
    home: Object.freeze({ title: "Home", description: "Choose what appears on your Home page and in what order." }),
    library: Object.freeze({ title: "Library", description: "Music folders EMP scans for your collection." }),
    appearance: Object.freeze({ title: "Appearance", description: "Customize how EMP looks and feels." }),
    playback: Object.freeze({ title: "Playback", description: "Control how EMP plays your music." }),
    audio: Object.freeze({ title: "Audio", description: "Choose a WASAPI playback device and how EMP opens it." }),
    equalizer: Object.freeze({ title: "Equalizer", description: "Adjust frequencies to fit your listening preferences." }),
    listeningInsights: Object.freeze({ title: "Listening Insights", description: "Private listening stats for the music you play in EMP." }),
    storage: Object.freeze({ title: "Storage", description: "How much space EMP uses on this computer." }),
    updates: Object.freeze({ title: "Updates", description: "Keep EMP up to date." }),
    about: Object.freeze({ title: "About", description: "EMP and the Sonora audio engine that powers local playback." })
  });

  const DEFAULT_SECTION = "general";
  const LEGACY_SECTION_MAP = Object.freeze({
    personalization: "general"
  });

  function isSettingsSection(id) {
    return Boolean(SECTION_META[id]);
  }

  function normalizeSettingsSection(id) {
    if (typeof id !== "string" || !id) {
      return DEFAULT_SECTION;
    }
    if (LEGACY_SECTION_MAP[id]) {
      return LEGACY_SECTION_MAP[id];
    }
    return isSettingsSection(id) ? id : DEFAULT_SECTION;
  }

  /** Avoid stacking duplicate settings history entries. */
  function shouldPushSettingsHistory(currentEntry) {
    return !currentEntry || currentEntry.view !== "settings";
  }

  function settingsHistoryEntry(section) {
    return { view: "settings", section: normalizeSettingsSection(section) };
  }

  /**
   * Resolve which pane to show when opening Settings.
   * fromHistory → history section; explicit section → that pane; else remembered.
   */
  function resolveOpenSettingsSection(section, { fromHistory = false, remembered } = {}) {
    if (fromHistory) {
      return normalizeSettingsSection(section);
    }
    if (typeof section === "string" && section.length) {
      return normalizeSettingsSection(section);
    }
    return normalizeSettingsSection(remembered);
  }

  const api = {
    SECTIONS,
    SECTION_META,
    DEFAULT_SECTION,
    isSettingsSection,
    normalizeSettingsSection,
    shouldPushSettingsHistory,
    settingsHistoryEntry,
    resolveOpenSettingsSection
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.EmpSettingsOverlay = api;
  }
})();
