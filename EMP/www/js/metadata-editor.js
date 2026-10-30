(() => {
  const FIELD_KEYS = [
    "title",
    "artist",
    "albumArtist",
    "album",
    "trackNumber",
    "discNumber",
    "genre",
    "year",
    "comment"
  ];

  const COMMON_KEYS = ["album", "albumArtist", "artist", "genre", "year", "discNumber"];

  const FIELD_LABELS = {
    title: "Title",
    artist: "Artist",
    albumArtist: "Album artist",
    album: "Album",
    trackNumber: "Track number",
    discNumber: "Disc number",
    genre: "Genre",
    year: "Year",
    comment: "Comment",
    artwork: "Artwork"
  };

  const state = {
    open: false,
    mode: "single",
    step: "edit",
    batchTab: "common",
    requestId: null,
    tracks: [],
    drafts: new Map(),
    common: {},
    artworkPending: null,
    dirty: false,
    applying: false,
    progress: null,
    applySummary: null,
    lastFocus: null,
    confirmOpen: false,
    openFieldMenu: null
  };

  let root = null;
  let toastHost = null;
  let requestCounter = 0;
  const pendingGets = new Map();

  function nextRequestId(prefix) {
    requestCounter += 1;
    return `${prefix}-${Date.now()}-${requestCounter}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function fieldValue(track, key) {
    const field = track?.[key];
    if (!field || !field.hasEmbedded) {
      return "";
    }
    return field.value ?? "";
  }

  function placeholderFor(track, key) {
    if (track?.[key]?.hasEmbedded) {
      return "";
    }
    const labels = {
      title: "No embedded title",
      artist: "No embedded artist",
      albumArtist: "No embedded album artist",
      album: "No embedded album",
      comment: "Optional comment"
    };
    return labels[key] ?? "";
  }

  function ensureToastHost() {
    if (toastHost) {
      return toastHost;
    }
    toastHost = document.createElement("div");
    toastHost.className = "meta-toast-host";
    toastHost.setAttribute("aria-live", "polite");
    document.body.appendChild(toastHost);
    return toastHost;
  }

  function showToast(title, message, kind = "success") {
    const host = ensureToastHost();
    const toast = document.createElement("div");
    toast.className = `meta-toast meta-toast-${kind}`;
    toast.innerHTML = `
      <i class="bi ${kind === "error" ? "bi-exclamation-circle" : "bi-check-circle"}" aria-hidden="true"></i>
      <div class="meta-toast-body">
        <div class="meta-toast-title">${escapeHtml(title)}</div>
        ${message ? `<div class="meta-toast-msg">${escapeHtml(message)}</div>` : ""}
      </div>
    `;
    host.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 4200);
  }

  function ensureRoot() {
    if (root) {
      return root;
    }
    root = document.createElement("div");
    root.className = "meta-modal-root";
    root.hidden = true;
    root.innerHTML = `
      <div class="meta-modal" role="dialog" aria-modal="true" aria-labelledby="metaModalTitle" tabindex="-1">
        <div class="meta-modal-head">
          <h2 id="metaModalTitle">Edit metadata</h2>
          <button class="details-modal-close" type="button" data-meta-close aria-label="Close">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
        <div class="meta-modal-body" data-meta-body></div>
        <div class="meta-modal-foot" data-meta-foot></div>
        <div class="meta-confirm-root" data-meta-confirm-root hidden></div>
      </div>
    `;
    document.body.appendChild(root);

    root.addEventListener("click", (event) => {
      if (event.target === root) {
        requestClose();
      }
    });
    root.querySelector("[data-meta-close]").addEventListener("click", () => requestClose());
    root.addEventListener("keydown", onRootKeyDown);
    root.addEventListener("click", (event) => {
      if (!event.target.closest?.("[data-common-menu]") && !event.target.closest?.("[data-common-menu-btn]")) {
        closeFieldMenus();
      }
    });
    return root;
  }

  function confirmRoot() {
    return root?.querySelector("[data-meta-confirm-root]");
  }

  function onRootKeyDown(event) {
    if (!state.open) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (state.confirmOpen) {
        hideConfirm();
        return;
      }
      if (state.openFieldMenu) {
        closeFieldMenus();
        return;
      }
      if (state.step === "preview") {
        state.step = "edit";
        render();
        return;
      }
      requestClose();
      return;
    }
    if (state.confirmOpen) {
      if (event.key === "Tab") {
        trapFocus(event, confirmRoot()?.querySelector(".meta-confirm"));
      }
      return;
    }
    if (event.key === "Tab") {
      trapFocus(event, root?.querySelector(".meta-modal"));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!state.applying && state.step === "edit") {
        goPreview();
      }
    }
  }

  function trapFocus(event, container) {
    if (!container) {
      return;
    }
    const focusable = [...container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null);
    if (!focusable.length) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function showConfirm({
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    icon = "bi-exclamation-triangle",
    onConfirm
  }) {
    const layer = confirmRoot();
    if (!layer) {
      return;
    }
    state.confirmOpen = true;
    layer.hidden = false;
    layer.innerHTML = `
      <div class="meta-confirm" role="alertdialog" aria-modal="true" aria-labelledby="metaConfirmTitle" tabindex="-1">
        <div class="meta-confirm-icon" aria-hidden="true"><i class="bi ${icon}"></i></div>
        <h3 id="metaConfirmTitle">${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="meta-confirm-foot">
          <button class="meta-btn-secondary" type="button" data-meta-confirm-cancel>${escapeHtml(cancelLabel)}</button>
          <button class="${danger ? "meta-btn-danger" : "meta-btn-primary"}" type="button" data-meta-confirm-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    const dialog = layer.querySelector(".meta-confirm");
    layer.onclick = (event) => {
      if (event.target === layer) {
        hideConfirm();
      }
    };
    layer.querySelector("[data-meta-confirm-cancel]").onclick = () => hideConfirm();
    layer.querySelector("[data-meta-confirm-ok]").onclick = () => {
      hideConfirm();
      onConfirm?.();
    };
    dialog?.focus();
  }

  function showPrompt({ title, message, defaultValue = "", confirmLabel = "Apply", onConfirm }) {
    const layer = confirmRoot();
    if (!layer) {
      return;
    }
    state.confirmOpen = true;
    layer.hidden = false;
    layer.innerHTML = `
      <div class="meta-confirm meta-prompt" role="dialog" aria-modal="true" aria-labelledby="metaPromptTitle" tabindex="-1">
        <h3 id="metaPromptTitle">${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <input class="meta-input" type="number" min="0" max="9999" value="${escapeHtml(defaultValue)}" data-meta-prompt-input>
        <div class="meta-confirm-foot">
          <button class="meta-btn-secondary" type="button" data-meta-confirm-cancel>Cancel</button>
          <button class="meta-btn-primary" type="button" data-meta-confirm-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    const input = layer.querySelector("[data-meta-prompt-input]");
    layer.onclick = (event) => {
      if (event.target === layer) {
        hideConfirm();
      }
    };
    layer.querySelector("[data-meta-confirm-cancel]").onclick = () => hideConfirm();
    const submit = () => {
      const value = input.value;
      hideConfirm();
      onConfirm?.(value);
    };
    layer.querySelector("[data-meta-confirm-ok]").onclick = submit;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    input.focus();
    input.select();
  }

  function hideConfirm() {
    const layer = confirmRoot();
    if (!layer) {
      return;
    }
    state.confirmOpen = false;
    layer.hidden = true;
    layer.innerHTML = "";
    layer.onclick = null;
    root?.querySelector(".meta-modal")?.focus();
  }

  function requestClose() {
    if (state.applying || state.confirmOpen) {
      return;
    }
    if (state.dirty && state.step !== "done") {
      showConfirm({
        title: "Discard changes?",
        message: "You have unsaved metadata changes. Closing the editor will discard them.",
        cancelLabel: "Keep editing",
        confirmLabel: "Discard changes",
        danger: true,
        icon: "bi-exclamation-triangle",
        onConfirm: () => close()
      });
      return;
    }
    close();
  }

  function close() {
    if (!root) {
      return;
    }
    if (state.artworkPending?.previewUrl) {
      URL.revokeObjectURL(state.artworkPending.previewUrl);
    }
    hideConfirm();
    root.hidden = true;
    document.body.classList.remove("meta-modal-open");
    state.open = false;
    state.applying = false;
    state.dirty = false;
    state.step = "edit";
    state.batchTab = "common";
    state.artworkPending = null;
    state.applySummary = null;
    state.progress = null;
    state.openFieldMenu = null;
    const restore = state.lastFocus;
    state.lastFocus = null;
    if (restore && typeof restore.focus === "function") {
      restore.focus();
    }
  }

  function openEditor(trackIds) {
    const ids = [...new Set((trackIds || []).filter(Boolean))];
    if (!ids.length) {
      return;
    }
    ensureRoot();
    state.lastFocus = document.activeElement;
    state.open = true;
    state.mode = ids.length > 1 ? "batch" : "single";
    state.step = "edit";
    state.batchTab = "common";
    state.dirty = false;
    state.applying = false;
    state.tracks = [];
    state.drafts = new Map();
    state.common = Object.fromEntries(COMMON_KEYS.map((key) => [key, { op: "unchanged", value: "" }]));
    state.common.artwork = { op: "unchanged" };
    if (state.artworkPending?.previewUrl) {
      URL.revokeObjectURL(state.artworkPending.previewUrl);
    }
    state.artworkPending = null;
    state.applySummary = null;
    state.progress = null;
    state.openFieldMenu = null;
    document.body.classList.add("meta-modal-open");
    root.hidden = false;
    root.querySelector("[data-meta-body]").innerHTML = `<p class="meta-loading">Loading metadata…</p>`;
    root.querySelector("[data-meta-foot]").innerHTML = "";
    root.querySelector("#metaModalTitle").textContent =
      ids.length > 1 ? `Edit metadata (${ids.length} songs)` : "Edit metadata";

    const requestId = nextRequestId("meta-get");
    state.requestId = requestId;
    pendingGets.set(requestId, ids);
    window.chrome?.webview?.postMessage({ type: "metadataGet", requestId, trackIds: ids });
  }

  function handleHostMessage(message) {
    if (!message || !message.type) {
      return;
    }
    if (message.type === "metadataResult" && message.action === "get") {
      if (!pendingGets.has(message.requestId)) {
        return;
      }
      pendingGets.delete(message.requestId);
      state.tracks = Array.isArray(message.tracks) ? message.tracks : [];
      initializeDrafts();
      render();
      root?.querySelector(".meta-modal")?.focus();
      return;
    }
    if (message.type === "metadataProgress" && message.requestId === state.requestId) {
      state.progress = message;
      renderProgress();
      return;
    }
    if (message.type === "metadataApplied" && message.requestId === state.requestId) {
      state.applying = false;
      state.applySummary = message;
      state.step = "done";
      state.dirty = false;
      const failed = (message.files || []).filter((file) => !file.succeeded).length;
      if (!message.cancelled && failed === 0 && (message.succeeded || 0) > 0) {
        showToast(
          "Metadata updated",
          message.succeeded === 1
            ? "1 file was updated successfully."
            : `${message.succeeded} files were updated successfully.`
        );
      } else if (failed > 0) {
        showToast(
          "Some files could not be updated",
          `${failed} file${failed === 1 ? "" : "s"} failed. See details in the editor.`,
          "error"
        );
      }
      render();
    }
  }

  function initializeDrafts() {
    state.drafts = new Map();
    for (const track of state.tracks) {
      const draft = {};
      for (const key of FIELD_KEYS) {
        draft[key] = fieldValue(track, key);
      }
      draft._original = { ...draft };
      draft.expectedLastWriteUtcTicks = track.lastWriteUtcTicks;
      draft.expectedLength = track.length;
      state.drafts.set(track.trackId, draft);
    }

    if (state.mode === "batch") {
      for (const key of COMMON_KEYS) {
        const values = state.tracks.map((track) => fieldValue(track, key));
        const unique = [...new Set(values)];
        state.common[key] = {
          op: "unchanged",
          value: unique.length === 1 ? unique[0] : "",
          mixed: unique.length > 1
        };
      }
      const artStates = state.tracks.map((track) => Boolean(track.artwork?.present));
      const mixedArt = new Set(state.tracks.map((track) => track.artwork?.previewDataUrl || "")).size > 1
        || (artStates.some(Boolean) && artStates.some((value) => !value));
      state.common.artwork = {
        op: "unchanged",
        mixed: mixedArt
      };
    }
  }

  function render() {
    if (!root || !state.open) {
      return;
    }
    const body = root.querySelector("[data-meta-body]");
    const foot = root.querySelector("[data-meta-foot]");
    const title = root.querySelector("#metaModalTitle");
    root.querySelector(".meta-modal")?.classList.toggle("meta-modal-wide", state.mode === "batch");

    if (state.step === "done") {
      title.textContent = "Update complete";
      body.innerHTML = renderDone();
      foot.innerHTML = `<button class="meta-btn-primary details-save" type="button" data-meta-close-done>Done</button>`;
      foot.querySelector("[data-meta-close-done]").onclick = () => close();
      body.querySelector("[data-meta-retry]")?.addEventListener("click", () => {
        const failedIds = (state.applySummary?.files || [])
          .filter((file) => !file.succeeded)
          .map((file) => file.trackId);
        if (failedIds.length) {
          openEditor(failedIds);
        }
      });
      return;
    }

    if (state.step === "preview") {
      title.textContent = "Preview changes";
      body.innerHTML = renderPreview();
      foot.innerHTML = `
        <button class="meta-btn-secondary" type="button" data-meta-back>Back to editing</button>
        <button class="meta-btn-primary details-save" type="button" data-meta-apply ${state.applying ? "disabled" : ""}>Apply changes</button>
      `;
      foot.querySelector("[data-meta-back]").onclick = () => {
        state.step = "edit";
        render();
      };
      foot.querySelector("[data-meta-apply]").onclick = () => applyChanges();
      return;
    }

    if (state.applying) {
      title.textContent = "Updating metadata";
      body.innerHTML = renderProgressHtml();
      foot.innerHTML = `<button class="meta-btn-secondary" type="button" data-meta-cancel>Cancel</button>`;
      foot.querySelector("[data-meta-cancel]").onclick = () => {
        window.chrome?.webview?.postMessage({ type: "metadataCancel" });
      };
      return;
    }

    title.textContent = state.mode === "batch"
      ? `Edit metadata (${state.tracks.length} songs)`
      : "Edit metadata";

    if (!state.tracks.length) {
      body.innerHTML = `<p class="meta-error">No editable tracks were returned.</p>`;
      foot.innerHTML = `<button class="meta-btn-secondary" type="button" data-meta-close-done>Close</button>`;
      foot.querySelector("[data-meta-close-done]").onclick = () => close();
      return;
    }

    body.innerHTML = state.mode === "batch" ? renderBatch() : renderSingle();
    foot.innerHTML = `
      <button class="meta-btn-secondary" type="button" data-meta-cancel-edit>Cancel</button>
      <button class="meta-btn-primary details-save" type="button" data-meta-preview>Preview changes</button>
    `;
    foot.querySelector("[data-meta-cancel-edit]").onclick = () => requestClose();
    foot.querySelector("[data-meta-preview]").onclick = () => goPreview();
    bindEditHandlers(body);
  }

  function renderSingle() {
    const track = state.tracks[0];
    const draft = state.drafts.get(track.trackId) || {};
    const artUrl = state.artworkPending?.previewUrl
      || (state.artworkPending?.op === "clear" ? "" : track.artwork?.previewDataUrl)
      || "";
    const blocked = Boolean(track.errorCode);
    return `
      <div class="meta-single">
        <div class="meta-header-card">
          <div class="meta-art" data-meta-art>
            ${artUrl
              ? `<img src="${escapeHtml(artUrl)}" alt="">`
              : `<div class="meta-art-fallback"><i class="bi bi-music-note-beamed"></i></div>`}
          </div>
          <div class="meta-header-text">
            <div class="meta-header-title" title="${escapeHtml(track.displayTitle || track.fileName || "Unknown")}">${escapeHtml(track.displayTitle || track.fileName || "Unknown")}</div>
            <div class="meta-header-sub" title="${escapeHtml(track.displayArtist || "Unknown artist")}">${escapeHtml(track.displayArtist || "Unknown artist")}</div>
            <span class="meta-header-format">${escapeHtml((track.extension || "").replace(".", "").toUpperCase() || "FILE")}</span>
            ${blocked ? `<p class="meta-error">${escapeHtml(track.errorMessage || "Unavailable")}</p>` : ""}
            <div class="meta-art-actions">
              <button class="meta-btn-compact" type="button" data-meta-art-change ${blocked ? "disabled" : ""}>
                <i class="bi bi-image" aria-hidden="true"></i> Change
              </button>
              <button class="meta-btn-compact" type="button" data-meta-art-remove ${blocked ? "disabled" : ""}>
                <i class="bi bi-trash3" aria-hidden="true"></i> Remove
              </button>
              <button class="meta-btn-compact" type="button" data-meta-art-reset ${state.artworkPending ? "" : "hidden"}>
                Undo
              </button>
              <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" hidden data-meta-art-file>
            </div>
            ${track.albumCoverUrl && !track.artwork?.present
              ? `<p class="meta-hint">Album page artwork comes from the folder cover and may stay unchanged until every track is updated.</p>`
              : ""}
          </div>
        </div>

        <section class="meta-section">
          <h3 class="meta-section-label">Track information</h3>
          <div class="meta-fields">
            ${renderFieldInput("title", draft.title, placeholderFor(track, "title"), blocked, true)}
            ${renderFieldInput("artist", draft.artist, placeholderFor(track, "artist"), blocked)}
            ${renderFieldInput("trackNumber", draft.trackNumber, "", blocked)}
            ${renderFieldInput("discNumber", draft.discNumber, "", blocked)}
          </div>
        </section>

        <section class="meta-section">
          <h3 class="meta-section-label">Album information</h3>
          <div class="meta-fields">
            ${renderFieldInput("album", draft.album, placeholderFor(track, "album"), blocked)}
            ${renderFieldInput("albumArtist", draft.albumArtist, placeholderFor(track, "albumArtist"), blocked)}
            ${renderFieldInput("genre", draft.genre, "", blocked)}
            ${renderFieldInput("year", draft.year, "", blocked)}
          </div>
        </section>

        <section class="meta-section">
          <h3 class="meta-section-label">Additional information</h3>
          <div class="meta-fields">
            ${renderFieldInput("comment", draft.comment, placeholderFor(track, "comment"), blocked, true, true)}
          </div>
        </section>
      </div>
    `;
  }

  function renderFieldInput(key, value, placeholder, disabled, span = false, textarea = false) {
    const label = FIELD_LABELS[key];
    const type = ["trackNumber", "discNumber", "year"].includes(key) ? "number" : "text";
    const min = ["year", "trackNumber", "discNumber"].includes(key) ? `min="0" max="9999"` : "";
    const control = textarea
      ? `<textarea class="meta-input" rows="3" data-meta-field="${key}" placeholder="${escapeHtml(placeholder || "")}" ${disabled ? "disabled" : ""}>${escapeHtml(value ?? "")}</textarea>`
      : `<input class="meta-input" type="${type}" data-meta-field="${key}" value="${escapeHtml(value ?? "")}"
          placeholder="${escapeHtml(placeholder || "")}" ${disabled ? "disabled" : ""} ${min}>`;
    return `
      <label class="meta-field${span ? " meta-field-span" : ""}">
        <span>${label}</span>
        ${control}
      </label>
    `;
  }

  function renderBatch() {
    return `
      <div class="meta-batch">
        <div class="meta-tabs" role="tablist">
          <button class="meta-tab${state.batchTab === "common" ? " active" : ""}" type="button" data-meta-tab="common">Common fields</button>
          <button class="meta-tab${state.batchTab === "grid" ? " active" : ""}" type="button" data-meta-tab="grid">Track details</button>
        </div>
        <div data-meta-tab-panel="common" ${state.batchTab === "common" ? "" : "hidden"}>${renderCommonFields()}</div>
        <div data-meta-tab-panel="grid" ${state.batchTab === "grid" ? "" : "hidden"}>${renderGrid()}</div>
      </div>
    `;
  }

  function statusLabel(entry) {
    if (entry.op === "set") {
      return "Set";
    }
    if (entry.op === "clear") {
      return "Clear";
    }
    return "";
  }

  function renderCommonFields() {
    return `
      <div class="meta-common">
        ${COMMON_KEYS.map((key) => renderCommonField(key)).join("")}
        ${renderBatchArtwork()}
      </div>
    `;
  }

  function renderCommonField(key) {
    const entry = state.common[key] || { op: "unchanged", value: "", mixed: false };
    const label = FIELD_LABELS[key];
    const type = ["year", "discNumber"].includes(key) ? "number" : "text";
    const modified = entry.op !== "unchanged";
    const displayValue = entry.op === "clear"
      ? ""
      : (entry.op === "unchanged" && entry.mixed ? "" : entry.value || "");
    const placeholder = entry.op === "clear"
      ? "Will clear value"
      : (entry.op === "unchanged" && entry.mixed ? "Mixed values" : "");
    return `
      <div class="meta-common-row${modified ? " is-modified" : ""}" data-common-key="${key}">
        <div class="meta-common-row-head">
          <span>${label}</span>
          <div style="display:flex;align-items:center;gap:4px;">
            <span class="meta-common-status" ${modified ? "" : "hidden"}>${statusLabel(entry)}</span>
            <button class="meta-common-menu-btn" type="button" data-common-menu-btn="${key}" aria-label="Field actions" aria-expanded="false">
              <i class="bi bi-three-dots" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <input class="meta-input" type="${type}" data-common-input="${key}"
          value="${escapeHtml(displayValue)}"
          placeholder="${escapeHtml(placeholder)}" ${entry.op === "clear" ? "disabled" : ""}>
        ${entry.op === "unchanged" && entry.mixed ? `<div class="meta-mixed-hint">Mixed values — edit to set for all selected tracks</div>` : ""}
        <div class="meta-field-menu" data-common-menu="${key}" hidden>
          <button type="button" data-common-clear="${key}">Clear value</button>
          <button type="button" data-common-reset="${key}">Reset to unchanged</button>
        </div>
      </div>
    `;
  }

  function renderBatchArtwork() {
    const art = state.common.artwork || { op: "unchanged" };
    let thumb = "";
    if (state.artworkPending?.previewUrl) {
      thumb = `<img src="${escapeHtml(state.artworkPending.previewUrl)}" alt="">`;
    } else if (art.op === "clear") {
      thumb = `<div class="meta-art-thumb-fallback"><i class="bi bi-image"></i></div>`;
    } else {
      const firstArt = state.tracks.find((track) => track.artwork?.previewDataUrl)?.artwork?.previewDataUrl;
      thumb = firstArt && !art.mixed
        ? `<img src="${escapeHtml(firstArt)}" alt="">`
        : `<div class="meta-art-thumb-fallback"><i class="bi bi-images"></i></div>`;
    }

    let status = "Unchanged";
    if (art.op === "set") {
      status = "Pending replacement for all selected tracks";
    } else if (art.op === "clear") {
      status = "Pending removal for all selected tracks";
    } else if (art.mixed) {
      status = "Mixed artwork — leave unchanged unless you choose an action";
    } else if (state.tracks.some((track) => track.artwork?.present)) {
      status = "Shared artwork across selected tracks";
    } else {
      status = "No embedded artwork";
    }

    return `
      <div class="meta-art-row${art.op !== "unchanged" ? " is-modified" : ""}">
        <div class="meta-art-thumb">${thumb}</div>
        <div class="meta-art-row-text">
          <div class="meta-art-row-title">Artwork</div>
          <div class="meta-art-row-state">${escapeHtml(status)}</div>
        </div>
        <div class="meta-art-row-actions">
          <button class="meta-btn-compact" type="button" data-meta-art-change>
            <i class="bi bi-image" aria-hidden="true"></i> Change
          </button>
          <button class="meta-btn-compact" type="button" data-meta-art-remove>
            <i class="bi bi-trash3" aria-hidden="true"></i> Remove
          </button>
          <button class="meta-btn-compact" type="button" data-meta-art-reset ${art.op === "unchanged" ? "hidden" : ""}>Undo</button>
          <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" hidden data-meta-art-file>
        </div>
      </div>
    `;
  }

  function renderGrid() {
    return `
      <div class="meta-grid-toolbar">
        <button class="meta-btn-compact" type="button" data-meta-renumber>
          <i class="bi bi-list-ol" aria-hidden="true"></i> Renumber tracks
        </button>
      </div>
      <div class="meta-grid-wrap">
        <table class="meta-grid">
          <thead>
            <tr>
              <th>#</th><th>Disc</th><th>Title</th><th>Artist</th><th>Album</th><th>Genre</th><th>Year</th>
            </tr>
          </thead>
          <tbody>
            ${state.tracks.map((track) => {
              const draft = state.drafts.get(track.trackId) || {};
              const dirty = (key) => draft[key] !== draft._original?.[key] ? " meta-cell-dirty" : "";
              return `
                <tr data-grid-track="${escapeHtml(track.trackId)}">
                  <td><input class="meta-grid-input${dirty("trackNumber")}" data-grid-field="trackNumber" value="${escapeHtml(draft.trackNumber || "")}"></td>
                  <td><input class="meta-grid-input${dirty("discNumber")}" data-grid-field="discNumber" value="${escapeHtml(draft.discNumber || "")}"></td>
                  <td><input class="meta-grid-input${dirty("title")}" data-grid-field="title" value="${escapeHtml(draft.title || "")}"></td>
                  <td><input class="meta-grid-input${dirty("artist")}" data-grid-field="artist" value="${escapeHtml(draft.artist || "")}"></td>
                  <td><input class="meta-grid-input${dirty("album")}" data-grid-field="album" value="${escapeHtml(draft.album || "")}"></td>
                  <td><input class="meta-grid-input${dirty("genre")}" data-grid-field="genre" value="${escapeHtml(draft.genre || "")}"></td>
                  <td><input class="meta-grid-input${dirty("year")}" data-grid-field="year" value="${escapeHtml(draft.year || "")}"></td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function closeFieldMenus() {
    state.openFieldMenu = null;
    root?.querySelectorAll("[data-common-menu]").forEach((menu) => {
      menu.hidden = true;
    });
    root?.querySelectorAll("[data-common-menu-btn]").forEach((btn) => {
      btn.setAttribute("aria-expanded", "false");
    });
  }

  function bindEditHandlers(body) {
    body.querySelectorAll("[data-meta-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const track = state.tracks[0];
        const draft = state.drafts.get(track.trackId);
        if (!draft) {
          return;
        }
        draft[input.dataset.metaField] = input.value;
        state.dirty = true;
      });
    });

    body.querySelectorAll("[data-common-input]").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.dataset.commonInput;
        const previous = state.common[key] || {};
        state.common[key] = { op: "set", value: input.value, mixed: false };
        state.dirty = true;
        const row = body.querySelector(`[data-common-key="${key}"]`);
        row?.classList.add("is-modified");
        const status = row?.querySelector(".meta-common-status");
        if (status) {
          status.hidden = false;
          status.textContent = "Set";
        }
        const hint = row?.querySelector(".meta-mixed-hint");
        hint?.remove();
        if (previous.op === "clear") {
          input.disabled = false;
        }
      });
    });

    body.querySelectorAll("[data-common-menu-btn]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const key = btn.dataset.commonMenuBtn;
        const menu = body.querySelector(`[data-common-menu="${key}"]`);
        const wasOpen = menu && !menu.hidden;
        closeFieldMenus();
        if (!wasOpen && menu) {
          menu.hidden = false;
          btn.setAttribute("aria-expanded", "true");
          state.openFieldMenu = key;
        }
      });
    });

    body.querySelectorAll("[data-common-clear]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.commonClear;
        state.common[key] = { op: "clear", value: "", mixed: false };
        state.dirty = true;
        render();
      });
    });

    body.querySelectorAll("[data-common-reset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.commonReset;
        const values = state.tracks.map((track) => fieldValue(track, key));
        const unique = [...new Set(values)];
        state.common[key] = {
          op: "unchanged",
          value: unique.length === 1 ? unique[0] : "",
          mixed: unique.length > 1
        };
        state.dirty = true;
        render();
      });
    });

    body.querySelectorAll("[data-grid-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const row = input.closest("[data-grid-track]");
        const draft = state.drafts.get(row?.dataset.gridTrack);
        if (!draft) {
          return;
        }
        draft[input.dataset.gridField] = input.value;
        input.classList.toggle(
          "meta-cell-dirty",
          draft[input.dataset.gridField] !== draft._original?.[input.dataset.gridField]
        );
        state.dirty = true;
      });
    });

    body.querySelectorAll("[data-meta-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.batchTab = tab.dataset.metaTab;
        body.querySelectorAll("[data-meta-tab]").forEach((item) => {
          item.classList.toggle("active", item === tab);
        });
        body.querySelectorAll("[data-meta-tab-panel]").forEach((panel) => {
          panel.hidden = panel.dataset.metaTabPanel !== state.batchTab;
        });
      });
    });

    bindArtworkHandlers(body);

    body.querySelector("[data-meta-renumber]")?.addEventListener("click", () => {
      showPrompt({
        title: "Renumber tracks",
        message: "Choose a starting track number. Numbers are applied in the current grid order.",
        defaultValue: "1",
        confirmLabel: "Renumber",
        onConfirm: (startText) => {
          const start = Number.parseInt(startText, 10);
          if (!Number.isFinite(start) || start < 0) {
            showToast("Invalid number", "Enter a valid starting track number.", "error");
            return;
          }
          state.tracks.forEach((track, index) => {
            const draft = state.drafts.get(track.trackId);
            if (draft) {
              draft.trackNumber = String(start + index);
            }
          });
          state.dirty = true;
          state.batchTab = "grid";
          render();
        }
      });
    });
  }

  function bindArtworkHandlers(body) {
    const fileInput = body.querySelector("[data-meta-art-file]");
    body.querySelector("[data-meta-art-change]")?.addEventListener("click", () => fileInput?.click());
    body.querySelector("[data-meta-art-remove]")?.addEventListener("click", () => {
      if (state.artworkPending?.previewUrl) {
        URL.revokeObjectURL(state.artworkPending.previewUrl);
      }
      state.artworkPending = { op: "clear" };
      if (state.mode === "batch") {
        state.common.artwork = { op: "clear", mixed: false };
      }
      state.dirty = true;
      render();
    });
    body.querySelector("[data-meta-art-reset]")?.addEventListener("click", () => {
      if (state.artworkPending?.previewUrl) {
        URL.revokeObjectURL(state.artworkPending.previewUrl);
      }
      state.artworkPending = null;
      if (state.mode === "batch") {
        const artStates = state.tracks.map((track) => Boolean(track.artwork?.present));
        const mixedArt = new Set(state.tracks.map((track) => track.artwork?.previewDataUrl || "")).size > 1
          || (artStates.some(Boolean) && artStates.some((value) => !value));
        state.common.artwork = { op: "unchanged", mixed: mixedArt };
      }
      state.dirty = true;
      render();
    });
    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        return;
      }
      if (!/^image\/(jpeg|png)$/i.test(file.type) && !/\.(jpe?g|png)$/i.test(file.name)) {
        showToast("Unsupported image", "Choose a JPEG or PNG image.", "error");
        fileInput.value = "";
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        showToast("Image too large", "Image must be 10 MB or smaller.", "error");
        fileInput.value = "";
        return;
      }
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const dataBase64 = btoa(binary);
      if (state.artworkPending?.previewUrl) {
        URL.revokeObjectURL(state.artworkPending.previewUrl);
      }
      state.artworkPending = {
        op: "set",
        mime: file.type || (file.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg"),
        dataBase64,
        previewUrl: URL.createObjectURL(file)
      };
      if (state.mode === "batch") {
        state.common.artwork = { op: "set", mixed: false };
      }
      state.dirty = true;
      fileInput.value = "";
      render();
    });
  }

  function collectEdits() {
    const edits = [];
    if (state.mode === "single") {
      const track = state.tracks[0];
      const draft = state.drafts.get(track.trackId);
      if (!track || !draft) {
        return [];
      }
      const edit = {
        trackId: track.trackId,
        expectedLastWriteUtcTicks: draft.expectedLastWriteUtcTicks,
        expectedLength: draft.expectedLength
      };
      let changed = false;
      for (const key of FIELD_KEYS) {
        const original = draft._original?.[key] ?? "";
        const next = draft[key] ?? "";
        if (next !== original) {
          edit[key] = next === "" ? { op: "clear" } : { op: "set", value: next };
          changed = true;
        }
      }
      if (state.artworkPending?.op === "set") {
        edit.artwork = {
          op: "set",
          mime: state.artworkPending.mime,
          dataBase64: state.artworkPending.dataBase64
        };
        changed = true;
      } else if (state.artworkPending?.op === "clear") {
        edit.artwork = { op: "clear" };
        changed = true;
      }
      if (changed) {
        edits.push(edit);
      }
      return edits;
    }

    for (const track of state.tracks) {
      const draft = state.drafts.get(track.trackId);
      if (!draft) {
        continue;
      }
      const edit = {
        trackId: track.trackId,
        expectedLastWriteUtcTicks: draft.expectedLastWriteUtcTicks,
        expectedLength: draft.expectedLength
      };
      let changed = false;

      for (const key of COMMON_KEYS) {
        const common = state.common[key];
        if (common?.op === "set") {
          edit[key] = { op: "set", value: common.value ?? "" };
          changed = true;
        } else if (common?.op === "clear") {
          edit[key] = { op: "clear" };
          changed = true;
        }
      }

      for (const key of ["title", "trackNumber", "artist", "album", "genre", "year", "discNumber"]) {
        if (edit[key]) {
          continue;
        }
        const original = draft._original?.[key] ?? "";
        const next = draft[key] ?? "";
        if (next !== original) {
          edit[key] = next === "" ? { op: "clear" } : { op: "set", value: next };
          changed = true;
        }
      }

      if (state.common.artwork?.op === "set" && state.artworkPending?.op === "set") {
        edit.artwork = {
          op: "set",
          mime: state.artworkPending.mime,
          dataBase64: state.artworkPending.dataBase64
        };
        changed = true;
      } else if (state.common.artwork?.op === "clear") {
        edit.artwork = { op: "clear" };
        changed = true;
      }

      if (changed) {
        edits.push(edit);
      }
    }
    return edits;
  }

  function goPreview() {
    const edits = collectEdits();
    if (!edits.length) {
      showToast("No changes", "There are no metadata changes to preview.", "error");
      return;
    }
    state._previewEdits = edits;
    state.step = "preview";
    render();
  }

  function renderPreview() {
    const edits = state._previewEdits || [];
    if (state.mode === "single") {
      const track = state.tracks[0];
      const edit = edits[0];
      const rows = [];
      for (const key of FIELD_KEYS) {
        if (!edit?.[key] || edit[key].op === "keep") {
          continue;
        }
        const current = fieldValue(track, key) || "Empty";
        const next = edit[key].op === "clear" ? "Cleared" : edit[key].value;
        rows.push(`
          <tr>
            <td class="meta-preview-field">${escapeHtml(FIELD_LABELS[key] || key)}</td>
            <td class="meta-preview-old">${escapeHtml(current)}</td>
            <td class="meta-preview-new">${escapeHtml(next)}</td>
          </tr>
        `);
      }
      if (edit?.artwork) {
        rows.push(`
          <tr>
            <td class="meta-preview-field">Artwork</td>
            <td class="meta-preview-old">${track.artwork?.present ? "Present" : "None"}</td>
            <td class="meta-preview-new">${edit.artwork.op === "clear" ? "Remove" : "Replace"}</td>
          </tr>
        `);
      }
      return `
        <div class="meta-preview-summary">
          <span><strong>1</strong> file will be updated</span>
        </div>
        <table class="meta-preview-table">
          <thead><tr><th>Field</th><th>Current</th><th>New</th></tr></thead>
          <tbody>${rows.join("") || `<tr><td colspan="3">No changes</td></tr>`}</tbody>
        </table>
      `;
    }

    const fieldSet = new Set();
    let artworkOp = null;
    for (const edit of edits) {
      for (const key of FIELD_KEYS) {
        if (edit[key]) {
          fieldSet.add(FIELD_LABELS[key] || key);
        }
      }
      if (edit.artwork) {
        artworkOp = edit.artwork.op === "clear" ? "Remove artwork" : "Replace artwork";
        fieldSet.add("Artwork");
      }
    }

    return `
      <div class="meta-preview-summary">
        <span><strong>${edits.length}</strong> of <strong>${state.tracks.length}</strong> files will change</span>
        <span>Fields: <strong>${escapeHtml([...fieldSet].join(", ") || "None")}</strong></span>
        ${artworkOp ? `<span>${escapeHtml(artworkOp)}</span>` : ""}
      </div>
      <ul class="meta-preview-list">
        ${edits.map((edit) => {
          const track = state.tracks.find((item) => item.trackId === edit.trackId);
          const fields = Object.keys(edit)
            .filter((key) => FIELD_KEYS.includes(key) || key === "artwork")
            .map((key) => FIELD_LABELS[key] || key);
          return `<li>
            <strong>${escapeHtml(track?.fileName || edit.trackId)}</strong>
            <span>${escapeHtml(fields.join(" · "))}</span>
          </li>`;
        }).join("")}
      </ul>
    `;
  }

  function applyChanges() {
    const edits = state._previewEdits || collectEdits();
    if (!edits.length) {
      showToast("No changes", "There are no metadata changes to apply.", "error");
      return;
    }
    const requestId = nextRequestId("meta-apply");
    state.requestId = requestId;
    state.applying = true;
    state.step = "edit";
    state.progress = { completed: 0, total: edits.length, succeeded: 0, failed: 0 };
    render();
    window.chrome?.webview?.postMessage({
      type: "metadataApply",
      requestId,
      edits
    });
  }

  function renderProgressHtml() {
    const progress = state.progress || { completed: 0, total: 0, succeeded: 0, failed: 0 };
    const total = Math.max(1, progress.total || 1);
    const pct = Math.min(100, Math.round(((progress.completed || 0) / total) * 100));
    return `
      <div class="meta-progress">
        <p>Updating metadata — ${progress.completed || 0} of ${progress.total || 0} files</p>
        <div class="meta-progress-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
        <p class="meta-hint">${escapeHtml(progress.currentTitle || "")}</p>
        <p class="meta-hint">Succeeded: ${progress.succeeded || 0} · Failed: ${progress.failed || 0}</p>
      </div>
    `;
  }

  function renderProgress() {
    if (!state.applying) {
      return;
    }
    const body = root?.querySelector("[data-meta-body]");
    if (body) {
      body.innerHTML = renderProgressHtml();
    }
  }

  function renderDone() {
    const summary = state.applySummary || {};
    const files = Array.isArray(summary.files) ? summary.files : [];
    const failed = files.filter((file) => !file.succeeded);
    return `
      <div class="meta-done">
        <p>Updated <strong>${summary.succeeded || 0}</strong> of <strong>${summary.total || 0}</strong> files.
          ${summary.cancelled ? " Update cancelled." : ""}</p>
        ${summary.albumCoverRegenerated
          ? `<p class="meta-hint">Album artwork cache was refreshed for this album.</p>`
          : ""}
        ${failed.length
          ? `<div class="meta-fail-list"><p>Some files could not be updated:</p><ul>${
              failed.map((file) => {
                const track = state.tracks.find((item) => item.trackId === file.trackId);
                return `<li><strong>${escapeHtml(track?.fileName || file.trackId)}</strong> — ${escapeHtml(file.errorMessage || "Failed")}</li>`;
              }).join("")
            }</ul>
            <button class="meta-btn-compact" type="button" data-meta-retry>Retry failed files</button>
            </div>`
          : `<p class="meta-ok">All requested changes were applied.</p>`}
      </div>
    `;
  }

  window.addEventListener("emp-metadata", (event) => handleHostMessage(event.detail));

  window.EmpMetadataEditor = {
    open: openEditor,
    close: requestClose,
    isOpen: () => state.open
  };
})();
