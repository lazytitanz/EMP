/**
 * Smart Playlist editor modal — Metadata Editor / Settings visual language.
 * UI refinement: deferred validation, section hierarchy, preview states.
 */
(function (global) {
  "use strict";

  const sp = () => global.EmpSmartPlaylists;
  const PREVIEW_DEBOUNCE_MS = 300;

  let root = null;
  let draft = null;
  let baselineJson = "";
  let mode = "create";
  let editingId = null;
  let previewTimer = null;
  let previewSession = null;
  let showValidation = false;
  let touchedPaths = new Set();
  let activeTemplateId = null;
  let previewUpdating = false;
  /** @type {"auto"|"user"} Whether the name is still auto-generated from templates/defaults. */
  let nameOwnership = "auto";
  let lastAutoName = "";

  let hooks = {
    getContext: () => ({ tracks: [], albumsById: {}, listenStats: {}, likedIds: new Set(), now: Date.now() }),
    escapeHtml: (value) => String(value ?? ""),
    formatDuration: (seconds) => {
      const total = Math.max(0, Math.floor(Number(seconds) || 0));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    },
    coverUrl: () => "",
    onSave: () => {},
    confirmDiscard: (proceed) => proceed()
  };

  const FIELD_OPTIONS = [
    { value: "title", label: "Title" },
    { value: "artist", label: "Artist" },
    { value: "album", label: "Album" },
    { value: "albumArtist", label: "Album artist" },
    { value: "genre", label: "Genre" },
    { value: "year", label: "Year" },
    { value: "duration", label: "Duration (sec)" },
    { value: "format", label: "File format" },
    { value: "playCount", label: "Play count" },
    { value: "lastPlayed", label: "Last played" },
    { value: "neverPlayed", label: "Never played" },
    { value: "dateAdded", label: "Date added" },
    { value: "favorite", label: "Favorite" }
  ];

  const FIELD_PLACEHOLDERS = {
    title: "Enter a title",
    artist: "Enter an artist name",
    album: "Enter an album name",
    albumArtist: "Enter an album artist",
    genre: "Enter a genre",
    year: "Year",
    duration: "Seconds",
    playCount: "Number of plays",
    lastPlayed: "Number of days",
    dateAdded: "Number of days"
  };

  const OP_LABELS = {
    is: "Is",
    isNot: "Is not",
    contains: "Contains",
    doesNotContain: "Does not contain",
    startsWith: "Starts with",
    endsWith: "Ends with",
    eq: "Equals",
    neq: "Does not equal",
    gt: "Greater than",
    lt: "Less than",
    gte: "Greater than or equal",
    lte: "Less than or equal",
    withinLastDays: "Within the last",
    olderThanDays: "Older than",
    before: "Before",
    after: "After",
    never: "Never",
    isTrue: "Is true",
    isFalse: "Is false"
  };

  const SORT_OPTIONS = [
    { value: "title", label: "Title" },
    { value: "artist", label: "Artist" },
    { value: "album", label: "Album" },
    { value: "dateAdded", label: "Recently added" },
    { value: "playCount", label: "Most played" },
    { value: "lastPlayed", label: "Recently played" },
    { value: "random", label: "Random" }
  ];

  const LIMIT_OPTIONS = [
    { value: "", label: "No limit" },
    { value: "25", label: "25 songs" },
    { value: "50", label: "50 songs" },
    { value: "100", label: "100 songs" },
    { value: "250", label: "250 songs" },
    { value: "custom", label: "Custom…" }
  ];

  const SORT_DIR_OPTIONS = [
    { value: "asc", label: "Ascending" },
    { value: "desc", label: "Descending" }
  ];

  const GROUP_OP_OPTIONS = [
    { value: "all", label: "Match all" },
    { value: "any", label: "Match any" }
  ];

  const FORMAT_OPTIONS = ["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "wma", "aiff", "alac"]
    .map((fmt) => ({ value: fmt, label: fmt }));

  function configure(nextHooks) {
    hooks = { ...hooks, ...nextHooks };
  }

  function optionLabel(options, value) {
    return options.find((opt) => opt.value === value)?.label
      ?? options[0]?.label
      ?? String(value ?? "");
  }

  /** Settings-style custom dropdown (songs-sort pattern). */
  function customDropdownHtml({ key, value, options, ariaLabel, attrs = "" }) {
    const escape = hooks.escapeHtml;
    const current = optionLabel(options, value);
    const items = options.map((opt) => {
      const active = opt.value === value;
      return `
        <button class="songs-sort-item${active ? " active" : ""}" type="button" role="menuitemradio"
          aria-checked="${active ? "true" : "false"}" data-smart-dd-pick="${escape(opt.value)}">
          <span>${escape(opt.label)}</span>
          ${active ? '<i class="bi bi-check-lg" aria-hidden="true"></i>' : "<span></span>"}
        </button>`;
    }).join("");
    return `
      <div class="songs-sort-wrap smart-dd" data-smart-dd="${escape(key)}" data-value="${escape(value)}" ${attrs}>
        <button class="songs-sort-button" type="button" data-smart-dd-toggle aria-haspopup="menu" aria-expanded="false" aria-label="${escape(ariaLabel)}">
          <span data-smart-dd-label>${escape(current)}</span>
          <i class="bi bi-chevron-down" aria-hidden="true"></i>
        </button>
        <div class="songs-sort-menu smart-dd-menu" role="menu" hidden>${items}</div>
      </div>`;
  }

  function dropdownValue(selector) {
    const el = root?.querySelector(selector);
    if (!el) {
      return "";
    }
    return el.dataset.value ?? "";
  }

  function setDropdownValue(wrap, value, options) {
    if (!wrap) {
      return;
    }
    const escape = hooks.escapeHtml;
    wrap.dataset.value = value;
    const label = wrap.querySelector("[data-smart-dd-label]");
    if (label) {
      label.textContent = optionLabel(options, value);
    }
    const menu = wrap.querySelector(".smart-dd-menu");
    if (!menu || !options.length) {
      return;
    }
    menu.innerHTML = options.map((opt) => {
      const active = opt.value === value;
      return `
        <button class="songs-sort-item${active ? " active" : ""}" type="button" role="menuitemradio"
          aria-checked="${active ? "true" : "false"}" data-smart-dd-pick="${escape(opt.value)}">
          <span>${escape(opt.label)}</span>
          ${active ? '<i class="bi bi-check-lg" aria-hidden="true"></i>' : "<span></span>"}
        </button>`;
    }).join("");
  }

  function closeAllDropdowns(except = null) {
    root?.querySelectorAll(".smart-dd.is-open").forEach((wrap) => {
      if (except && wrap === except) {
        return;
      }
      wrap.classList.remove("is-open");
      const menu = wrap.querySelector(".smart-dd-menu");
      const button = wrap.querySelector("[data-smart-dd-toggle]");
      if (menu) {
        menu.hidden = true;
      }
      if (button) {
        button.setAttribute("aria-expanded", "false");
      }
    });
  }

  function toggleDropdown(wrap) {
    if (!wrap) {
      return;
    }
    const isOpen = wrap.classList.contains("is-open");
    closeAllDropdowns();
    if (isOpen) {
      return;
    }
    wrap.classList.add("is-open");
    const menu = wrap.querySelector(".smart-dd-menu");
    const button = wrap.querySelector("[data-smart-dd-toggle]");
    if (menu) {
      menu.hidden = false;
    }
    if (button) {
      button.setAttribute("aria-expanded", "true");
    }
  }

  function isDirty() {
    if (!draft) {
      return false;
    }
    return JSON.stringify(serializeDraft()) !== baselineJson;
  }

  function serializeDraft() {
    const api = sp();
    const name = root?.querySelector("[data-smart-name]")?.value ?? draft?.name ?? "";
    const description = root?.querySelector("[data-smart-desc]")?.value ?? draft?.description ?? "";
    const match = root?.querySelector("[data-smart-match]:checked")?.value === "any" ? "any" : "all";
    if (draft?.smart?.rules?.type === "group") {
      draft.smart.rules.op = match;
    }
    const sortField = dropdownValue("[data-smart-sort]") || "title";
    let direction = dropdownValue("[data-smart-sort-dir]") || "asc";
    if (sortField === "dateAdded" || sortField === "playCount" || sortField === "lastPlayed") {
      if (!root?.dataset.sortTouched) {
        direction = "desc";
      }
    }
    if (sortField === "random") {
      direction = "asc";
    }
    const limitSelect = dropdownValue("[data-smart-limit]");
    let limit = null;
    if (limitSelect === "custom") {
      const custom = Number(root?.querySelector("[data-smart-limit-custom]")?.value);
      limit = Number.isInteger(custom) && custom > 0 ? custom : null;
    } else if (limitSelect) {
      const parsed = Number(limitSelect);
      limit = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    let randomSeed = draft?.smart?.randomSeed ?? null;
    if (sortField === "random" && (randomSeed === null || randomSeed === undefined)) {
      randomSeed = api.newRandomSeed(name);
    }
    if (sortField !== "random") {
      randomSeed = null;
    }

    const smart = api.normalizeSmartDefinition({
      match,
      rules: draft.smart.rules,
      sort: { field: sortField, direction },
      limit,
      randomSeed,
      templatesHint: activeTemplateId || draft.smart.templatesHint || null
    });

    return {
      name: String(name).trim(),
      description: String(description).trim(),
      smart
    };
  }

  function markRuleTouched(path) {
    if (path !== undefined && path !== null && path !== "") {
      touchedPaths.add(String(path));
    }
  }

  function clearInteractionState() {
    showValidation = false;
    touchedPaths = new Set();
    activeTemplateId = null;
    previewUpdating = false;
  }

  function ensureRoot() {
    if (root) {
      return root;
    }

    root = document.createElement("div");
    root.className = "smart-modal-root";
    root.hidden = true;
    root.innerHTML = `
      <div class="smart-modal" role="dialog" aria-modal="true" aria-labelledby="smartModalTitle" aria-describedby="smartModalSubtitle">
        <div class="smart-modal-head">
          <div class="smart-modal-head-text">
            <h2 id="smartModalTitle">Create smart playlist</h2>
            <p class="smart-modal-subtitle" id="smartModalSubtitle">Build a playlist that updates automatically.</p>
          </div>
          <button class="smart-modal-close" type="button" data-smart-close aria-label="Close">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
        <div class="smart-modal-body">
          <section class="smart-section" aria-labelledby="smartDetailsHeading">
            <h3 class="smart-section-title" id="smartDetailsHeading">Playlist details</h3>
            <div class="smart-field-block">
              <label class="smart-field-label" for="smartPlaylistName">Name</label>
              <input class="smart-name" id="smartPlaylistName" type="text" maxlength="80" data-smart-name placeholder="Playlist name" autocomplete="off">
              <label class="smart-field-label" for="smartPlaylistDesc">Description <span class="smart-optional">Optional</span></label>
              <textarea class="smart-desc" id="smartPlaylistDesc" maxlength="300" rows="2" data-smart-desc placeholder="Add an optional description"></textarea>
            </div>
          </section>

          <section class="smart-section" aria-labelledby="smartTemplatesHeading">
            <div class="smart-section-title-row">
              <h3 class="smart-section-title" id="smartTemplatesHeading">Start from a template</h3>
              <span class="smart-optional">Optional</span>
            </div>
            <p class="smart-section-help">Choose a starting point. You can edit the rules afterward.</p>
            <div class="smart-templates" data-smart-templates role="list"></div>
          </section>

          <section class="smart-section" aria-labelledby="smartRulesHeading">
            <h3 class="smart-section-title" id="smartRulesHeading">Rules</h3>
            <div class="smart-match-row">
              <span class="smart-match-label" data-smart-match-copy>Include songs that match all of the following conditions.</span>
              <div class="smart-match-toggle" role="radiogroup" aria-label="Match mode">
                <label class="smart-seg"><input type="radio" name="smartMatch" value="all" data-smart-match checked> Match all</label>
                <label class="smart-seg"><input type="radio" name="smartMatch" value="any" data-smart-match> Match any</label>
              </div>
            </div>
            <div class="smart-rules" data-smart-rules></div>
            <div class="smart-rule-actions">
              <button class="smart-ghost-btn" type="button" data-smart-add-rule>
                <i class="bi bi-plus-lg" aria-hidden="true"></i>
                <span>Add rule</span>
              </button>
              <button class="smart-ghost-btn" type="button" data-smart-add-group>
                <i class="bi bi-collection" aria-hidden="true"></i>
                <span>Add group</span>
              </button>
            </div>
          </section>

          <section class="smart-section" aria-labelledby="smartOptionsHeading">
            <h3 class="smart-section-title" id="smartOptionsHeading">Playlist options</h3>
            <div class="smart-options-row" data-smart-options></div>
          </section>

          <section class="smart-section smart-section-preview" aria-labelledby="smartPreviewHeading">
            <div class="smart-preview-head">
              <h3 class="smart-section-title" id="smartPreviewHeading">Matching songs</h3>
              <span class="smart-preview-count" data-smart-match-count></span>
            </div>
            <p class="smart-preview-status" data-smart-preview-status hidden></p>
            <div class="smart-preview-list" data-smart-preview></div>
          </section>
        </div>
        <div class="smart-modal-foot">
          <button class="smart-btn-secondary" type="button" data-smart-cancel>Cancel</button>
          <button class="smart-btn-primary" type="button" data-smart-save>Create playlist</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    renderOptionsControls({ sort: "title", direction: "asc", limit: null });

    root.addEventListener("click", onRootClick);
    root.addEventListener("input", onRootInput);
    root.addEventListener("change", onRootChange);
    root.addEventListener("focusin", onRootFocusIn);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (root.querySelector(".smart-dd.is-open")) {
          closeAllDropdowns();
          return;
        }
        requestClose();
      }
    });

    return root;
  }

  function renderOptionsControls({ sort, direction, limit }) {
    const host = root.querySelector("[data-smart-options]");
    if (!host) {
      return;
    }
    const limitValue = limit === null || limit === undefined
      ? ""
      : ([25, 50, 100, 250].includes(limit) ? String(limit) : "custom");
    const customValue = limitValue === "custom" ? String(limit) : "";
    host.innerHTML = `
      <label class="smart-option">
        <span>Sort</span>
        ${customDropdownHtml({ key: "sort", value: sort, options: SORT_OPTIONS, ariaLabel: "Sort", attrs: 'data-smart-sort' })}
      </label>
      <label class="smart-option" data-smart-dir-wrap${sort === "random" ? " hidden" : ""}>
        <span>Order</span>
        ${customDropdownHtml({ key: "sort-dir", value: direction, options: SORT_DIR_OPTIONS, ariaLabel: "Order", attrs: 'data-smart-sort-dir' })}
      </label>
      <label class="smart-option">
        <span>Limit</span>
        ${customDropdownHtml({ key: "limit", value: limitValue, options: LIMIT_OPTIONS, ariaLabel: "Limit", attrs: 'data-smart-limit' })}
      </label>
      <label class="smart-option smart-option-custom" data-smart-limit-custom-wrap${limitValue === "custom" ? "" : " hidden"}>
        <span>Custom</span>
        <input type="number" min="1" step="1" data-smart-limit-custom value="${hooks.escapeHtml(customValue)}" aria-label="Custom track limit">
      </label>
    `;
  }

  function onRootFocusIn(event) {
    const row = event.target.closest("[data-rule-path]");
    if (row) {
      markRuleTouched(row.dataset.rulePath);
    }
  }

  function onRootClick(event) {
    if (event.target === root || event.target.closest("[data-smart-close]") || event.target.closest("[data-smart-cancel]")) {
      closeAllDropdowns();
      requestClose();
      return;
    }
    if (event.target.closest("[data-smart-save]")) {
      closeAllDropdowns();
      save();
      return;
    }

    const ddToggle = event.target.closest("[data-smart-dd-toggle]");
    if (ddToggle) {
      event.preventDefault();
      toggleDropdown(ddToggle.closest(".smart-dd"));
      return;
    }

    const ddPick = event.target.closest("[data-smart-dd-pick]");
    if (ddPick) {
      event.preventDefault();
      const wrap = ddPick.closest(".smart-dd");
      const value = ddPick.dataset.smartDdPick ?? "";
      handleDropdownPick(wrap, value);
      return;
    }

    if (!event.target.closest(".smart-dd")) {
      closeAllDropdowns();
    }

    if (event.target.closest("[data-smart-add-rule]")) {
      draft.smart.rules.children.push(sp().createEmptyRule());
      clearActiveTemplateIfModified();
      renderRules();
      schedulePreview();
      return;
    }
    if (event.target.closest("[data-smart-add-group]")) {
      draft.smart.rules.children.push(sp().createEmptyGroup("any"));
      clearActiveTemplateIfModified();
      renderRules();
      schedulePreview();
      return;
    }
    const templateBtn = event.target.closest("[data-smart-template]");
    if (templateBtn && !templateBtn.disabled) {
      applyTemplate(templateBtn.dataset.smartTemplate);
      return;
    }
    const removeRule = event.target.closest("[data-remove-rule]");
    if (removeRule) {
      removeAtPath(removeRule.dataset.removeRule);
      return;
    }
    const removeGroup = event.target.closest("[data-remove-group]");
    if (removeGroup) {
      removeAtPath(removeGroup.dataset.removeGroup);
      return;
    }
    const addNestedRule = event.target.closest("[data-add-nested-rule]");
    if (addNestedRule) {
      const group = nodeAtPath(addNestedRule.dataset.addNestedRule);
      if (group?.type === "group") {
        group.children.push(sp().createEmptyRule());
        clearActiveTemplateIfModified();
        renderRules();
        schedulePreview();
      }
    }
  }

  function optionsForDropdownKey(key) {
    switch (key) {
      case "sort":
        return SORT_OPTIONS;
      case "sort-dir":
        return SORT_DIR_OPTIONS;
      case "limit":
        return LIMIT_OPTIONS;
      case "rule-field":
        return FIELD_OPTIONS;
      case "group-op":
        return GROUP_OP_OPTIONS;
      case "format":
        return FORMAT_OPTIONS;
      case "rule-op":
        return [];
      default:
        return [];
    }
  }

  function handleDropdownPick(wrap, value) {
    if (!wrap) {
      return;
    }
    const key = wrap.dataset.smartDd;
    let options = optionsForDropdownKey(key);
    if (key === "rule-op") {
      const row = wrap.closest("[data-rule-path]");
      const field = row?.querySelector("[data-rule-field]")?.dataset.value || "artist";
      options = sp().operatorsForField(field).map((op) => ({ value: op, label: OP_LABELS[op] || op }));
    }
    setDropdownValue(wrap, value, options);
    closeAllDropdowns();

    if (wrap.matches("[data-smart-sort], [data-smart-sort-dir], [data-smart-limit]")) {
      if (wrap.matches("[data-smart-sort-dir]")) {
        root.dataset.sortTouched = "1";
      }
      if (wrap.matches("[data-smart-sort]") && value === "random") {
        draft.smart.randomSeed = sp().newRandomSeed(draft.name || "new");
      }
      clearActiveTemplateIfModified();
      syncLimitCustomVisibility();
      syncSortDirVisibility();
      schedulePreview();
      syncValidityUi();
      return;
    }

    const row = wrap.closest("[data-rule-path]");
    if (row) {
      markRuleTouched(row.dataset.rulePath);
    }
    syncRulesFromDom();
    clearActiveTemplateIfModified();
    renderRules();
    schedulePreview();
  }

  function refreshRuleInvalidState(row) {
    if (!row?.dataset.rulePath) {
      return;
    }
    syncRulesFromDom();
    const rule = nodeAtPath(row.dataset.rulePath);
    row.classList.toggle("is-invalid", shouldShowInvalid(row.dataset.rulePath, rule));
  }

  function onRootInput(event) {
    if (event.target.matches?.("[data-smart-name]")) {
      // Any manual edit (including clearing) takes ownership of the name.
      nameOwnership = "user";
      draft.name = event.target.value;
    }
    const row = event.target.closest("[data-rule-path]");
    if (row) {
      markRuleTouched(row.dataset.rulePath);
      clearActiveTemplateIfModified();
      refreshRuleInvalidState(row);
    }
    updateMatchCopy();
    schedulePreview();
    syncValidityUi();
  }

  function onRootChange(event) {
    if (event.target.matches("[data-smart-match]")) {
      const match = event.target.value === "any" ? "any" : "all";
      draft.smart.match = match;
      draft.smart.rules.op = match;
      clearActiveTemplateIfModified();
      updateMatchCopy();
      schedulePreview();
      return;
    }
    if (event.target.matches("[data-rule-value], [data-rule-days], [data-rule-date]")) {
      const row = event.target.closest("[data-rule-path]");
      if (row?.dataset.rulePath) {
        markRuleTouched(row.dataset.rulePath);
      }
      syncRulesFromDom();
      clearActiveTemplateIfModified();
      renderRules();
      schedulePreview();
      return;
    }
    if (event.target.matches("[data-smart-limit-custom]")) {
      clearActiveTemplateIfModified();
      schedulePreview();
      syncValidityUi();
    }
  }

  function pathParts(path) {
    return String(path || "").split(".").filter(Boolean).map((part) => Number(part));
  }

  function nodeAtPath(path) {
    let node = draft.smart.rules;
    for (const index of pathParts(path)) {
      node = node.children?.[index];
      if (!node) {
        return null;
      }
    }
    return node;
  }

  function removeAtPath(path) {
    const parts = pathParts(path);
    if (!parts.length) {
      return;
    }
    const index = parts.pop();
    let parent = draft.smart.rules;
    for (const part of parts) {
      parent = parent.children?.[part];
    }
    if (!parent?.children) {
      return;
    }
    parent.children.splice(index, 1);
    if (parent === draft.smart.rules && parent.children.length === 0) {
      parent.children.push(sp().createEmptyRule());
    }
    clearActiveTemplateIfModified();
    renderRules();
    schedulePreview();
  }

  function syncRulesFromDom() {
    root.querySelectorAll("[data-rule-path]").forEach((row) => {
      const path = row.dataset.rulePath;
      const rule = nodeAtPath(path);
      if (!rule || rule.type !== "rule") {
        return;
      }
      const field = row.querySelector("[data-rule-field]")?.dataset.value || rule.field;
      let op = row.querySelector("[data-rule-op]")?.dataset.value || rule.op;
      const allowed = sp().operatorsForField(field);
      if (!allowed.includes(op)) {
        op = allowed[0];
      }
      rule.field = field;
      rule.op = op;
      if (field === "neverPlayed" || field === "favorite" || op === "never" || op === "isTrue" || op === "isFalse") {
        rule.value = true;
        if (op === "never") {
          rule.value = null;
        }
      } else if (op === "withinLastDays" || op === "olderThanDays") {
        const days = Number(row.querySelector("[data-rule-days]")?.value);
        rule.value = { days: Number.isFinite(days) && days > 0 ? days : 30 };
      } else if (op === "before" || op === "after") {
        const dateStr = row.querySelector("[data-rule-date]")?.value;
        const at = dateStr ? Date.parse(`${dateStr}T00:00:00`) : NaN;
        rule.value = { at: Number.isFinite(at) ? at : Date.now() };
      } else if (field === "format") {
        rule.value = row.querySelector("[data-rule-format]")?.dataset.value || "mp3";
      } else if (sp().NUMBER_FIELDS.includes(field)) {
        const raw = row.querySelector("[data-rule-value]")?.value;
        const num = Number(raw);
        rule.value = raw === "" || !Number.isFinite(num) ? "" : num;
      } else {
        rule.value = row.querySelector("[data-rule-value]")?.value ?? "";
      }
    });

    root.querySelectorAll("[data-group-path]").forEach((row) => {
      const group = nodeAtPath(row.dataset.groupPath);
      if (group?.type === "group") {
        group.op = row.querySelector("[data-group-op]")?.dataset.value === "any" ? "any" : "all";
      }
    });
  }

  function ruleIsIncomplete(rule) {
    if (!rule || rule.type !== "rule") {
      return true;
    }
    try {
      const result = sp().validateSmartDefinition({
        match: "all",
        rules: { type: "group", op: "all", children: [rule] },
        sort: { field: "title", direction: "asc" },
        limit: null
      });
      return !result.ok;
    } catch {
      return true;
    }
  }

  function placeholderFor(rule) {
    if (rule.op === "withinLastDays" || rule.op === "olderThanDays") {
      return FIELD_PLACEHOLDERS.lastPlayed;
    }
    return FIELD_PLACEHOLDERS[rule.field] || "Enter a value";
  }

  function valueInputHtml(rule) {
    const escape = hooks.escapeHtml;
    const placeholder = escape(placeholderFor(rule));
    if (rule.field === "neverPlayed" || rule.op === "never" || rule.op === "isTrue" || rule.op === "isFalse") {
      return `<span class="smart-rule-value-static">No value needed</span>`;
    }
    if (rule.field === "favorite") {
      return `<span class="smart-rule-value-static">No value needed</span>`;
    }
    if (rule.op === "withinLastDays" || rule.op === "olderThanDays") {
      const days = rule.value?.days ?? "";
      return `<input class="smart-rule-value" type="number" min="1" step="1" data-rule-days value="${escape(days)}" placeholder="${placeholder}" aria-label="Days"><span class="smart-rule-suffix">days</span>`;
    }
    if (rule.op === "before" || rule.op === "after") {
      const at = Number(rule.value?.at) || Date.now();
      const d = new Date(at);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return `<input class="smart-rule-value" type="date" data-rule-date value="${escape(iso)}" aria-label="Date">`;
    }
    if (sp().NUMBER_FIELDS.includes(rule.field)) {
      const value = rule.value === "" || rule.value === null || rule.value === undefined ? "" : rule.value;
      return `<input class="smart-rule-value" type="number" data-rule-value value="${escape(value)}" placeholder="${placeholder}" aria-label="Value">`;
    }
    if (rule.field === "format") {
      const current = String(rule.value || "mp3").toLowerCase();
      return customDropdownHtml({
        key: "format",
        value: current,
        options: FORMAT_OPTIONS,
        ariaLabel: "Format",
        attrs: 'data-rule-format'
      });
    }
    return `<input class="smart-rule-value" type="text" data-rule-value value="${escape(rule.value ?? "")}" placeholder="${placeholder}" aria-label="Value" autocomplete="off">`;
  }

  function shouldShowInvalid(path, rule) {
    if (!ruleIsIncomplete(rule)) {
      return false;
    }
    return showValidation || touchedPaths.has(String(path));
  }

  function ruleRowHtml(rule, path) {
    const escape = hooks.escapeHtml;
    const invalid = shouldShowInvalid(path, rule);
    const opOptions = sp().operatorsForField(rule.field).map((op) => ({
      value: op,
      label: OP_LABELS[op] || op
    }));
    return `
      <div class="smart-rule-row${invalid ? " is-invalid" : ""}" data-rule-path="${escape(path)}">
        ${customDropdownHtml({ key: "rule-field", value: rule.field, options: FIELD_OPTIONS, ariaLabel: "Field", attrs: 'data-rule-field' })}
        ${customDropdownHtml({ key: "rule-op", value: rule.op, options: opOptions, ariaLabel: "Operator", attrs: 'data-rule-op' })}
        <div class="smart-rule-value-wrap">${valueInputHtml(rule)}</div>
        <button class="smart-icon-btn" type="button" data-remove-rule="${escape(path)}" aria-label="Remove rule">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    `;
  }

  function groupHtml(group, path, isRoot) {
    const escape = hooks.escapeHtml;
    const children = (group.children || []).map((child, index) => {
      const childPath = path ? `${path}.${index}` : String(index);
      if (child.type === "group") {
        return groupHtml(child, childPath, false);
      }
      return ruleRowHtml(child, childPath);
    }).join("");

    if (isRoot) {
      return `<div class="smart-rule-list">${children || `<div class="smart-rules-empty">Add a rule to define which songs belong in this playlist.</div>`}</div>`;
    }

    return `
      <div class="smart-rule-group" data-group-path="${escape(path)}">
        <div class="smart-group-head">
          ${customDropdownHtml({
            key: "group-op",
            value: group.op === "any" ? "any" : "all",
            options: GROUP_OP_OPTIONS,
            ariaLabel: "Group match mode",
            attrs: 'data-group-op'
          })}
          <button class="smart-ghost-btn smart-ghost-btn-sm" type="button" data-add-nested-rule="${escape(path)}">
            <i class="bi bi-plus-lg" aria-hidden="true"></i>
            <span>Add rule</span>
          </button>
          <button class="smart-icon-btn" type="button" data-remove-group="${escape(path)}" aria-label="Remove group">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
        <div class="smart-rule-list">${children}</div>
      </div>
    `;
  }

  function renderRules() {
    const host = root.querySelector("[data-smart-rules]");
    host.innerHTML = groupHtml(draft.smart.rules, "", true);
    syncValidityUi();
  }

  function updateMatchCopy() {
    const match = root.querySelector("[data-smart-match]:checked")?.value === "any" ? "any" : "all";
    const copy = root.querySelector("[data-smart-match-copy]");
    copy.textContent = match === "any"
      ? "Include songs that match any of the following conditions."
      : "Include songs that match all of the following conditions.";
  }

  function syncLimitCustomVisibility() {
    const value = dropdownValue("[data-smart-limit]");
    const wrap = root.querySelector("[data-smart-limit-custom-wrap]");
    if (wrap) {
      wrap.hidden = value !== "custom";
    }
  }

  function syncSortDirVisibility() {
    const field = dropdownValue("[data-smart-sort]");
    const wrap = root.querySelector("[data-smart-dir-wrap]");
    if (wrap) {
      wrap.hidden = field === "random";
    }
  }

  function syncValidityUi() {
    const payload = serializeDraft();
    const validation = sp().validateSmartDefinition(payload.smart);
    const saveBtn = root.querySelector("[data-smart-save]");
    const nameOk = Boolean(payload.name);
    saveBtn.disabled = !validation.ok || !nameOk;
  }

  function setPreviewState(state, detail = {}) {
    const countEl = root.querySelector("[data-smart-match-count]");
    const statusEl = root.querySelector("[data-smart-preview-status]");
    const list = root.querySelector("[data-smart-preview]");

    statusEl.hidden = true;
    statusEl.textContent = "";
    countEl.textContent = "";

    if (state === "incomplete") {
      statusEl.hidden = false;
      statusEl.textContent = "Complete your rules to preview matching songs.";
      list.innerHTML = "";
      return;
    }

    if (state === "updating") {
      statusEl.hidden = false;
      statusEl.textContent = "Updating matches…";
      return;
    }

    if (state === "empty") {
      const n = detail.totalMatches ?? 0;
      countEl.textContent = `${n} songs`;
      list.innerHTML = `
        <div class="smart-preview-empty">
          <strong>No matching songs</strong>
          <span>Try adjusting your rules to include more of your library.</span>
        </div>`;
      return;
    }

    if (state === "results") {
      const n = detail.totalMatches ?? 0;
      countEl.textContent = `${n} song${n === 1 ? "" : "s"}`;
      list.innerHTML = (detail.tracks || []).map((track) => {
        const cover = hooks.coverUrl(track);
        return `
          <div class="smart-preview-row">
            <span class="smart-preview-cover"${cover ? ` style="background-image:url('${cover}')"` : ""}></span>
            <span class="smart-preview-meta">
              <span class="smart-preview-title">${hooks.escapeHtml(track.title)}</span>
              <span class="smart-preview-sub">${hooks.escapeHtml(track.artist)} • ${hooks.escapeHtml(track.album)}</span>
            </span>
            <span class="smart-preview-dur">${hooks.escapeHtml(hooks.formatDuration(track.duration))}</span>
          </div>
        `;
      }).join("");
    }
  }

  function schedulePreview() {
    syncRulesFromDom();
    clearTimeout(previewTimer);
    const api = sp();
    if (!previewSession) {
      previewSession = api.createPreviewSession();
    }
    const gen = previewSession.next();
    const payload = serializeDraft();
    const validation = api.validateSmartDefinition(payload.smart);

    if (!validation.ok) {
      previewUpdating = false;
      setPreviewState("incomplete");
      syncValidityUi();
      return;
    }

    previewUpdating = true;
    setPreviewState("updating");

    previewTimer = setTimeout(() => {
      if (!previewSession.isCurrent(gen) || !root || root.hidden) {
        return;
      }
      const fresh = serializeDraft();
      const stillValid = api.validateSmartDefinition(fresh.smart);
      if (!stillValid.ok) {
        previewUpdating = false;
        setPreviewState("incomplete");
        syncValidityUi();
        return;
      }
      const preview = api.previewSmartPlaylist(fresh.smart, hooks.getContext());
      if (!previewSession.isCurrent(gen)) {
        return;
      }
      previewUpdating = false;
      if (!preview.tracks.length) {
        setPreviewState("empty", { totalMatches: preview.totalMatches });
      } else {
        setPreviewState("results", { totalMatches: preview.totalMatches, tracks: preview.tracks });
      }
      syncValidityUi();
    }, PREVIEW_DEBOUNCE_MS);
  }

  function clearActiveTemplateIfModified() {
    if (!activeTemplateId) {
      return;
    }
    // After a template is applied, any subsequent rule/option edit becomes a custom config.
    activeTemplateId = null;
    draft.smart.templatesHint = null;
    syncTemplateSelectionUi();
  }

  function syncTemplateSelectionUi() {
    root.querySelectorAll("[data-smart-template]").forEach((btn) => {
      const selected = Boolean(activeTemplateId) && btn.dataset.smartTemplate === activeTemplateId;
      btn.classList.toggle("is-selected", selected);
      btn.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function renderTemplates() {
    const host = root.querySelector("[data-smart-templates]");
    const context = hooks.getContext();
    const hasDateAdded = (context.tracks || []).some((t) => Number(t.dateAdded) > 0);
    const templates = sp().listTemplates({
      dateAdded: hasDateAdded,
      stats: true,
      liked: true
    }).map((entry) => {
      if (entry.id === "recently-added" && !hasDateAdded) {
        entry.enabled = false;
      }
      return entry;
    });
    host.innerHTML = templates.map((entry) => `
      <button class="smart-template-chip" type="button" role="listitem" data-smart-template="${entry.id}"
        ${entry.enabled ? "" : "disabled"}
        aria-pressed="false"
        title="${hooks.escapeHtml(entry.description)}">
        ${hooks.escapeHtml(entry.label)}
      </button>
    `).join("");
    syncTemplateSelectionUi();
  }

  function applyTemplate(id) {
    const entry = sp().listTemplates({ dateAdded: true, stats: true, liked: true }).find((t) => t.id === id);
    if (!entry) {
      return;
    }
    draft.smart = sp().normalizeSmartDefinition(entry.def);
    activeTemplateId = id;
    draft.smart.templatesHint = id;
    // Only replace the name while it is still auto-owned (create flow / unedited).
    if (nameOwnership === "auto") {
      const nameInput = root.querySelector("[data-smart-name]");
      draft.name = entry.label;
      lastAutoName = entry.label;
      if (nameInput) {
        nameInput.value = entry.label;
      }
    }
    showValidation = false;
    touchedPaths = new Set();
    fillControlsFromDraft();
    renderTemplates();
    renderRules();
    schedulePreview();
  }

  function fillControlsFromDraft() {
    const smart = draft.smart;
    root.querySelectorAll("[data-smart-match]").forEach((input) => {
      input.checked = input.value === smart.match;
    });
    delete root.dataset.sortTouched;
    renderOptionsControls({
      sort: smart.sort.field,
      direction: smart.sort.direction,
      limit: smart.limit
    });
    updateMatchCopy();
  }

  function openCreate(defaults = {}) {
    mode = "create";
    editingId = null;
    const api = sp();
    const name = defaults.name || "";
    draft = {
      name,
      description: defaults.description || "",
      smart: api.normalizeSmartDefinition(defaults.smart || api.createDefaultDefinition())
    };
    nameOwnership = "auto";
    lastAutoName = name;
    openModal("Create smart playlist", "Create playlist");
  }

  function openEdit(playlist) {
    mode = "edit";
    editingId = playlist.id;
    draft = {
      name: playlist.name || "",
      description: playlist.description || "",
      smart: sp().normalizeSmartDefinition(playlist.smart || sp().createDefaultDefinition())
    };
    // Existing playlists always keep their name; template/rule edits never auto-rename.
    nameOwnership = "user";
    lastAutoName = "";
    activeTemplateId = draft.smart.templatesHint || null;
    openModal("Edit smart playlist", "Save changes");
  }

  function openModal(title, saveLabel) {
    ensureRoot();
    clearInteractionState();
    if (mode === "edit" && draft.smart?.templatesHint) {
      activeTemplateId = draft.smart.templatesHint;
    }
    previewSession = sp().createPreviewSession();
    root.hidden = false;
    root.querySelector("#smartModalTitle").textContent = title;
    root.querySelector("[data-smart-save]").textContent = saveLabel;
    root.querySelector("[data-smart-name]").value = draft.name;
    root.querySelector("[data-smart-desc]").value = draft.description;
    fillControlsFromDraft();
    renderTemplates();
    renderRules();
    baselineJson = JSON.stringify(serializeDraft());
    schedulePreview();
    root.querySelector("[data-smart-name]").focus();
  }

  function requestClose() {
    if (!isDirty()) {
      close();
      return;
    }
    hooks.confirmDiscard(() => close());
  }

  function close() {
    clearTimeout(previewTimer);
    if (root) {
      root.hidden = true;
    }
    draft = null;
    editingId = null;
    clearInteractionState();
  }

  function save() {
    syncRulesFromDom();
    const payload = serializeDraft();
    const validation = sp().validateSmartDefinition(payload.smart);
    const nameOk = Boolean(payload.name);
    if (!validation.ok || !nameOk) {
      showValidation = true;
      // Mark all incomplete rule paths as touched so outlines appear.
      walkMarkIncomplete(draft.smart.rules, "");
      renderRules();
      schedulePreview();
      syncValidityUi();
      if (!nameOk) {
        root.querySelector("[data-smart-name]")?.focus();
      }
      return;
    }
    delete payload.smart.loadError;
    delete payload.smart.loadErrors;
    hooks.onSave({
      mode,
      playlistId: editingId,
      name: payload.name,
      description: payload.description,
      smart: payload.smart
    });
    baselineJson = JSON.stringify(payload);
    close();
  }

  function walkMarkIncomplete(node, path) {
    if (!node) {
      return;
    }
    if (node.type === "rule") {
      if (ruleIsIncomplete(node) && path !== "") {
        touchedPaths.add(path);
      }
      return;
    }
    (node.children || []).forEach((child, index) => {
      const childPath = path === "" ? String(index) : `${path}.${index}`;
      walkMarkIncomplete(child, childPath);
    });
  }

  function isOpen() {
    return Boolean(root && !root.hidden);
  }

  global.EmpSmartPlaylistEditor = {
    configure,
    openCreate,
    openEdit,
    close,
    isOpen,
    requestClose
  };
})(typeof window !== "undefined" ? window : globalThis);
