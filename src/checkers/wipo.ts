import { chromium } from "playwright";
import type { CheckResult, TrademarkMatch, SimilarityLevel } from "../types.js";
import { processTrademarkMatches } from "./trademark-engine.js";

const SEARCH_URL = "https://branddb.wipo.int/en/similarname";

/** Max results to request from WIPO */
const WIPO_MAX_ROWS = 100;

/**
 * Parse a single WIPO result card text block into a TrademarkMatch.
 * Returns null if the card is malformed or doesn't pass the similarity filter.
 */
function parseWIPOCard(
  text: string,
  brandName: string
): TrademarkMatch | null {
  if (!text.includes("Nice class") && !text.includes("Owner")) return null;

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const brand = lines[0] || "";

  const niceIdx = lines.findIndex((l) => l === "Nice class");
  const niceRaw = niceIdx >= 0 ? lines[niceIdx + 1] || "" : "";
  const niceClasses = niceRaw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));

  const ownerIdx = lines.findIndex((l) => l === "Owner");
  const owner = ownerIdx >= 0 ? lines[ownerIdx + 1] || "" : "";

  const countryIdx = lines.findIndex((l) => l === "Country of filing");
  const country = countryIdx >= 0 ? lines[countryIdx + 1] || "" : "";

  const statusIdx = lines.findIndex((l) => l === "Status");
  const status = statusIdx >= 0 ? lines[statusIdx + 1] || "" : "";

  const iprIdx = lines.findIndex((l) => l === "IPR");
  const ipr = iprIdx >= 0 ? lines[iprIdx + 1] || "" : "";

  const numIdx = lines.findIndex((l) => l === "Number");
  const number = numIdx >= 0 ? lines[numIdx + 1] || "" : "";

  // Compute similarity level
  const brandNorm = brand.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const searchNorm = brandName.toUpperCase().replace(/[^A-Z0-9]/g, "");

  let similarityLevel: SimilarityLevel;
  if (brandNorm === searchNorm) {
    similarityLevel = "exact";
  } else if (
    brandNorm.includes(searchNorm) || searchNorm.includes(brandNorm)
  ) {
    similarityLevel = "contains";
  } else {
    // WIPO already does similarity matching server-side, so anything
    // returned that isn't exact or contains is a partial match
    similarityLevel = "partial";
  }

  // Filter out results that have no similarity at all
  if (
    similarityLevel !== "exact" &&
    similarityLevel !== "contains" &&
    !brandNorm.includes(searchNorm) &&
    !searchNorm.includes(brandNorm)
  ) {
    // Still keep — WIPO's server already filtered for similarity
  }

  const isActive =
    status.toLowerCase().includes("registered") ||
    status.toLowerCase().includes("active") ||
    status.toLowerCase().includes("pending") ||
    status.toLowerCase().includes("protected");

  const isExactMatch = similarityLevel === "exact";

  return {
    brandName: brand,
    owner,
    niceClasses,
    status,
    isActive,
    isExactMatch,
    similarityLevel,
    sourceId: number,
    country,
    ipr,
  };
}

/**
 * Scroll through the WIPO results by scrolling the VIEWPORT (window).
 * WIPO uses Intersection Observer lazy rendering — LI elements only get
 * populated with real content when they enter the browser viewport.
 * The ul.results itself is NOT scrollable (scrollHeight === clientHeight).
 *
 * Strategy: scroll window in steps, at each step batch-extract all
 * populated card texts via a single page.evaluate(), parse them,
 * and deduplicate.
 */
