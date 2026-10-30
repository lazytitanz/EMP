/**
 * EMP Smart Playlists — rule definitions, validation, and evaluation.
 * Pure module: no DOM. Shared by editor preview, detail membership, and play.
 *
 * Missing-data contract (do not conflate never-played with "played long ago"):
 * - Text positive ops fail on missing/empty; negative ops match missing/empty.
 * - Missing year/duration fail all numeric comparisons.
 * - Missing listen stats → playCount = 0.
 * - Last-played relative/absolute ops require lastPlayedAt > 0; never-played must use explicit never.
 * - Date-added ops require dateAdded > 0.
 */
(function (global) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_DEPTH = 2;
  const MAX_RULES = 50;
  const PREVIEW_LIMIT = 10;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const TEXT_FIELDS = new Set(["title", "artist", "album", "albumArtist", "genre", "format"]);
  const NUMBER_FIELDS = new Set(["year", "duration", "playCount"]);
  const DATE_FIELDS = new Set(["lastPlayed", "dateAdded"]);
  const BOOL_FIELDS = new Set(["favorite"]);
  const SPECIAL_FIELDS = new Set(["neverPlayed"]);

  const TEXT_OPS = new Set(["is", "isNot", "contains", "doesNotContain", "startsWith", "endsWith"]);
  const NUMBER_OPS = new Set(["eq", "neq", "gt", "lt", "gte", "lte"]);
  const DATE_OPS = new Set(["withinLastDays", "olderThanDays", "before", "after", "never"]);
  const BOOL_OPS = new Set(["isTrue", "isFalse"]);

  const SORT_FIELDS = new Set([
    "title",
    "artist",
    "album",
    "dateAdded",
    "playCount",
    "lastPlayed",
    "random"
  ]);

  const ALL_FIELDS = new Set([
    ...TEXT_FIELDS,
    ...NUMBER_FIELDS,
    ...DATE_FIELDS,
    ...BOOL_FIELDS,
    ...SPECIAL_FIELDS
  ]);

  function hashSeed(text) {
    let h = 2166136261 >>> 0;
    const s = String(text);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function next() {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(list, rng) {
    const items = [...list];
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeText(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function emptyGroupResult(op) {
    // Vacuous truth for ALL; empty ANY matches nothing.
    return op === "all";
  }

  function operatorsForField(field) {
    if (TEXT_FIELDS.has(field)) {
      return [...TEXT_OPS];
    }
    if (NUMBER_FIELDS.has(field)) {
      return [...NUMBER_OPS];
    }
    if (DATE_FIELDS.has(field)) {
      return field === "lastPlayed"
        ? [...DATE_OPS]
        : ["withinLastDays", "olderThanDays", "before", "after"];
    }
    if (BOOL_FIELDS.has(field)) {
      return [...BOOL_OPS];
    }
    if (field === "neverPlayed") {
      return ["isTrue"];
    }
    return [];
  }

  function defaultValueFor(field, op) {
    if (TEXT_FIELDS.has(field)) {
      return "";
    }
    if (NUMBER_FIELDS.has(field)) {
      return field === "duration" ? 180 : 0;
    }
    if (DATE_FIELDS.has(field)) {
      if (op === "never") {
        return null;
      }
      if (op === "withinLastDays" || op === "olderThanDays") {
        return { days: 30 };
      }
      return { at: Date.now() };
    }
    if (BOOL_FIELDS.has(field) || field === "neverPlayed") {
      return true;
    }
    return null;
  }

  function createEmptyRule(field = "artist") {
    const op = operatorsForField(field)[0] || "is";
    return {
      type: "rule",
      field,
      op,
      value: defaultValueFor(field, op)
    };
  }

  function createEmptyGroup(op = "all") {
    return {
      type: "group",
      op: op === "any" ? "any" : "all",
      children: [createEmptyRule()]
    };
  }

  function createDefaultDefinition() {
    return {
      match: "all",
      rules: createEmptyGroup("all"),
      sort: { field: "title", direction: "asc" },
      limit: null,
      randomSeed: null,
      templatesHint: null
    };
  }

  function walkNodes(node, depth, visit) {
    if (!node || typeof node !== "object") {
      visit({ error: "malformed", depth });
      return;
    }
    if (node.type === "rule") {
      visit({ node, depth });
      return;
    }
    if (node.type === "group") {
      visit({ node, depth });
      if (depth > MAX_DEPTH) {
        return;
      }
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) {
        const nextDepth = child?.type === "group" ? depth + 1 : depth;
        walkNodes(child, nextDepth, visit);
      }
      return;
    }
    visit({ error: "unknownType", depth, node });
  }

  function validateRuleValue(field, op, value) {
    if (TEXT_FIELDS.has(field)) {
      if (typeof value !== "string") {
        return "Text value required";
      }
      if (!value.trim() && (op === "is" || op === "contains" || op === "startsWith" || op === "endsWith")) {
        return "Value required";
      }
      return null;
    }
    if (NUMBER_FIELDS.has(field)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "Numeric value required";
      }
      return null;
    }
    if (DATE_FIELDS.has(field)) {
      if (op === "never") {
        return null;
      }
      if (op === "withinLastDays" || op === "olderThanDays") {
        const days = value?.days;
        if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
          return "Positive day count required";
        }
        return null;
      }
      if (op === "before" || op === "after") {
        const at = value?.at;
        if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) {
          return "Date required";
        }
        return null;
      }
      return "Invalid date operator";
    }
    if (BOOL_FIELDS.has(field)) {
      if (op !== "isTrue" && op !== "isFalse") {
        return "Boolean operator required";
      }
      return null;
    }
    if (field === "neverPlayed") {
      if (op !== "isTrue") {
        return "Invalid never-played operator";
      }
      return null;
    }
    return "Unknown field";
  }

  function validateSmartDefinition(def) {
    const errors = [];
    if (!isPlainObject(def)) {
      return { ok: false, errors: ["Definition required"] };
    }

    const match = def.match === "any" ? "any" : def.match === "all" ? "all" : null;
    if (!match) {
      errors.push("Match mode must be all or any");
    }

    const sortField = def.sort?.field;
    const sortDir = def.sort?.direction;
    if (!SORT_FIELDS.has(sortField)) {
      errors.push("Invalid sort field");
    }
    if (sortDir !== "asc" && sortDir !== "desc") {
      errors.push("Invalid sort direction");
    }

    if (def.limit !== null && def.limit !== undefined) {
      if (typeof def.limit !== "number" || !Number.isInteger(def.limit) || def.limit <= 0) {
        errors.push("Limit must be a positive integer or null");
      }
    }

    if (sortField === "random") {
      if (def.randomSeed !== null && def.randomSeed !== undefined) {
        if (typeof def.randomSeed !== "number" || !Number.isFinite(def.randomSeed)) {
          errors.push("Invalid random seed");
        }
      }
    }

    const root = def.rules;
    if (!root || root.type !== "group") {
      errors.push("Rules must be a root group");
      return { ok: false, errors };
    }

    let ruleCount = 0;
    let maxDepth = 0;
    let sawIncomplete = false;

    walkNodes(root, 1, (entry) => {
      if (entry.error) {
        errors.push("Malformed rule tree");
        return;
      }
      maxDepth = Math.max(maxDepth, entry.depth);
      if (entry.depth > MAX_DEPTH) {
        errors.push("Rule nesting exceeds maximum depth");
        return;
      }
      const node = entry.node;
      if (node.type === "group") {
        if (node.op !== "all" && node.op !== "any") {
          errors.push("Group operator must be all or any");
        }
        return;
      }
      ruleCount += 1;
      if (!ALL_FIELDS.has(node.field)) {
        errors.push("Unknown rule field");
        sawIncomplete = true;
        return;
      }
      const allowed = new Set(operatorsForField(node.field));
      if (!allowed.has(node.op)) {
        errors.push(`Invalid operator for ${node.field}`);
        sawIncomplete = true;
        return;
      }
      const valueError = validateRuleValue(node.field, node.op, node.value);
      if (valueError) {
        errors.push(valueError);
        sawIncomplete = true;
      }
    });

    if (ruleCount === 0) {
      errors.push("At least one rule is required");
    }
    if (ruleCount > MAX_RULES) {
      errors.push("Too many rules");
    }
    if (maxDepth > MAX_DEPTH) {
      errors.push("Rule nesting exceeds maximum depth");
    }

    // Deduplicate while preserving order
    const unique = [];
    for (const err of errors) {
      if (!unique.includes(err)) {
        unique.push(err);
      }
    }

    return { ok: unique.length === 0, errors: unique, incomplete: sawIncomplete, ruleCount, maxDepth };
  }

  function normalizeRuleNode(node, depth = 1) {
    if (!node || typeof node !== "object" || depth > MAX_DEPTH + 1) {
      return null;
    }
    if (node.type === "rule") {
      const field = ALL_FIELDS.has(node.field) ? node.field : null;
      if (!field) {
        return null;
      }
      const allowed = operatorsForField(field);
      const op = allowed.includes(node.op) ? node.op : allowed[0];
      let value = node.value;
      if (TEXT_FIELDS.has(field)) {
        value = typeof value === "string" ? value : "";
      } else if (NUMBER_FIELDS.has(field)) {
        value = typeof value === "number" && Number.isFinite(value) ? value : defaultValueFor(field, op);
      } else if (DATE_FIELDS.has(field)) {
        if (op === "never") {
          value = null;
        } else if (op === "withinLastDays" || op === "olderThanDays") {
          const days = Number(value?.days);
          value = { days: Number.isFinite(days) && days > 0 ? days : 30 };
        } else {
          const at = Number(value?.at);
          value = { at: Number.isFinite(at) && at > 0 ? at : Date.now() };
        }
      } else {
        value = true;
      }
      return { type: "rule", field, op, value };
    }
    if (node.type === "group") {
      const children = Array.isArray(node.children)
        ? node.children
            .map((child) => normalizeRuleNode(child, child?.type === "group" ? depth + 1 : depth))
            .filter(Boolean)
            .slice(0, MAX_RULES)
        : [];
      return {
        type: "group",
        op: node.op === "any" ? "any" : "all",
        children
      };
    }
    return null;
  }

  function normalizeSmartDefinition(raw) {
    if (!isPlainObject(raw)) {
      return { ...createDefaultDefinition(), loadError: true };
    }
    const rules = normalizeRuleNode(raw.rules) || createEmptyGroup(raw.match === "any" ? "any" : "all");
    // Align root group op with match when present
    if (rules.type === "group" && (raw.match === "all" || raw.match === "any")) {
      rules.op = raw.match;
    }
    const sortField = SORT_FIELDS.has(raw.sort?.field) ? raw.sort.field : "title";
    const sortDir = raw.sort?.direction === "desc" ? "desc" : "asc";
    let limit = null;
    if (typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit > 0) {
      limit = raw.limit;
    }
    let randomSeed = null;
    if (typeof raw.randomSeed === "number" && Number.isFinite(raw.randomSeed)) {
      randomSeed = raw.randomSeed >>> 0;
    } else if (sortField === "random") {
      randomSeed = hashSeed(`smart|${Date.now()}|${Math.random()}`) >>> 0;
    }
    const def = {
      match: rules.op === "any" ? "any" : "all",
      rules,
      sort: { field: sortField, direction: sortDir },
      limit,
      randomSeed,
      templatesHint: typeof raw.templatesHint === "string" ? raw.templatesHint : null
    };
    const validated = validateSmartDefinition(def);
    if (!validated.ok) {
      def.loadError = true;
      def.loadErrors = validated.errors;
    }
    return def;
  }

  function collectDependencies(node, deps = { metadata: false, stats: false, liked: false, dateRelative: false }) {
    if (!node) {
      return deps;
    }
    if (node.type === "group") {
      for (const child of node.children || []) {
        collectDependencies(child, deps);
      }
      return deps;
    }
    const field = node.field;
    if (field === "favorite") {
      deps.liked = true;
    } else if (field === "playCount" || field === "lastPlayed" || field === "neverPlayed") {
      deps.stats = true;
      if (field === "lastPlayed" && (node.op === "withinLastDays" || node.op === "olderThanDays")) {
        deps.dateRelative = true;
      }
    } else if (field === "dateAdded") {
      deps.metadata = true;
      if (node.op === "withinLastDays" || node.op === "olderThanDays") {
        deps.dateRelative = true;
      }
    } else {
      deps.metadata = true;
    }
    return deps;
  }

  function definitionDependencies(def) {
    const deps = collectDependencies(def?.rules);
    const sort = def?.sort?.field;
    if (sort === "playCount" || sort === "lastPlayed") {
      deps.stats = true;
    }
    if (sort === "dateAdded") {
      deps.metadata = true;
    }
    return deps;
  }

  function trackStats(context, trackId) {
    const row = context.listenStats?.[trackId];
    return {
      playCount: Math.max(0, Number(row?.playCount) || 0),
      lastPlayedAt: Math.max(0, Number(row?.lastPlayedAt) || 0),
      listenMs: Math.max(0, Number(row?.listenMs) || 0)
    };
  }

  function resolveTextField(track, field, albumsById) {
    switch (field) {
      case "title":
        return track?.title;
      case "artist":
        return track?.artist;
      case "album":
        return track?.album;
      case "albumArtist":
        return track?.albumArtist || albumsById?.[track?.albumId]?.artist || track?.artist;
      case "genre":
        return track?.genre;
      case "format":
        return track?.format;
      default:
        return "";
    }
  }

  function resolveYear(track, albumsById) {
    if (typeof track?.year === "number" && Number.isFinite(track.year) && track.year > 0) {
      return track.year;
    }
    const albumYear = albumsById?.[track?.albumId]?.year;
    if (typeof albumYear === "number" && Number.isFinite(albumYear) && albumYear > 0) {
      return albumYear;
    }
    return null;
  }

  function matchText(actualRaw, op, expectedRaw) {
    const actual = normalizeText(actualRaw);
    const expected = normalizeText(expectedRaw);
    const missing = !actual;
    switch (op) {
      case "is":
        return !missing && actual === expected;
      case "isNot":
        return missing || actual !== expected;
      case "contains":
        return !missing && expected.length > 0 && actual.includes(expected);
      case "doesNotContain":
        return missing || expected.length === 0 || !actual.includes(expected);
      case "startsWith":
        return !missing && expected.length > 0 && actual.startsWith(expected);
      case "endsWith":
        return !missing && expected.length > 0 && actual.endsWith(expected);
      default:
        return false;
    }
  }

  function matchNumber(actual, op, expected) {
    if (typeof actual !== "number" || !Number.isFinite(actual)) {
      return false;
    }
    if (typeof expected !== "number" || !Number.isFinite(expected)) {
      return false;
    }
    switch (op) {
      case "eq":
        return actual === expected;
      case "neq":
        return actual !== expected;
      case "gt":
        return actual > expected;
      case "lt":
        return actual < expected;
      case "gte":
        return actual >= expected;
      case "lte":
        return actual <= expected;
      default:
        return false;
    }
  }

  function matchDate(timestamp, op, value, now) {
    if (op === "never") {
      return !(timestamp > 0);
    }
    // Relative and absolute date ops require a known timestamp.
    if (!(timestamp > 0)) {
      return false;
    }
    if (op === "withinLastDays") {
      const days = Number(value?.days);
      if (!(days > 0)) {
        return false;
      }
      return now - timestamp <= days * DAY_MS;
    }
    if (op === "olderThanDays") {
      const days = Number(value?.days);
      if (!(days > 0)) {
        return false;
      }
      return now - timestamp > days * DAY_MS;
    }
    if (op === "before") {
      const at = Number(value?.at);
      return at > 0 && timestamp < at;
    }
    if (op === "after") {
      const at = Number(value?.at);
      return at > 0 && timestamp > at;
    }
    return false;
  }

  function matchRule(rule, track, context) {
    const field = rule.field;
    const op = rule.op;
    const stats = trackStats(context, track.id);
    const liked = context.likedIds instanceof Set
      ? context.likedIds.has(track.id)
      : Array.isArray(context.likedIds)
        ? context.likedIds.includes(track.id)
        : false;
    const now = Number(context.now) || Date.now();
    const albumsById = context.albumsById || {};

    if (field === "neverPlayed") {
      return !(stats.lastPlayedAt > 0) && stats.playCount <= 0;
    }

    if (TEXT_FIELDS.has(field)) {
      return matchText(resolveTextField(track, field, albumsById), op, rule.value);
    }

    if (field === "year") {
      return matchNumber(resolveYear(track, albumsById), op, rule.value);
    }
    if (field === "duration") {
      const duration = Number(track?.duration);
      return matchNumber(Number.isFinite(duration) && duration > 0 ? duration : null, op, rule.value);
    }
    if (field === "playCount") {
      return matchNumber(stats.playCount, op, rule.value);
    }

    if (field === "lastPlayed") {
      return matchDate(stats.lastPlayedAt, op, rule.value, now);
    }
    if (field === "dateAdded") {
      const dateAdded = Number(track?.dateAdded) || 0;
      return matchDate(dateAdded, op, rule.value, now);
    }

    if (field === "favorite") {
      if (op === "isTrue") {
        return liked;
      }
      if (op === "isFalse") {
        return !liked;
      }
      return false;
    }

    return false;
  }

  function matchNode(node, track, context, depth = 1) {
    if (!node || depth > MAX_DEPTH + 1) {
      return false;
    }
    if (node.type === "rule") {
      return matchRule(node, track, context);
    }
    if (node.type === "group") {
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length === 0) {
        return emptyGroupResult(node.op);
      }
      if (node.op === "any") {
        return children.some((child) => {
          const nextDepth = child?.type === "group" ? depth + 1 : depth;
          return matchNode(child, track, context, nextDepth);
        });
      }
      return children.every((child) => {
        const nextDepth = child?.type === "group" ? depth + 1 : depth;
        return matchNode(child, track, context, nextDepth);
      });
    }
    return false;
  }

  function compareStrings(a, b) {
    return normalizeText(a).localeCompare(normalizeText(b), undefined, { sensitivity: "base" });
  }

  function sortMatched(tracks, def, context) {
    const field = def.sort?.field || "title";
    const direction = def.sort?.direction === "desc" ? -1 : 1;

    if (field === "random") {
      const seed = typeof def.randomSeed === "number" && Number.isFinite(def.randomSeed)
        ? def.randomSeed >>> 0
        : hashSeed(`smart-random|${tracks.length}`);
      return seededShuffle(tracks, mulberry32(seed));
    }

    const albumsById = context.albumsById || {};
    const sorted = [...tracks].sort((left, right) => {
      let cmp = 0;
      switch (field) {
        case "title":
          cmp = compareStrings(left.title, right.title);
          break;
        case "artist":
          cmp = compareStrings(left.artist, right.artist) || compareStrings(left.title, right.title);
          break;
        case "album":
          cmp = compareStrings(left.album, right.album) || compareStrings(left.title, right.title);
          break;
        case "dateAdded": {
          const a = Number(left.dateAdded) || 0;
          const b = Number(right.dateAdded) || 0;
          cmp = a - b;
          break;
        }
        case "playCount": {
          const a = trackStats(context, left.id).playCount;
          const b = trackStats(context, right.id).playCount;
          cmp = a - b;
          break;
        }
        case "lastPlayed": {
          const a = trackStats(context, left.id).lastPlayedAt;
          const b = trackStats(context, right.id).lastPlayedAt;
          cmp = a - b;
          break;
        }
        default:
          cmp = compareStrings(left.title, right.title);
      }
      if (cmp === 0) {
        cmp = compareStrings(left.id, right.id);
      }
      return cmp * direction;
    });
    // silence unused
    void albumsById;
    return sorted;
  }

  /**
   * Evaluate a smart playlist definition against a library context.
   * @returns {{ trackIds: string[], totalMatches: number, tracks: object[] }}
   */
  function evaluateSmartPlaylist(def, context = {}) {
    const tracks = Array.isArray(context.tracks) ? context.tracks : [];
    const normalized = normalizeSmartDefinition(def);
    if (normalized.loadError && !context.allowInvalid) {
      // Still try to evaluate if tree is usable; loadError only blocks save UI.
      const check = validateSmartDefinition(normalized);
      if (!check.ok && check.errors.includes("Rules must be a root group")) {
        return { trackIds: [], totalMatches: 0, tracks: [] };
      }
    }

    const root = normalized.rules;
    // Ensure root op matches match mode
    if (root?.type === "group") {
      root.op = normalized.match === "any" ? "any" : "all";
    }

    const matched = tracks.filter((track) => track && track.id && matchNode(root, track, context));
    const sorted = sortMatched(matched, normalized, context);
    const totalMatches = sorted.length;
    let limited = sorted;
    if (typeof normalized.limit === "number" && normalized.limit > 0) {
      limited = sorted.slice(0, normalized.limit);
    }
    return {
      trackIds: limited.map((track) => track.id),
      totalMatches,
      tracks: limited
    };
  }

  function previewSmartPlaylist(def, context = {}, limit = PREVIEW_LIMIT) {
    const result = evaluateSmartPlaylist(def, context);
    return {
      totalMatches: result.totalMatches,
      trackIds: result.trackIds.slice(0, limit),
      tracks: result.tracks.slice(0, limit)
    };
  }

  /** Monotonic preview helper — caller bumps gen; ignore when result gen mismatches. */
  function createPreviewSession() {
    let generation = 0;
    return {
      next() {
        generation += 1;
        return generation;
      },
      current() {
        return generation;
      },
      isCurrent(gen) {
        return gen === generation;
      }
    };
  }

  function newRandomSeed(extra = "") {
    return hashSeed(`smart|${Date.now()}|${extra}|${Math.random()}`) >>> 0;
  }

  function templateDefinitions(now = Date.now()) {
    return {
      "recently-added": {
        label: "Recently Added",
        description: "Tracks added within the last 30 days",
        requires: { dateAdded: true },
        def: {
          match: "all",
          rules: {
            type: "group",
            op: "all",
            children: [
              { type: "rule", field: "dateAdded", op: "withinLastDays", value: { days: 30 } }
            ]
          },
          sort: { field: "dateAdded", direction: "desc" },
          limit: null,
          randomSeed: null,
          templatesHint: "recently-added"
        }
      },
      "never-played": {
        label: "Never Played",
        description: "Tracks with no recorded plays",
        requires: { stats: true },
        def: {
          match: "all",
          rules: {
            type: "group",
            op: "all",
            children: [
              { type: "rule", field: "neverPlayed", op: "isTrue", value: true }
            ]
          },
          sort: { field: "title", direction: "asc" },
          limit: null,
          randomSeed: null,
          templatesHint: "never-played"
        }
      },
      "most-played": {
        label: "Most Played",
        description: "Tracks sorted by highest play count",
        requires: { stats: true },
        def: {
          match: "all",
          rules: {
            type: "group",
            op: "all",
            children: [
              { type: "rule", field: "playCount", op: "gte", value: 1 }
            ]
          },
          sort: { field: "playCount", direction: "desc" },
          limit: 100,
          randomSeed: null,
          templatesHint: "most-played"
        }
      },
      "forgotten-favorites": {
        label: "Forgotten Favorites",
        description: "Liked tracks not played recently",
        requires: { stats: true, liked: true },
        def: {
          match: "all",
          rules: {
            type: "group",
            op: "all",
            children: [
              { type: "rule", field: "favorite", op: "isTrue", value: true },
              {
                type: "group",
                op: "any",
                children: [
                  { type: "rule", field: "lastPlayed", op: "olderThanDays", value: { days: 30 } },
                  { type: "rule", field: "neverPlayed", op: "isTrue", value: true }
                ]
              }
            ]
          },
          sort: { field: "lastPlayed", direction: "asc" },
          limit: null,
          randomSeed: null,
          templatesHint: "forgotten-favorites"
        }
      },
      "recently-played": {
        label: "Recently Played",
        description: "Tracks played within the last 7 days",
        requires: { stats: true },
        def: {
          match: "all",
          rules: {
            type: "group",
            op: "all",
            children: [
              { type: "rule", field: "lastPlayed", op: "withinLastDays", value: { days: 7 } }
            ]
          },
          sort: { field: "lastPlayed", direction: "desc" },
          limit: null,
          randomSeed: null,
          templatesHint: "recently-played"
        }
      }
    };
  }

  function listTemplates(availability = {}) {
    const catalog = templateDefinitions();
    return Object.entries(catalog).map(([id, entry]) => {
      const req = entry.requires || {};
      let enabled = true;
      if (req.dateAdded && availability.dateAdded === false) {
        enabled = false;
      }
      if (req.stats && availability.stats === false) {
        enabled = false;
      }
      if (req.liked && availability.liked === false) {
        enabled = false;
      }
      return {
        id,
        label: entry.label,
        description: entry.description,
        enabled,
        def: structuredClone
          ? structuredClone(entry.def)
          : JSON.parse(JSON.stringify(entry.def))
      };
    });
  }

  function cloneDefinition(def) {
    return JSON.parse(JSON.stringify(normalizeSmartDefinition(def)));
  }

  const api = {
    SCHEMA_VERSION,
    MAX_DEPTH,
    MAX_RULES,
    PREVIEW_LIMIT,
    TEXT_FIELDS: [...TEXT_FIELDS],
    NUMBER_FIELDS: [...NUMBER_FIELDS],
    DATE_FIELDS: [...DATE_FIELDS],
    SORT_FIELDS: [...SORT_FIELDS],
    ALL_FIELDS: [...ALL_FIELDS],
    operatorsForField,
    defaultValueFor,
    createEmptyRule,
    createEmptyGroup,
    createDefaultDefinition,
    validateSmartDefinition,
    normalizeSmartDefinition,
    normalizeRuleNode,
    definitionDependencies,
    evaluateSmartPlaylist,
    previewSmartPlaylist,
    createPreviewSession,
    newRandomSeed,
    listTemplates,
    templateDefinitions,
    cloneDefinition,
    hashSeed,
    mulberry32,
    seededShuffle
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpSmartPlaylists = api;
})(typeof window !== "undefined" ? window : globalThis);
