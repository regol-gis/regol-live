// Compare the GOB download and out-of-area member fetch against the live GOL.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import sirv from "sirv";

const assets = sirv(process.argv[2] ?? "dist");
const server = createServer((req, res) => {
  if (req.url === "/") res.writeHead(200, { "Content-Type": "text/html" }).end("<title>London GOB benchmark</title>");
  else assets(req, res);
});
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/chromium" });
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  const report = await page.evaluate(async () => {
    const { discoverPlanetFiles } = await import("./planet-files.js");
    const { gol, gob } = await discoverPlanetFiles();
    if (!gob) throw Error("The catalog has no same-date GOL and GOB for the benchmark.");
    const selectors = [
      "na[amenity=cafe]", "n[railway=station]", "a[leisure=park]", "r[route=bus][ref=24]",
      'r[route=subway][ref=Central][from="Ealing Broadway"][to=Loughton]',
    ];
    const windows = [[-0.178, 51.482, -0.078, 51.532]];
    async function measure(activate) {
      const worker = new Worker("./worker.js", { type: "module" });
      let id = 0;
      function send(type, end, request, reuse = false) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("Timed out waiting for " + type)), 120000);
          worker.onerror = (e) => { clearTimeout(timer); reject(Error(e.message)); };
          worker.onmessage = ({ data }) => {
            if (data.type === end) { clearTimeout(timer); resolve(data); }
            if (["error", "transfer-limit", "area-fallback"].includes(data.type)) {
              clearTimeout(timer); reject(Error(data.message || data.type));
            }
          };
          worker.postMessage({ id: reuse ? id : ++id, type, url: gol.url, gobURL: gob.url, request,
            golDate: gol.dated ? null : gol.date, gobDate: gob.dated ? null : gob.date,
            publicPlanet: true, pauseAtTransferLimit: true });
        });
      }
      const queries = [];
      let area;
      try {
        const start = performance.now();
        if (activate) {
          const plan = await send("plan-area", "area-estimate", { windows });
          if (plan.transport !== "gob") throw Error("The GOB estimate is unavailable");
          const estimated = performance.now();
          const ready = await send("confirm-area", "area-ready", { windows }, true);
          if (ready.transport !== "gob") throw Error("The worker fell back to GOL during the download");
          area = { tiles: plan.tiles, estimatedTileBytes: plan.total, planBytes: plan.bytes,
            tileBytes: ready.bytes, planMs: Math.round(estimated - start),
            importAndDownloadMs: Math.round(performance.now() - estimated),
            wasmMemoryBytes: ready.wasmMemoryBytes };
        }
        let firstResultMs;
        for (const selector of selectors) {
          const result = await send("query", "result", {
            windows, sets: [{ name: "matches", source: selector }], show: ["matches"],
          });
          firstResultMs ??= Math.round(performance.now() - start);
          if (activate && result.transport !== "gob") throw Error("Unexpected GOL fallback for " + selector);
          if (result.limited) throw Error("Partial results for " + selector);
          const features = result.features.sort((a, b) => a.id.localeCompare(b.id));
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(features))));
          queries.push({ selector, matches: features.length, skipped: result.skippedGeometries,
            skippedReferences: result.skippedReferences, ms: Math.round(result.elapsed),
            bytes: result.bytes, gets: result.gets, snapshot: result.snapshot,
            sha256: Array.from(hash, b => b.toString(16).padStart(2, "0")).join("") });
        }
        return { area, firstResultMs, queries };
      } finally { worker.terminate(); }
    }
    return { gob: await measure(true), gol: await measure(false) };
  });
  console.log(JSON.stringify(report, null, 2));
  for (const [index, query] of report.gob.queries.entries()) {
    const reference = report.gol.queries[index];
    assert(query.matches > 0, query.selector);
    for (const field of ["snapshot", "sha256", "skipped", "skippedReferences"])
      assert.equal(query[field], reference[field], query.selector + " " + field);
  }
} finally {
  await browser.close();
  server.close();
}
