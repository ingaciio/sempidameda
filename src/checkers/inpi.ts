import { chromium } from "playwright";
import type { CheckResult, TrademarkMatch, SimilarityLevel } from "../types.js";
import { processTrademarkMatches } from "./trademark-engine.js";

const SEARCH_URL =
  "https://portaltramites.inpi.gob.ar/marcasconsultas/busqueda/?Cod_Funcion=NQA0ADEA";

const API_URL = "/MarcasConsultas/GrillaMarcasAvanzada";

interface INPIRow {
  Acta: number;
  Denominacion: string;
  Titulares: string;
  Clase: number;
  Tipo_Marca: string;
  Estado: string;
  Numero_Resolucion: string;
}

interface INPIResponse {
  total: number;
  rows: INPIRow[];
}

const ESTADO_LABELS: Record<string, string> = {
  C: "Concedida",
  T: "En Tramite",
  A: "Abandonada",
  D: "Denegada",
  N: "Nula",
  V: "Vencida",
};

// ── Similarity helpers ──────────────────────────────────────────────

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Simple Levenshtein distance — good enough for short brand names */
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

function computeSimilarityLevel(
  denomination: string,
  brandName: string
): SimilarityLevel {
  const denomNorm = normalize(denomination);
  const searchNorm = normalize(brandName);

  // Exact
  if (denomNorm === searchNorm) return "exact";

  // Contains: one is substring of the other
  if (denomNorm.includes(searchNorm) || searchNorm.includes(denomNorm)) {
    return "contains";
  }

  // Partial: Levenshtein distance <= 2 on normalized strings
  const dist = levenshtein(denomNorm, searchNorm);
  if (dist <= 2) return "partial";

  // Also check if any single word in the denomination is close
  const words = denomination
    .toUpperCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Z0-9]/g, ""))
    .filter((w) => w.length >= 2);

  for (const word of words) {
    if (word === searchNorm) return "contains";
    if (word.includes(searchNorm) || searchNorm.includes(word)) return "contains";
    if (levenshtein(word, searchNorm) <= 2) return "partial";
  }

  return "partial"; // if it came from the API, it has some relevance
}

/** Map an INPI row to the shared TrademarkMatch format */
function toTrademarkMatch(row: INPIRow, brandName: string): TrademarkMatch {
  const isActive = row.Estado === "C" || row.Estado === "T";
  const titular = row.Titulares
    ? row.Titulares.split(" 100")[0].split(" 50")[0].trim()
    : "Sin titular";

  const similarityLevel = computeSimilarityLevel(
    row.Denominacion.trim(),
    brandName
  );
  const isExactMatch = similarityLevel === "exact";

  return {
    brandName: row.Denominacion.trim(),
    owner: titular,
    niceClasses: [row.Clase],
    status: ESTADO_LABELS[row.Estado] || row.Estado,
    isActive,
    isExactMatch,
    similarityLevel,
    sourceId: String(row.Acta),
  };
}

// ── Paginated API fetch ─────────────────────────────────────────────

/**
 * Fetch paginated results from the INPI API.
 * Uses the browser page context (cookies/session) to make direct POST calls.
 * Paginates through ALL results (PAGE_SIZE=200, up to MAX_ROWS=2000 safety cap).
 */
async function fetchINPIRows(
  page: import("playwright").Page,
  searchTerm: string
): Promise<{ total: number; rows: INPIRow[] }> {
  const PAGE_SIZE = 200;
  const MAX_ROWS = 2000;
  const allRows: INPIRow[] = [];
  let total = 0;
  let offset = 0;

  do {
    const response: INPIResponse | null = await page.evaluate(
      async (params) => {
        const res = await fetch("/MarcasConsultas/GrillaMarcasAvanzada", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({
            Tipo_Resolucion: "",
            Clase: "-1",
            TipoBusquedaDenominacion: "1",
            Denominacion: params.searchTerm,
            Titular: "",
            TipoBusquedaTitular: "0",
            Fecha_IngresoDesde: "",
            Fecha_IngresoHasta: "",
            Fecha_ResolucionDesde: "",
            Fecha_ResolucionHasta: "",
            vigentes: false,
            limit: params.limit,
            offset: params.offset,
          }),
        });
        return res.json();
      },
      { searchTerm: searchTerm.toUpperCase(), limit: PAGE_SIZE, offset }
    );

    if (!response || !response.rows?.length) break;

    total = response.total;
    allRows.push(...response.rows);
    offset += PAGE_SIZE;
  } while (offset < total && offset < MAX_ROWS);

  return { total, rows: allRows };
}

// ── Multi-term search ───────────────────────────────────────────────

/**
 * For compound names ("Hoja Verde"), search for:
 *   1. The full phrase: "HOJA VERDE"
 *   2. Each individual word: "HOJA", "VERDE"
 * Deduplicate by Acta (sourceId).
 */
async function fetchMultiTermRows(
  page: import("playwright").Page,
  brandName: string
): Promise<{ totalFromApi: number; rows: INPIRow[] }> {
  const words = brandName
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  // Always search the full phrase
  const searchTerms = [brandName.trim()];

  // If compound (2+ words), also search each word individually
  if (words.length >= 2) {
    for (const word of words) {
      if (!searchTerms.includes(word)) {
        searchTerms.push(word);
      }
    }
  }

  const seen = new Set<number>();
  const allRows: INPIRow[] = [];
  let maxTotal = 0;

  for (const term of searchTerms) {
    const { total, rows } = await fetchINPIRows(page, term);
    if (total > maxTotal) maxTotal = total;

    for (const row of rows) {
      if (!seen.has(row.Acta)) {
        seen.add(row.Acta);
        allRows.push(row);
      }
    }
  }

  return { totalFromApi: maxTotal, rows: allRows };
}

// ── Main export ─────────────────────────────────────────────────────

export async function checkINPI(
  brandName: string,
  description?: string
): Promise<CheckResult> {
  const start = Date.now();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "es-AR",
      timezoneId: "America/Argentina/Buenos_Aires",
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();

    // Navigate to establish session cookies
    await page.goto(SEARCH_URL, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Multi-term search: full phrase + individual words (if compound)
    const { totalFromApi, rows } = await fetchMultiTermRows(page, brandName);

    await browser.close();
    browser = undefined;

    // ── No data from INPI ─────────────────────────────────────────────
    if (rows.length === 0) {
      return processTrademarkMatches(
        [],
        {
          platform: "inpi",
          displayName: "INPI Argentina",
          searchUrl: SEARCH_URL,
          description,
          brandName,
        },
        start
      );
    }

    // ── Map ALL rows to TrademarkMatch with similarity levels ──────────
    const allMatches = rows.map((r) => toTrademarkMatch(r, brandName));

    return processTrademarkMatches(
      allMatches,
      {
        platform: "inpi",
        displayName: "INPI Argentina",
        searchUrl: SEARCH_URL,
        description,
        brandName,
        totalSimilarResults: totalFromApi,
      },
      start
    );
  } catch (error) {
    return {
      platform: "inpi",
      displayName: "INPI Argentina",
      status: "unknown",
      detail: `Error: ${error instanceof Error ? error.message : "Desconocido"}. Verificar manualmente.`,
      url: SEARCH_URL,
      responseTimeMs: Date.now() - start,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
