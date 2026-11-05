(() => {
  const RANGES = Object.freeze([
    Object.freeze({ id: "last7", label: "Last 7 days" }),
    Object.freeze({ id: "last30", label: "Last 30 days" }),
    Object.freeze({ id: "year", label: "This year" }),
    Object.freeze({ id: "all", label: "All time" })
  ]);

  let selectedRange = "last30";
  let requestSeq = 0;
  let latestRequestId = 0;
  let lastPayloadByRange = Object.create(null);
  let activePayload = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatListenTime(ms) {
    const totalMinutes = Math.max(0, Math.floor(Number(ms) / 60000) || 0);
    if (totalMinutes < 60) {
      return {
        primary: String(totalMinutes),
        unit: totalMinutes === 1 ? "minute" : "minutes",
        display: `${totalMinutes}m`,
        detail: `${totalMinutes} min`,
        minutesTotal: totalMinutes
      };
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return {
      primary: String(hours),
      unit: hours === 1 ? "hour" : "hours",
      display: minutes ? `${hours}h ${minutes}m` : `${hours}h`,
      detail: minutes ? `${hours} hr ${minutes} min` : `${hours} hr`,
      minutesTotal: totalMinutes
    };
  }

  function formatCompactDuration(ms) {
    return formatListenTime(ms).display;
  }

  function formatCoverageDate(yyyyMmDd) {
    const parts = String(yyyyMmDd || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      return yyyyMmDd;
    }
    return new Date(parts[0], parts[1] - 1, parts[2])
      .toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  function summaryRecordSvg() {
    return `
      <svg class="li-summary-art" viewBox="0 0 220 220" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="liRecordGlow" cx="50%" cy="45%" r="60%">
            <stop offset="0%" stop-color="#2ecc71" stop-opacity="0.35"/>
            <stop offset="55%" stop-color="#0d3d28" stop-opacity="0.5"/>
            <stop offset="100%" stop-color="#04140c" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle cx="110" cy="110" r="104" fill="url(#liRecordGlow)"/>
        <circle cx="110" cy="110" r="86" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="14"/>
        <circle cx="110" cy="110" r="68" fill="none" stroke="rgba(46,204,113,0.28)" stroke-width="10"/>
        <circle cx="110" cy="110" r="48" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="6"/>
        <circle cx="110" cy="110" r="18" fill="#0b1f14" stroke="rgba(46,204,113,0.65)" stroke-width="3"/>
        <circle cx="110" cy="110" r="5" fill="#2ecc71"/>
      </svg>`;
  }

  function emptyStateSvg() {
    return `
      <svg class="li-empty-art" viewBox="0 0 280 180" aria-hidden="true" focusable="false">
        <ellipse cx="140" cy="148" rx="78" ry="10" fill="rgba(255,255,255,0.04)"/>
        <rect x="78" y="48" width="124" height="88" rx="18" fill="#151515" stroke="rgba(255,255,255,0.08)"/>
        <circle cx="140" cy="92" r="28" fill="none" stroke="rgba(167,139,250,0.55)" stroke-width="4"/>
        <circle cx="140" cy="92" r="10" fill="rgba(167,139,250,0.85)"/>
        <path d="M178 68 v42 c0 10 8 16 18 13" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="4" stroke-linecap="round"/>
        <path d="M52 96 c18 -28 36 28 54 -8" fill="none" stroke="rgba(46,204,113,0.35)" stroke-width="3" stroke-linecap="round"/>
        <path d="M210 108 c16 -22 28 18 42 -6" fill="none" stroke="rgba(251,191,36,0.35)" stroke-width="3" stroke-linecap="round"/>
      </svg>`;
  }

  function streakSvg() {
    return `
      <svg class="li-habit-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <rect x="8" y="14" width="48" height="40" rx="8" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.1)"/>
        <circle cx="20" cy="30" r="3.5" fill="#2ecc71"/>
        <circle cx="32" cy="30" r="3.5" fill="#2ecc71"/>
        <circle cx="44" cy="30" r="3.5" fill="#2ecc71"/>
        <circle cx="20" cy="42" r="3.5" fill="#2ecc71"/>
        <circle cx="32" cy="42" r="3.5" fill="rgba(255,255,255,0.15)"/>
        <circle cx="44" cy="42" r="3.5" fill="rgba(255,255,255,0.15)"/>
      </svg>`;
  }

  function artPlaceholder(kind) {
    const accent = kind === "artist" ? "#a78bfa" : "#fbbf24";
    return `
      <div class="li-art-fallback" aria-hidden="true">
        <svg viewBox="0 0 80 80" focusable="false">
          <rect width="80" height="80" rx="12" fill="#141414"/>
          <circle cx="40" cy="40" r="18" fill="none" stroke="${accent}" stroke-opacity="0.45" stroke-width="3"/>
          <circle cx="40" cy="40" r="5" fill="${accent}" fill-opacity="0.9"/>
        </svg>
      </div>`;
  }

  function coverForTrackId(trackId, trackById, albumById) {
    if (!trackId || typeof trackById !== "function") {
      return null;
    }
    const track = trackById(trackId);
    if (!track) {
      return null;
    }
    if (track.coverUrl) {
      return track.coverUrl;
    }
    if (track.albumId && typeof albumById === "function") {
      return albumById(track.albumId)?.coverUrl || null;
    }
    return null;
  }

  function coverMarkup(url, className, kind) {
    if (!url) {
      return artPlaceholder(kind || "track");
    }
    return `<img class="${className}" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">`;
  }

  function artistCover(artist, sampleTrackIds, helpers, className) {
    const catalog = helpers.catalogArtists?.() || [];
    const match = catalog.find((item) =>
      String(item.name || "").localeCompare(artist, undefined, { sensitivity: "accent" }) === 0);
    if (match?.coverUrl) {
      return coverMarkup(match.coverUrl, className || "li-cover", "artist");
    }
    for (const id of sampleTrackIds || []) {
      const url = coverForTrackId(id, helpers.trackById, helpers.albumById);
      if (url) {
        return coverMarkup(url, className || "li-cover", "artist");
      }
    }
    return artPlaceholder("artist");
  }

  function renderIntro() {
    return `
      <header class="li-intro">
        <h2 class="li-intro-title">Your music tells a story.</h2>
        <p class="li-intro-lead">Explore the artists, tracks, and moments that shaped your listening.</p>
      </header>`;
  }

  function renderRangeControl(payload) {
    const coverage = renderCoverageNote(payload);
    return `
      <div class="li-toolbar">
        <div class="li-segment" role="tablist" aria-label="Listening period">
          ${RANGES.map((range) => `
            <button class="li-segment-btn${selectedRange === range.id ? " is-active" : ""}"
              type="button"
              role="tab"
              aria-selected="${selectedRange === range.id ? "true" : "false"}"
              data-insights-range="${range.id}">${escapeHtml(range.label)}</button>
          `).join("")}
        </div>
        ${coverage}
      </div>`;
  }

  function renderCoverageNote(payload) {
    if (!payload) {
      return "";
    }
    if (payload.historyCoverage === "partial" && payload.historyCoverageStartDate) {
      return `<p class="li-coverage">History since ${escapeHtml(formatCoverageDate(payload.historyCoverageStartDate))}</p>`;
    }
    if (payload.range !== "all" && !payload.hasDailyData && payload.hasLifetimeData) {
      return `<p class="li-coverage">Daily history needed for this period · <button type="button" class="li-text-btn" data-insights-range="all">View all time</button></p>`;
    }
    if (payload.activityScopeLabel && payload.range === "all") {
      return `<p class="li-coverage">${escapeHtml(payload.activityScopeLabel)}</p>`;
    }
    return "";
  }

  function renderLoading() {
    return `
      <div class="li-loading" aria-busy="true" aria-live="polite">
        <div class="li-skeleton li-skeleton-hero"></div>
        <div class="li-skeleton-row">
          <div class="li-skeleton li-skeleton-card"></div>
          <div class="li-skeleton li-skeleton-card"></div>
        </div>
        <p class="li-coverage">Loading your listening story…</p>
      </div>`;
  }

  function renderEmpty() {
    return `
      <div class="li-empty">
        ${emptyStateSvg()}
        <h3>Your listening story starts here.</h3>
        <p>Play some music and EMP will start building your listening insights.</p>
        <button class="li-cta" type="button" data-insights-browse-library>Browse library</button>
      </div>`;
  }

  function renderSummary(payload) {
    const time = formatListenTime(payload.totalListenMs);
    const showArtists = payload.artistRankingCoverage !== "unavailable";
    const artistNote = payload.artistRankingCoverage === "partial" && payload.tracksWithoutArtist > 0
      ? `<p class="li-footnote">Artist rankings exclude ${escapeHtml(String(payload.tracksWithoutArtist))} track${payload.tracksWithoutArtist === 1 ? "" : "s"} without artist metadata.</p>`
      : "";
    return `
      <section class="li-summary" aria-label="Listening summary">
        <div class="li-summary-main">
          <p class="li-eyebrow">Time spent listening</p>
          <p class="li-display">${escapeHtml(time.display)}</p>
          <div class="li-summary-stats">
            <div class="li-metric">
              <strong>${escapeHtml(String(payload.totalPlays || 0))}</strong>
              <span>Plays</span>
            </div>
            <div class="li-metric">
              <strong>${escapeHtml(String(payload.uniqueTracks || 0))}</strong>
              <span>Tracks</span>
            </div>
            ${showArtists ? `
            <div class="li-metric">
              <strong>${escapeHtml(String(payload.uniqueArtists || 0))}</strong>
              <span>Artists</span>
            </div>` : ""}
          </div>
          ${artistNote}
        </div>
        <div class="li-summary-visual" aria-hidden="true">${summaryRecordSvg()}</div>
      </section>`;
  }

  function renderTopArtists(payload, helpers) {
    const artists = Array.isArray(payload.topArtists) ? payload.topArtists : [];
    if (payload.artistRankingCoverage === "unavailable" || !artists.length) {
      return `
        <section class="li-section li-section-artists">
          <div class="li-section-head">
            <p class="li-eyebrow">Top artists</p>
            <h3>Who you kept coming back to</h3>
          </div>
          <p class="li-coverage">Not enough artist metadata to rank artists for this period.</p>
        </section>`;
    }
    const [first, ...rest] = artists;
    return `
      <section class="li-section li-section-artists">
        <div class="li-section-head">
          <p class="li-eyebrow">Top artists</p>
          <h3>Who you kept coming back to</h3>
        </div>
        <article class="li-artist-hero">
          <div class="li-artist-hero-art">${artistCover(first.artistName, first.sampleTrackIds, helpers, "li-cover")}</div>
          <div class="li-artist-hero-copy">
            <span class="li-badge">#1</span>
            <h4>${escapeHtml(first.artistName)}</h4>
            <p class="li-hero-meta">${escapeHtml(formatCompactDuration(first.listenMs))}</p>
            <p class="li-hero-sub">${escapeHtml(String(first.playCount || 0))} qualified plays</p>
          </div>
        </article>
        <div class="li-artist-grid">
          ${rest.map((artist, index) => `
            <article class="li-artist-card">
              <span class="li-rank">#${index + 2}</span>
              <div class="li-artist-card-art">${artistCover(artist.artistName, artist.sampleTrackIds, helpers, "li-cover")}</div>
              <div class="li-artist-card-copy">
                <h4>${escapeHtml(artist.artistName)}</h4>
                <p>${escapeHtml(formatCompactDuration(artist.listenMs))} · ${escapeHtml(String(artist.playCount || 0))} plays</p>
              </div>
            </article>
          `).join("")}
        </div>
      </section>`;
  }

  function renderTopTracks(payload, helpers) {
    const tracks = Array.isArray(payload.topTracks) ? payload.topTracks : [];
    if (!tracks.length) {
      return `
        <section class="li-section li-section-tracks">
          <div class="li-section-head">
            <p class="li-eyebrow">Top tracks</p>
            <h3>Songs that defined the period</h3>
          </div>
          <p class="li-coverage">No track rankings for this period yet.</p>
        </section>`;
    }
    const [first, ...rest] = tracks;
    const firstUrl = coverForTrackId(first.trackId, helpers.trackById, helpers.albumById);
    const firstPlayable = Boolean(first.inLibrary && helpers.trackById?.(first.trackId));
    return `
      <section class="li-section li-section-tracks">
        <div class="li-section-head">
          <p class="li-eyebrow">Top tracks</p>
          <h3>Songs that defined the period</h3>
        </div>
        <article class="li-track-hero${firstPlayable ? " is-playable" : ""}">
          <div class="li-track-hero-art">${coverMarkup(firstUrl, "li-cover", "track")}</div>
          <div class="li-track-hero-copy">
            <span class="li-badge li-badge-amber">#1</span>
            <h4>${escapeHtml(first.title)}</h4>
            <p>${escapeHtml(first.artist)}</p>
            <p class="li-hero-meta">${escapeHtml(formatCompactDuration(first.listenMs))} · ${escapeHtml(String(first.playCount || 0))} plays</p>
          </div>
          ${firstPlayable
            ? `<button class="li-play li-play-lg" type="button" data-insights-play="${escapeHtml(first.trackId)}" aria-label="Play ${escapeHtml(first.title)}"><i class="bi bi-play-fill" aria-hidden="true"></i></button>`
            : ""}
        </article>
        <ol class="li-track-list">
          ${rest.map((track, index) => {
            const url = coverForTrackId(track.trackId, helpers.trackById, helpers.albumById);
            const playable = Boolean(track.inLibrary && helpers.trackById?.(track.trackId));
            return `
              <li class="li-track-row${playable ? " is-playable" : ""}">
                <span class="li-rank">${index + 2}</span>
                <div class="li-track-row-art">${coverMarkup(url, "li-cover", "track")}</div>
                <div class="li-track-row-copy">
                  <h4>${escapeHtml(track.title)}</h4>
                  <p>${escapeHtml(track.artist)}</p>
                </div>
                <div class="li-track-row-meta">
                  <span>${escapeHtml(formatCompactDuration(track.listenMs))}</span>
                  <span>${escapeHtml(String(track.playCount || 0))} plays</span>
                </div>
                ${playable
                  ? `<button class="li-play" type="button" data-insights-play="${escapeHtml(track.trackId)}" aria-label="Play ${escapeHtml(track.title)}"><i class="bi bi-play-fill" aria-hidden="true"></i></button>`
                  : `<span class="li-play-spacer" aria-hidden="true"></span>`}
              </li>`;
          }).join("")}
        </ol>
      </section>`;
  }

  function renderActivity(payload) {
    const points = Array.isArray(payload.activity) ? payload.activity : [];
    if (!points.length) {
      return `
        <section class="li-section li-section-activity">
          <div class="li-section-head">
            <p class="li-eyebrow">Listening activity</p>
            <h3>How your listening moved</h3>
          </div>
          <p class="li-coverage">${payload.range === "all" && payload.hasLifetimeData
            ? "Daily activity charts appear once EMP has collected daily listening history."
            : "No activity to chart for this period."}</p>
        </section>`;
    }

    const values = points.map((p) => Number(p.listenMs) || 0);
    const max = Math.max(1, ...values);
    const peakIndex = values.indexOf(Math.max(...values));
    const summary = points.map((p) => `${p.label}: ${formatCompactDuration(p.listenMs)}`).join(". ");
    const count = points.length;
    const width = 640;
    const height = 168;
    const padX = 8;
    const padBottom = 28;
    const chartH = height - padBottom;
    const slot = (width - padX * 2) / count;
    const barW = Math.max(6, Math.min(22, slot * 0.55));

    const bars = points.map((point, index) => {
      const value = values[index];
      const h = value > 0 ? Math.max(6, Math.round((value / max) * (chartH - 8))) : 0;
      const x = padX + index * slot + (slot - barW) / 2;
      const y = chartH - h;
      const isPeak = index === peakIndex && value > 0;
      const showLabel = count <= 14 || index === 0 || index === count - 1 || index % Math.ceil(count / 6) === 0;
      return `
        <g class="li-bar${isPeak ? " is-peak" : ""}" tabindex="0" role="img"
          aria-label="${escapeHtml(`${point.label}: ${formatCompactDuration(value)}`)}">
          <title>${escapeHtml(`${point.label}: ${formatCompactDuration(value)}`)}</title>
          <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${Math.min(6, barW / 2)}"
            fill="${isPeak ? "#5eead4" : value > 0 ? "#1db954" : "rgba(255,255,255,0.06)"}"></rect>
          ${showLabel ? `<text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle" class="li-bar-label">${escapeHtml(String(point.label).split(" ")[0])}</text>` : ""}
        </g>`;
    }).join("");

    return `
      <section class="li-section li-section-activity">
        <div class="li-section-head">
          <p class="li-eyebrow">Listening activity</p>
          <h3>How your listening moved</h3>
        </div>
        ${payload.activityScopeLabel ? `<p class="li-coverage">${escapeHtml(payload.activityScopeLabel)}</p>` : ""}
        <div class="li-chart-wrap" role="img" aria-label="${escapeHtml(summary)}">
          <svg class="li-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
            ${bars}
          </svg>
        </div>
      </section>`;
  }

  function habitCard(habit, helpers, payload) {
    const id = habit.id || "";
    if (id === "onRepeat") {
      const url = coverForTrackId(habit.trackId, helpers.trackById, helpers.albumById);
      return `
        <article class="li-habit li-habit-repeat">
          <p class="li-habit-label">On repeat</p>
          <div class="li-habit-repeat-body">
            <div class="li-habit-art">${coverMarkup(url, "li-cover", "track")}</div>
            <div>
              <h4>${escapeHtml(habit.body.split(" — ")[0] || habit.body)}</h4>
              <p>${escapeHtml(habit.body.includes(" — ") ? habit.body.split(" — ").slice(1).join(" — ") : "")}</p>
            </div>
          </div>
        </article>`;
    }
    if (id === "mostActiveDay") {
      return `
        <article class="li-habit li-habit-day">
          <p class="li-habit-label">Most active day</p>
          <h4>${escapeHtml(habit.body.split(" · ")[0] || habit.body)}</h4>
          <p>${escapeHtml(habit.body.includes(" · ") ? habit.body.split(" · ").slice(1).join(" · ") : "")}</p>
        </article>`;
    }
    if (id === "favoriteArtist") {
      const samples = payload?.topArtists?.[0]?.sampleTrackIds || [];
      return `
        <article class="li-habit li-habit-artist">
          <p class="li-habit-label">Favorite artist</p>
          <div class="li-habit-artist-body">
            <div class="li-habit-art is-round">${artistCover(habit.artistName || "", samples, helpers, "li-cover")}</div>
            <div>
              <h4>${escapeHtml(habit.artistName || habit.body)}</h4>
              <p>${escapeHtml(habit.body.includes(" · ") ? habit.body.split(" · ").slice(1).join(" · ") : habit.body)}</p>
            </div>
          </div>
        </article>`;
    }
    if (id === "listeningStreak") {
      return `
        <article class="li-habit li-habit-streak">
          <div class="li-habit-streak-top">
            <p class="li-habit-label">Listening streak</p>
            ${streakSvg()}
          </div>
          <h4>${escapeHtml(habit.body)}</h4>
        </article>`;
    }
    if (id === "deepCuts") {
      const url = coverForTrackId(habit.trackId, helpers.trackById, helpers.albumById);
      return `
        <article class="li-habit li-habit-deep">
          <p class="li-habit-label">Deep cuts</p>
          <div class="li-habit-repeat-body">
            <div class="li-habit-art">${coverMarkup(url, "li-cover", "track")}</div>
            <div>
              <h4>${escapeHtml(habit.body)}</h4>
            </div>
          </div>
        </article>`;
    }
    return `
      <article class="li-habit">
        <p class="li-habit-label">${escapeHtml(habit.title)}</p>
        <h4>${escapeHtml(habit.body)}</h4>
      </article>`;
  }

  function renderHabits(payload, helpers) {
    const habits = Array.isArray(payload.habits) ? payload.habits : [];
    if (!habits.length) {
      return "";
    }
    return `
      <section class="li-section li-section-habits">
        <div class="li-section-head">
          <p class="li-eyebrow">Your listening habits</p>
          <h3>Moments worth noticing</h3>
        </div>
        <div class="li-habits">
          ${habits.map((habit) => habitCard(habit, helpers, payload)).join("")}
        </div>
      </section>`;
  }

  function privacyNote() {
    return `
      <footer class="li-privacy">
        <i class="bi bi-shield-lock" aria-hidden="true"></i>
        <div>
          <strong>Private by design</strong>
          <p>Your listening history stays on this computer. No account, cloud analytics, or scrobbling service required.</p>
        </div>
      </footer>`;
  }

  function renderShell(payload, helpers) {
    if (payload?.showGenericEmpty) {
      return `
        <section class="settings-group settings-insights li-page">
          ${renderIntro()}
          ${renderRangeControl(payload)}
          ${renderEmpty()}
          ${privacyNote()}
        </section>`;
    }

    const hasContent = payload
      && (payload.totalListenMs > 0 || payload.totalPlays > 0 || payload.hasLifetimeData || payload.hasDailyData);

    return `
      <section class="settings-group settings-insights li-page">
        ${renderIntro()}
        ${renderRangeControl(payload)}
        ${!payload ? renderLoading() : ""}
        ${hasContent ? renderSummary(payload) : ""}
        ${hasContent ? renderTopArtists(payload, helpers) : ""}
        ${hasContent ? renderTopTracks(payload, helpers) : ""}
        ${hasContent ? renderActivity(payload) : ""}
        ${hasContent ? renderHabits(payload, helpers) : ""}
        ${payload && !hasContent && !payload.showGenericEmpty
          ? `<p class="li-coverage">No listening in this period yet. Keep playing — or try All time.</p>`
          : ""}
        ${privacyNote()}
      </section>`;
  }

  function isInsightsActive(ctx) {
    return Boolean(ctx?.settingsOpen) && ctx?.settingsSection === "listeningInsights";
  }

  function requestInsights(rangeId) {
    selectedRange = RANGES.some((r) => r.id === rangeId) ? rangeId : "last30";
    requestSeq += 1;
    latestRequestId = requestSeq;
    const cached = lastPayloadByRange[selectedRange];
    if (cached) {
      activePayload = cached;
    }
    if (typeof window !== "undefined") {
      window.chrome?.webview?.postMessage({
        type: "listenInsightsRequest",
        range: selectedRange,
        requestId: latestRequestId
      });
    }
    return latestRequestId;
  }

  function applyInsightsPayload(detail, ctx) {
    if (!detail || typeof detail !== "object") {
      return false;
    }
    const requestId = Number(detail.requestId) || 0;
    if (requestId !== latestRequestId) {
      return false;
    }
    if (!isInsightsActive(ctx)) {
      return false;
    }
    const range = detail.range || selectedRange;
    selectedRange = range;
    activePayload = detail;
    lastPayloadByRange[range] = detail;
    return true;
  }

  function clearActiveRequests() {
    latestRequestId = -1;
  }

  function playableQueue(payload, trackById) {
    const tracks = Array.isArray(payload?.topTracks) ? payload.topTracks : [];
    return tracks
      .filter((track) => track?.inLibrary && track?.trackId && trackById?.(track.trackId))
      .map((track) => track.trackId);
  }

  function render(helpers = {}) {
    return renderShell(activePayload || lastPayloadByRange[selectedRange] || null, helpers);
  }

  const api = {
    RANGES,
    getSelectedRange: () => selectedRange,
    getActivePayload: () => activePayload,
    requestInsights,
    applyInsightsPayload,
    clearActiveRequests,
    playableQueue,
    render,
    formatListenTime,
    formatCompactDuration
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.EmpListeningInsights = api;
  }
})();
