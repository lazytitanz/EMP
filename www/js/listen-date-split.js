/**
 * Local-calendar listening duration attribution.
 * Monotonic duration is never derived from wall-clock deltas.
 * Wall clock (with prior checkpoints) only chooses YYYY-MM-DD buckets.
 */
(function (global) {
  "use strict";

  /** Max wall skew vs mono delta before treating the interval as discontinuous. */
  const WALL_CONTINUITY_SLACK_MS = 5000;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function localDateKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function nextLocalMidnightMs(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /**
   * @param {number} monoDeltaMs already-clamped monotonic listen duration
   * @param {number} wallNowMs Date.now() at this tick
   * @param {number} prevWallMs Date.now() when the monotonic checkpoint was set (0 if none)
   * @returns {Record<string, number>} day key → ms; values >= 0 and sum to monoDeltaMs (or empty)
   */
  function splitListenMsByLocalDate(monoDeltaMs, wallNowMs, prevWallMs) {
    const mono = Math.floor(Number(monoDeltaMs));
    if (!(mono > 0) || !Number.isFinite(mono)) {
      return {};
    }

    const wallEnd = Number(wallNowMs);
    if (!Number.isFinite(wallEnd)) {
      return { [localDateKey(Date.now())]: mono };
    }

    const prev = Number(prevWallMs);
    const hasPrev = Number.isFinite(prev) && prev > 0;

    // Backward clock, missing checkpoint, or discontinuous forward jump:
    // attribute the entire monotonic delta to the end date (no inflation).
    if (!hasPrev || wallEnd < prev) {
      return { [localDateKey(wallEnd)]: mono };
    }

    const wallSpan = wallEnd - prev;
    if (!(wallSpan > 0) || wallSpan > mono + WALL_CONTINUITY_SLACK_MS) {
      return { [localDateKey(wallEnd)]: mono };
    }

    const boundaries = [prev];
    let cursor = nextLocalMidnightMs(prev);
    for (let i = 0; i < 8 && cursor < wallEnd; i += 1) {
      boundaries.push(cursor);
      cursor = nextLocalMidnightMs(cursor);
    }
    boundaries.push(wallEnd);

    const segments = [];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const from = boundaries[i];
      const to = boundaries[i + 1];
      const length = to - from;
      if (length > 0) {
        segments.push({ from, length, key: localDateKey(from) });
      }
    }

    if (!segments.length) {
      return { [localDateKey(wallEnd)]: mono };
    }

    if (segments.length === 1) {
      return { [segments[0].key]: mono };
    }

    const totalWall = segments.reduce((sum, s) => sum + s.length, 0);
    if (!(totalWall > 0)) {
      return { [localDateKey(wallEnd)]: mono };
    }

    const raw = segments.map((s) => (mono * s.length) / totalWall);
    const floors = raw.map((v) => Math.floor(v));
    let used = floors.reduce((a, b) => a + b, 0);
    let remain = mono - used;
    const fracOrder = raw
      .map((v, i) => ({ i, frac: v - floors[i] }))
      .sort((a, b) => b.frac - a.frac);

    const amounts = floors.slice();
    for (let r = 0; r < remain; r += 1) {
      amounts[fracOrder[r % fracOrder.length].i] += 1;
    }

    const buckets = {};
    for (let i = 0; i < segments.length; i += 1) {
      const ms = amounts[i];
      if (ms > 0) {
        const key = segments[i].key;
        buckets[key] = (buckets[key] || 0) + ms;
      }
    }

    let sum = 0;
    for (const v of Object.values(buckets)) {
      sum += v;
    }
    if (sum !== mono) {
      return { [localDateKey(wallEnd)]: mono };
    }

    return buckets;
  }

  function addDayBuckets(target, deltaBuckets) {
    if (!target || !deltaBuckets) {
      return target || {};
    }
    for (const [key, value] of Object.entries(deltaBuckets)) {
      const n = Math.floor(Number(value));
      if (!(n > 0) || !key) {
        continue;
      }
      target[key] = (Math.floor(Number(target[key])) || 0) + n;
    }
    return target;
  }

  function dayBucketsDelta(total, sent) {
    const out = {};
    const totalMap = total && typeof total === "object" ? total : {};
    const sentMap = sent && typeof sent === "object" ? sent : {};
    const keys = new Set([...Object.keys(totalMap), ...Object.keys(sentMap)]);
    for (const key of keys) {
      const delta = Math.floor(Number(totalMap[key]) || 0) - Math.floor(Number(sentMap[key]) || 0);
      if (delta > 0) {
        out[key] = delta;
      }
    }
    return out;
  }

  function markDayBucketsSent(sent, delta) {
    if (!sent || !delta) {
      return sent || {};
    }
    for (const [key, value] of Object.entries(delta)) {
      const n = Math.floor(Number(value));
      if (!(n > 0) || !key) {
        continue;
      }
      sent[key] = (Math.floor(Number(sent[key])) || 0) + n;
    }
    return sent;
  }

  const api = {
    WALL_CONTINUITY_SLACK_MS,
    localDateKey,
    nextLocalMidnightMs,
    splitListenMsByLocalDate,
    addDayBuckets,
    dayBucketsDelta,
    markDayBucketsSent
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.EmpListenDateSplit = api;
})(typeof window !== "undefined" ? window : globalThis);