async function scrapeWithScroll(
  page: import("playwright").Page,
  brandName: string
): Promise<TrademarkMatch[]> {
  const matches: TrademarkMatch[] = [];
  const seen = new Set<string>();

  const totalHeight = await page.evaluate(
    () => document.documentElement.scrollHeight
  );
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const scrollStep = Math.max(Math.floor(viewportHeight * 0.5), 300);

  let currentScroll = 0;

  while (currentScroll <= totalHeight) {
    // Scroll the viewport
    await page.evaluate((top) => window.scrollTo(0, top), currentScroll);
    await page.waitForTimeout(300);

    // Batch-extract all currently populated card texts in one evaluate
    const cardTexts: string[] = await page.evaluate(() => {
      const cards = document.querySelectorAll("li.result");
      const texts: string[] = [];
      cards.forEach((card) => {
        const el = card as HTMLElement;
        const raw = el.textContent || "";
        if (
          raw.length > 30 &&
          (raw.includes("Owner") || raw.includes("Nice class"))
        ) {
          texts.push(el.innerText);
        }
      });
      return texts;
    });

    for (const text of cardTexts) {
      const match = parseWIPOCard(text, brandName);
      if (!match) continue;

      const key = `${match.brandName}|${match.sourceId}|${match.niceClasses.join(",")}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push(match);
      }
    }

    currentScroll += scrollStep;
  }

  return matches;
}

/**
 * Check brand name on WIPO Global Brand Database (worldwide trademarks).
 *
 * Flow:
 * 1. Navigate to branddb.wipo.int/en/similarname
 * 2. Altcha proof-of-work CAPTCHA auto-solves
 * 3. Intercept request to use rows=100 (skips default 30 + re-navigation)
 * 4. Fill name, click search → loads 100 results directly
 * 5. Scroll through virtual list to trigger lazy rendering
 * 6. Scrape rendered cards → TrademarkMatch[] → shared engine
 */
export async function checkWIPO(
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
      locale: "en-US",
      timezoneId: "America/Argentina/Buenos_Aires",
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();

    // Navigate to search page
    await page.goto(SEARCH_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for Altcha captcha to auto-solve and page to render
    await page.waitForSelector("button:has-text('Search')", {
      timeout: 30000,
    });

    // Fill search input (no extra wait — selector confirms page is ready)
    const searchInput = page.locator("input[type='text']:visible").first();
    await searchInput.click();
    await searchInput.fill(brandName.toUpperCase());

    // Intercept navigation to request max rows instead of default 30
    // Eliminates the need for a second page load (saves ~10s)
    await page.route(/rows=30/, (route) => {
      route.continue({
        url: route.request().url().replace("rows=30", `rows=${WIPO_MAX_ROWS}`),
      });
    });

    // Click Search
    await page.click("button:has-text('Search')");

    // Wait for results to render (event-based, replaces fixed 8s×2 waits)
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return (
          text.includes("Displaying") ||
          text.includes("No results") ||
          text.includes("0 results")
        );
      },
      { timeout: 30000 }
    );
    await page.waitForTimeout(1500); // Buffer for lazy rendering of virtual list

    // Check if we got results
    const pageText = await page.innerText("body");
    const countMatch = pageText.match(
      /Displaying \d+-\d+ of ([\d,]+) results/
    );
    const totalResults = countMatch
      ? parseInt(countMatch[1].replace(/,/g, ""), 10)
      : 0;

    if (totalResults === 0) {
      const hasNoResults =
        pageText.includes("No results") ||
        pageText.includes("0 results");

      await browser.close();
      browser = undefined;

      if (hasNoResults) {
        return processTrademarkMatches(
          [],
          {
            platform: "wipo",
            displayName: "WIPO (Mundial)",
            searchUrl: SEARCH_URL,
            description,
            brandName,
          },
          start
        );
      }

      return {
        platform: "wipo",
        displayName: "WIPO (Mundial)",
        status: "unknown",
        detail: `No se pudo obtener resultados de WIPO. Verificar manualmente.`,
        url: SEARCH_URL,
        responseTimeMs: Date.now() - start,
      };
    }

    // ── Scroll through virtual list and scrape all cards ────────────
    const matches = await scrapeWithScroll(page, brandName);

    await browser.close();
    browser = undefined;

    // ── Delegate to the shared trademark engine ─────────────────────
    return processTrademarkMatches(
      matches,
      {
        platform: "wipo",
        displayName: "WIPO (Mundial)",
        searchUrl: SEARCH_URL,
        description,
        brandName,
        totalSimilarResults: totalResults,
      },
      start
    );
  } catch (error) {
    return {
      platform: "wipo",
      displayName: "WIPO (Mundial)",
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
