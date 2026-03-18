import { createServer } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBrandAvailability } from "./checker.js";
import { loadHistory, clearHistory } from "./history.js";
import type { BrandCheckResponse } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3456;

// ── In-memory cache with 10-minute TTL ────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map<string, { result: BrandCheckResponse; timestamp: number }>();

function getCacheKey(name: string, description?: string): string {
  return `${name.toLowerCase().trim()}|${(description || "").toLowerCase().trim()}`;
}

function getCached(key: string): BrandCheckResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key: string, result: BrandCheckResponse): void {
  cache.set(key, { result, timestamp: Date.now() });
}

const server = createServer(async (req, res) => {
  // API: check brand
  if (req.method === "POST" && req.url === "/api/check") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const { name, description } = JSON.parse(body);
      if (!name || typeof name !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Falta el campo 'name'" }));
        return;
      }
      if (name.length > 100) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Nombre muy largo (max 100)" }));
        return;
      }

      const cacheKey = getCacheKey(name, description);
      const cached = getCached(cacheKey);
      if (cached) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-Cache": "HIT",
        });
        res.end(JSON.stringify(cached));
        return;
      }

      const result = await checkBrandAvailability({
        name,
        description: description || undefined,
      });
      setCache(cacheKey, result);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Cache": "MISS",
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Error interno",
        })
      );
    }
    return;
  }

  // API: get history
  if (req.method === "GET" && req.url === "/api/history") {
    try {
      const history = await loadHistory();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(history));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Error leyendo historial" }));
    }
    return;
  }

  // API: clear history
  if (req.method === "DELETE" && req.url === "/api/history") {
    try {
      await clearHistory();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Error limpiando historial" }));
    }
    return;
  }

  // API: export results to PDF or CSV
  if (req.method === "POST" && req.url === "/api/export") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const { results, format } = JSON.parse(body);

      if (!results || !Array.isArray(results) || results.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Faltan resultados para exportar" }));
        return;
      }
      if (format !== "pdf" && format !== "csv") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Formato debe ser 'pdf' o 'csv'" }));
        return;
      }

      const { exportToPDF, exportToCSV } = await import("./export.js");
      const ext = format === "pdf" ? "pdf" : "csv";
      const tmpPath = join(__dirname, "..", "data", `export-${Date.now()}.${ext}`);

      if (format === "pdf") {
        await exportToPDF(results, tmpPath);
      } else {
        await exportToCSV(results, tmpPath);
      }

      const fileData = await readFile(tmpPath);
      const contentType =
        format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8";

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="brand-check-${Date.now()}.${ext}"`,
      });
      res.end(fileData);

      unlink(tmpPath).catch(() => {});
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Error exportando",
        })
      );
    }
    return;
  }

  // Serve index.html
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      const html = await readFile(
        join(__dirname, "..", "public", "index.html"),
        "utf-8"
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error leyendo index.html");
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\nBrand Checker corriendo en http://localhost:${PORT}\n`);
});
