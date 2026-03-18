/**
 * Shared trademark search engine.
 * Processes normalized TrademarkMatch[] from any registry (INPI, WIPO, etc.)
 * and produces a single CheckResult with NIZA class filtering, detail text,
 * and structured matchGroups for UI rendering.
 *
 * Status is determined ONLY by exact-name matches.
 * Similar matches (compound names, letter variations) in relevant classes
 * are shown as informational context.
 */
import type {
  CheckResult,
  MatchGroup,
  TrademarkMatch,
  TrademarkSearchConfig,
} from "../types.js";
import { CLASE_DESCRIPTIONS, inferRelevantClasses } from "../niza.js";

/**
 * Process trademark matches from any registry into a CheckResult.
 *
 * @param matches   - All matches (exact + similar), each flagged with isExactMatch
 * @param config    - Platform info, description for NIZA filtering, brand name
 * @param startTime - Date.now() from when the check started (for responseTimeMs)
 */
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

  // ── Separate active / inactive (exact only — for status) ──────────
  const exactActive = exact.filter((m) => m.isActive);
  const exactInactive = exact.filter((m) => !m.isActive);

  // ── Active similar matches ──────────────────────────────────────
  const containsActive = contains.filter((m) => m.isActive);
  const partialActive = partial.filter((m) => m.isActive);

  // ── NIZA class filtering ──────────────────────────────────────────
  const relevantClasses = inferRelevantClasses(config.description || "");
  const hasFilter = relevantClasses.length > 0;

  const matchHasRelevantClass = (m: TrademarkMatch) =>
    m.niceClasses.some((nc) => relevantClasses.includes(nc));

  // Exact: split by relevant class
  const exactActiveRelevant = hasFilter
    ? exactActive.filter(matchHasRelevantClass)
    : exactActive;
  const exactActiveOther = hasFilter
    ? exactActive.filter((m) => !matchHasRelevantClass(m))
    : [];

  // Contains/partial: filter by relevant class if available
  const containsRelevant = hasFilter
    ? containsActive.filter(matchHasRelevantClass)
    : containsActive;
  const partialRelevant = hasFilter
    ? partialActive.filter(matchHasRelevantClass)
    : partialActive;

  // ── Format helpers ────────────────────────────────────────────────
  const fmtExact = (m: TrademarkMatch) => {
    const nc =
      m.niceClasses.length > 0 ? m.niceClasses.map(String).join(", ") : "?";
    const claseDesc = m.niceClasses
      .map((c) => CLASE_DESCRIPTIONS[c] || `${c}`)
      .join(", ");
    const statusShort = m.status.split("(")[0].trim();
    const ownerShort =
      m.owner.length > 50 ? m.owner.substring(0, 50) + "..." : m.owner;
    const countryPart = m.country ? ` - ${m.country}` : "";
    return `  Clase ${nc} (${claseDesc})${countryPart} - ${statusShort} - ${ownerShort}`;
  };

  // ── Build detail text (summary) ─────────────────────────────────
  const parts: string[] = [];

  // Context line
  if (config.totalSimilarResults) {
    const countries = new Set(
      matches.filter((m) => m.country).map((m) => m.country)
    ).size;
    parts.push(
      `${config.totalSimilarResults} resultado(s) en ${config.displayName}, ${exact.length} exacta(s)${countries > 0 ? ` en ${countries} pais(es)` : ""}`
    );
  }

  // ── Exact matches section ─────────────────────────────────────────
  if (exact.length > 0) {
    if (exactActive.length > 0) {
      if (hasFilter) {
        parts.push(
          `Clases relevantes para tu rubro: ${relevantClasses.join(", ")}`
        );

        if (exactActiveRelevant.length > 0) {
          parts.push(
            `⚠️ ${exactActiveRelevant.length} exacta(s) activa(s) EN TU RUBRO:`
          );
          for (const m of exactActiveRelevant.slice(0, 6)) parts.push(fmtExact(m));
          if (exactActiveRelevant.length > 6)
            parts.push(`  ... y ${exactActiveRelevant.length - 6} mas`);
        } else {
          parts.push(`✅ Ninguna exacta activa en tus clases`);
        }

        if (exactActiveOther.length > 0) {
          parts.push(
            `ℹ️ ${exactActiveOther.length} exacta(s) activa(s) en otras clases:`
          );
          for (const m of exactActiveOther.slice(0, 4)) parts.push(fmtExact(m));
          if (exactActiveOther.length > 4)
            parts.push(`  ... y ${exactActiveOther.length - 4} mas`);
        }
      } else {
        // No description filter → show all exact active
        const label = config.totalSimilarResults
          ? `🔎 ${exactActive.length} exacta(s) activa(s):`
          : `${exact.length} coincidencia(s) exacta(s). ${exactActive.length} activa(s):`;
        parts.push(label);
        for (const m of exactActive.slice(0, 8)) parts.push(fmtExact(m));
        if (exactActive.length > 8)
          parts.push(`  ... y ${exactActive.length - 8} mas`);
      }

      if (exactInactive.length > 0) {
        parts.push(`+ ${exactInactive.length} exacta(s) inactiva(s)`);
      }
    } else {
      // All exact matches are inactive
      const statuses = [
        ...new Set(exactInactive.map((m) => m.status.split("(")[0].trim())),
      ].join(", ");
      parts.push(
        `${exact.length} coincidencia(s) exacta(s), pero todas inactivas (${statuses})`
      );
    }
  } else if (config.totalSimilarResults) {
    // No exact matches but there were search results
    parts.push(`Ninguna coincidencia exacta con "${config.brandName}"`);
  }

  // ── Similar matches summary (counts only — full data in matchGroups) ──
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

  // ── Determine status (ONLY from exact matches) ────────────────────
  const isTaken = hasFilter
    ? exactActiveRelevant.length > 0
    : exactActive.length > 0;

  // ── Build matchGroups (ALL matches, not truncated) ────────────────
  const matchGroups: MatchGroup[] = [];

  if (exact.length > 0) {
    matchGroups.push({
      level: "exact",
      label: `Coincidencias exactas (${exact.length})`,
      matches: exact,
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
    status: isTaken ? "taken" : "available",
    detail: parts.join("\n"),
    url: config.searchUrl,
    responseTimeMs: Date.now() - startTime,
    matchGroups,
  };
}
