import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import sirv from "sirv";

const assets = sirv(process.argv[2] || "dist");
const server = createServer((req, res) => {
  if (req.url === "/") res.writeHead(200, { "Content-Type": "text/html" }).end("<title>London benchmark</title>");
  else assets(req, res, () => res.writeHead(404).end());
});
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/chromium" });
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  for (const selector of ["na[amenity=cafe]", "n[railway=station]"]) {
    const page = await browser.newPage(); // Fresh browser storage and worker for each selector.
    await page.goto("http://127.0.0.1:" + server.address().port);
    const rows = await page.evaluate(async (selector) => {
      const { planetURL } = await import("./ranges.js");
      const worker = new Worker("./worker.js", { type: "module" });
      const request = {
        windows: [[-0.178, 51.482, -0.078, 51.532]],
        sets: [{ name: "matches", source: selector }], show: ["matches"],
      };
      let id = 0;
      function run(type) {
        return new Promise((resolve, reject) => {
          worker.onerror = (e) => reject(Error(e.message));
          worker.onmessage = ({ data }) => {
            if (data.type === "error") reject(Error(data.message));
            if (data.type === "transfer-limit") reject(Error("Query reached its transfer allowance"));
            if (data.type === "result" || data.type === "area-estimate") resolve(data);
          };
          worker.postMessage({ id: ++id, type, request, url: planetURL, pauseAtTransferLimit: true });
        });
      }
      try {
        // Model both a settled map and a click on Run before the estimate.
        if (selector === "na[amenity=cafe]") await run("estimate-area");
        const rows = [];
        for (const pass of ["cold", "warm"]) {
          const result = await run("query");
          if (result.limited) throw Error("Partial results: " + result.limited);
          const bytes = new TextEncoder().encode(JSON.stringify(result.features));
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
          rows.push({ selector, pass, snapshot: result.snapshot, ms: Math.round(result.elapsed),
            gets: result.gets, bytes: result.bytes, matches: result.features.length,
            sha256: Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("") });
        }
        return rows;
      } finally {
        worker.terminate();
      }
    }, selector);
    assert.equal(rows[0].sha256, rows[1].sha256);
    for (const row of rows) console.log(JSON.stringify(row));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
