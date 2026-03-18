/**
 * Shared trademark search engine.
 * Processes normalized TrademarkMatch[] from any registry (INPI, WIPO, etc.)
 * and produces a single CheckResult with NIZA class filtering, a short detail
 * summary, and structured matchGroups for collapsible UI rendering.
 *
 * Status is determined ONLY by exact-name matches.
 */
import type {
  CheckResult,
  MatchGroup,
  TrademarkMatch,
  TrademarkSearchConfig,
} from "../types.js";
import { CLASE_DESCRIPTIONS, inferRelevantClasses } from "../niza.js";

const DOUBT_DISTANCE_THRESHOLD = 12;

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function processTrademarkMatches(
  matches: TrademarkMatch[],
  config: TrademarkSearchConfig,
  startTime: number
): CheckResult {
  // ── No matches at all ─────────────────────────────────────────────
  if (matches.length === 0) {
    const detail = config.totalSimilarResults
      ? `${config.totalSimilarResults} resultado(s) similares, pero ninguna coincidencia exacta con "${config.brandName}"`
      : `No se encontraron marcas para "${config.brandName}"`;

    return {
      platform: config.platform,
      displayName: config.displayName,
      status: "available",
      detail,
      url: config.searchUrl,
      responseTimeMs: Date.now() - startTime,
      matchGroups: [],
    };
  }

  // ── Split by similarity level ───────────────────────────────────
  const exact = matches.filter((m) => m.similarityLevel === "exact");
  const contains = matches.filter((m) => m.similarityLevel === "contains");
  const partial = matches.filter((m) => m.similarityLevel === "partial");

  // ── Separate active / inactive ────────────────────────────────────
  const exactActive = exact.filter((m) => m.isActive);
  const exactInactive = exact.filter((m) => !m.isActive);
  const containsActive = contains.filter((m) => m.isActive);
  const partialActive = partial.filter((m) => m.isActive);

  // ── NIZA class filtering ──────────────────────────────────────────
  const relevantClasses = inferRelevantClasses(config.description || "");
  const hasFilter = relevantClasses.length > 0;

  const matchHasRelevantClass = (m: TrademarkMatch) =>
    m.niceClasses.some((nc) => relevantClasses.includes(nc));

  const exactActiveRelevant = hasFilter
    ? exactActive.filter(matchHasRelevantClass)
    : exactActive;
  const exactActiveOther = hasFilter
    ? exactActive.filter((m) => !matchHasRelevantClass(m))
    : [];

  const containsRelevant = hasFilter
    ? containsActive.filter(matchHasRelevantClass)
    : containsActive;
  const partialRelevant = hasFilter
    ? partialActive.filter(matchHasRelevantClass)
    : partialActive;

  // ── Build SHORT detail text (no individual listings) ──────────────
  const parts: string[] = [];

  if (config.totalSimilarResults) {
    const countries = new Set(
      matches.filter((m) => m.country).map((m) => m.country)
    ).size;
    parts.push(
      `${config.totalSimilarResults} resultado(s) en ${config.displayName}, ${exact.length} exacta(s)${countries > 0 ? ` en ${countries} pais(es)` : ""}`
    );
  }

  if (hasFilter) {
    const classDescs = relevantClasses
      .slice(0, 4)
      .map((c) => `${c} (${CLASE_DESCRIPTIONS[c] || "?"})`)
      .join(", ");
    parts.push(`Clases de tu rubro: ${classDescs}`);
  }

  if (exact.length > 0) {
    if (exactActive.length > 0) {
      if (hasFilter) {
        if (exactActiveRelevant.length > 0) {
          parts.push(
            `⚠️ ${exactActiveRelevant.length} exacta(s) activa(s) EN TU RUBRO`
          );
        } else {
          parts.push(`✅ Ninguna exacta activa en tus clases`);
        }
        if (exactActiveOther.length > 0) {
          parts.push(
            `ℹ️ ${exactActiveOther.length} exacta(s) activa(s) en otros rubros`
          );
        }
      } else {
        parts.push(`🔎 ${exactActive.length} exacta(s) activa(s)`);
      }
      if (exactInactive.length > 0) {
        parts.push(`+ ${exactInactive.length} exacta(s) inactiva(s)`);
      }
    } else {
      const statuses = [
        ...new Set(exactInactive.map((m) => m.status.split("(")[0].trim())),
      ].join(", ");
      parts.push(
        `${exact.length} exacta(s), todas inactivas (${statuses})`
      );
    }
  } else if (config.totalSimilarResults) {
    parts.push(`Ninguna coincidencia exacta con "${config.brandName}"`);
  }

  const classLabel = hasFilter ? " en tu rubro" : "";
  if (containsRelevant.length > 0) {
    parts.push(
      `🟡 ${containsRelevant.length} marca(s) contienen "${config.brandName}"${classLabel}`
    );
  }
  if (partialRelevant.length > 0) {
    parts.push(
      `🟠 ${partialRelevant.length} coincidencia(s) parcial(es)${classLabel}`
    );
  }

  // ── Determine status ────────────────────────────────────────────
  // taken: exact active match in relevant classes (or any if no filter)
  // unknown: no exact active, but contains/partial active within distance < 12
  // available: nothing close enough
  const isTaken = hasFilter
    ? exactActiveRelevant.length > 0
    : exactActive.length > 0;

  let isDoubtful = false;
  if (!isTaken) {
    const searchNorm = normalize(config.brandName);
    const nearMatches = hasFilter
      ? [...containsRelevant, ...partialRelevant]
      : [...containsActive, ...partialActive];

    isDoubtful = nearMatches.some((m) => {
      const dist = levenshtein(normalize(m.brandName), searchNorm);
      return dist < DOUBT_DISTANCE_THRESHOLD;
    });

    if (isDoubtful) {
      const closeCount = nearMatches.filter(
        (m) => levenshtein(normalize(m.brandName), searchNorm) < DOUBT_DISTANCE_THRESHOLD
      ).length;
      parts.push(
        `⚠️ ${closeCount} marca(s) similar(es) muy cercana(s) — revisar manualmente`
      );
    }
  }

  // ── Build matchGroups — granular subdivisions ─────────────────────
  const matchGroups: MatchGroup[] = [];

  if (hasFilter) {
    // With NIZA filter: split exact into "your industry" vs "other"
    if (exactActiveRelevant.length > 0) {
      matchGroups.push({
        level: "exact",
        label: `⚠️ Exactas activas EN TU RUBRO (${exactActiveRelevant.length})`,
        matches: exactActiveRelevant,
      });
    }
    if (exactActiveOther.length > 0) {
      matchGroups.push({
        level: "exact",
        label: `Exactas activas en otros rubros (${exactActiveOther.length})`,
        matches: exactActiveOther,
      });
    }
  } else {
    // No filter: one group for all exact active
    if (exactActive.length > 0) {
      matchGroups.push({
        level: "exact",
        label: `Exactas activas (${exactActive.length})`,
        matches: exactActive,
      });
    }
  }

  if (exactInactive.length > 0) {
    matchGroups.push({
      level: "exact",
      label: `Exactas inactivas (${exactInactive.length})`,
      matches: exactInactive,
    });
  }

  if (contains.length > 0) {
    matchGroups.push({
      level: "contains",
      label: `Contienen "${config.brandName}" (${contains.length})`,
      matches: contains,
    });
  }

  if (partial.length > 0) {
    matchGroups.push({
      level: "partial",
      label: `Coincidencias parciales (${partial.length})`,
      matches: partial,
    });
  }

  return {
    platform: config.platform,
    displayName: config.displayName,
    status: isTaken ? "taken" : isDoubtful ? "unknown" : "available",
    detail: parts.join("\n"),
    url: config.searchUrl,
    responseTimeMs: Date.now() - startTime,
    matchGroups,
  };
}
