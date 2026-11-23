import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { planetURL } from "../web/ranges.js";
import { planetGobURL } from "../web/gob-area.js";
import { planetCatalogURL, utcDate } from "../web/planet-files.js";

// geography.gob was exported from the adjacent synthetic geography.gol with
// GeoDesk's "gol save geography.gol geography.gob -w".
export async function checkGobArea(browser, base) {
  const gob = await readFile("tests/fixtures/geography.gob");
  const gol = await readFile("tests/fixtures/geography.gol");
  // Independently published snapshots with the same test geometries.
  gol[8] ^= 1;
  gol[128 + 64 * gol[16]] ^= 1;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const requests = [];
    let golHeads = 0;
    const yesterday = utcDate(Date.now() - 86400000);
    const datedGol = planetURL.replace("latest", yesterday);
    const datedGob = planetGobURL.replace("latest", yesterday);
    const record = (ext, stamp, updated = Date.now()) => ({
      extension: ext, remote_path: "osm/planet/" + ext, remote_version: ext === "gol" ? "v2" : "v1",
      remote_filename: `planet-${stamp}.osm.${ext}`, updated,
    });
    await context.route(planetCatalogURL, route => route.fulfill({ json: { files: [
      record("gol", "latest"), record("gol", yesterday), record("gob", yesterday),
    ] } }));
    for (const [url, file] of [[datedGob, gob], [datedGol, gol]]) {
      await context.route(url, async (route) => {
        const headers = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Content-Range, Content-Length, Last-Modified",
          "Last-Modified": "Sun, 22 Nov 2026 00:00:00 GMT",
          "Cache-Control": "no-store",
        };
        if (route.request().method() === "HEAD") {
          if (url === datedGol) golHeads++;
          return route.fulfill({ status: 200, headers: { ...headers, "Content-Length": String(file.length) } });
        }
        const match = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range);
        assert(match, "expected a single range request");
        const start = Number(match[1]), end = Math.min(Number(match[2]), file.length - 1);
        assert(start <= end);
        requests.push({ url, start, end });
        return route.fulfill({
          status: 206,
          headers: {
            ...headers, "Content-Range": `bytes ${start}-${end}/${file.length}`,
            "Content-Length": String(end + 1 - start),
          },
          body: file.subarray(start, end + 1),
        });
      });
    }

    // Search coordinates from the original store, plus an obsolete name and extent.
    const snapshot = "v1-c3914aabb90f3a49dd8e08a857c853abbd5ff9b122e16a05-d3eaf9634f18f844-16384";
    const directory = snapshot + "-0123456789abcdef";
    const index = base + "/datasets/planet.gol.areas/";
    await context.route(index + "manifest.json", route =>
      route.fulfill({ json: { version: 1, shards: 256, snapshot, storage: { format: "gzip", directory } } }));
    let manifestRequested;
    const stalled = new Promise(resolve => { manifestRequested = resolve; });
    await context.route("**/stalled-index/manifest.json", () => { manifestRequested(); });
    await page.exposeFunction("waitForStalledIndex", () => stalled);
    const courtyard = [-2140325369, -23865777];
    for (const [shard, name, probe] of [
      ["c8", "Courtyard", courtyard], ["b9", "Old Courtyard", courtyard], ["24", "Two Shells", [0, 2147483647]],
    ]) {
      await context.route(index + directory + "/" + shard + ".json.gz", route =>
        route.fulfill({ body: gzipSync(JSON.stringify([[name, [probe]]])) }));
    }
    await page.goto(base + "/build.json");
    const result = await page.evaluate(async ([url, gobURL]) => {
      const request = { windows: [[-1, -1, 1, 1]], selector: "nwr" };
      const worker = new Worker("/worker.js", { type: "module" });
      let id = 0;
      function requestWorker(type, terminal, next = true, query = request, downloadedOnly = false, publicPlanet = true) {
        return new Promise((resolve, reject) => {
          const watchdog = setTimeout(() => reject(Error("GOB worker timed out on " + type)), 15000);
          worker.onerror = (e) => { clearTimeout(watchdog); reject(Error(e.message)); };
          worker.onmessage = ({ data }) => {
            if (data.id !== id) return;
            if (data.type === terminal) { clearTimeout(watchdog); resolve(data); }
            else if (data.type === "error" || data.type === "transfer-limit") {
              clearTimeout(watchdog); reject(Error(data.message || data.type));
            }
          };
          worker.postMessage({ id: next ? ++id : id, url, gobURL, type, request: query, publicPlanet, downloadedOnly,
            areaIndex: new URL("/datasets/planet.gol.areas", location.href).href });
        });
      }
      try {
        const noDownload = await requestWorker("query", "outside-download", true, request, true);
        const plan = await requestWorker("plan-area", "area-estimate");
        const ready = await requestWorker("confirm-area", "area-ready", false);
        const inside = await requestWorker("query", "result", true, request, true);
        const outside = await requestWorker("query", "outside-download", true,
          { ...request, readWindows: [[-10,-10,10,10]] }, true);
        const direct = await requestWorker("query", "result", true, request, false, false);
        const suggestions = await requestWorker("suggest-tags", "suggestions");
        const { parseOverpass } = await import("/overpass.js");
        const namedPlan = await parseOverpass('area[name="Courtyard"]; out count;', request.windows);
        worker.postMessage({ id: ++id, url, gobURL, publicPlanet: true, type: "query",
          request: { ...namedPlan, windows: request.windows }, areaIndex: new URL("/stalled-index", location.href).href });
        await window.waitForStalledIndex();
        worker.postMessage({ id, type: "cancel-query" });
        const afterCancel = await requestWorker("query", "result", true, request, true);
        const namedQuery = async selector => requestWorker("query", "result", true, { windows: request.windows,
          ...await parseOverpass(selector + "; out count;", request.windows) });
        const named = await namedQuery('area[name="Courtyard"]');
        const retagged = await namedQuery('area[name="Courtyard"][tourism=theme_park]');
        const renamed = await namedQuery('area[name="Old Courtyard"]');
        const moved = await namedQuery('area[name="Two Shells"]');
        const imported = await requestWorker("query", "result");
        const cached = await requestWorker("estimate-area", "area-estimate");
        return { noDownload, direct, plan, ready, inside, outside, afterCancel, suggestions, named, retagged, renamed, moved, imported, cached };
      } finally { worker.terminate(); }
    }, [datedGol, datedGob]);
    const { direct, plan, ready, suggestions, named, retagged, renamed, moved, imported, cached } = result;
    assert.equal(result.noDownload.type, "outside-download");
    assert.equal(result.inside.transport, "gob");
    assert.equal(result.inside.gets, 0);
    assert.equal(result.afterCancel.transport, "gob");
    assert.equal(result.afterCancel.gets, 0);
    assert.deepEqual(result.afterCancel.features, result.inside.features);
    assert.equal(result.outside.type, "outside-download");
    assert.notEqual(direct.transport, "gob", "a direct GOL query uses its own reader");
    const length = gob.readUInt32LE(68);
    assert.equal(plan.transport, "gob");
    assert.equal(plan.tiles, 1);
    assert.equal(plan.missing, length);
    assert.equal(plan.total, length);
    assert.equal(ready.transport, "gob");
    assert.equal(ready.bytes, length);
    assert(suggestions.complete && suggestions.items.length > 0, "tag completion works with a downloaded area");
    assert.notEqual(named.transport, "gob", "named areas can be outside the GOB view");
    assert.equal(named.counts.areas, 1, "a store rebuild preserves geographic search hints");
    for (const lookup of [retagged, renamed, moved]) assert.equal(lookup.counts.total, 0);
    assert.equal(imported.transport, "gob");
    assert.notEqual(imported.snapshot, direct.snapshot);
    assert.equal(imported.gets, 0);
    const byID = (a, b) => a.id.localeCompare(b.id);
    assert(direct.features.length > 2);
    assert.deepEqual(imported.features.sort(byID), direct.features.sort(byID));
    assert.equal(imported.skippedGeometries, direct.skippedGeometries);
    assert.equal(cached.missing, 0);
    const ranges = requests.filter((r) => r.url === datedGob);
    assert.equal(ranges.reduce((n, r) => n + r.end + 1 - r.start, 0), gob.length);
    assert.equal(golHeads, 1, "alternating between GOB and GOL keeps the open GOL reader");

    await page.goto(base + "/?dataset=planet");
    const golReads = () => golHeads + requests.filter(r => r.url === datedGol).length;
    const before = golReads();
    const run = page.locator("#run");
    const warning = page.getByRole("dialog", { name: "Run a live GOL query?" });
    await run.click();
    await warning.waitFor();
    assert.equal(await page.textContent("#dataset-date"),
      new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(yesterday)));
    await page.keyboard.press("Escape");
    await warning.waitFor({ state: "hidden" });
    assert.equal(golReads(), before);
    await run.click();
    await warning.getByRole("button", { name: "Download this area" }).click();
    await page.click("#confirm-area");
    const finished = () => page.waitForFunction(() => /\b(ms|s) · /.test(document.getElementById("status").textContent));
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("Area ready"));
    await run.click();
    await finished();
    assert.equal(golReads(), before, "downloading and running the viewport query uses only the GOB");
    await page.getByRole("radio", { name: "Overpass QL", exact: true }).check();
    await page.fill("#selector", '[timeout:1];area[name="Courtyard"]; out count;');
    await run.click();
    await warning.waitFor();
    await page.waitForTimeout(1200);
    assert(await warning.isVisible(), "the query timeout pauses while the user chooses");
    assert.equal(golReads(), before);
    await warning.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.fill("#selector", 'node({{bbox}}); out count;');
    await run.click();
    await finished();
    assert.equal(golReads(), before, "cancelling the warning preserves the confirmed download");
    await page.fill("#selector", 'area[name="Courtyard"]; out count;');
    await run.click();
    await warning.getByLabel("Don’t show again").check();
    await warning.getByRole("button", { name: "Run anyway" }).click();
    await finished();
    assert(golReads() > before);
    const after = golReads();
    await run.click();
    await finished();
    assert.equal(golReads(), after, "repeating the live query uses its warm GOL cache");
    await page.reload();
    await run.click();
    await finished();
    assert(golReads() > after, "the opt-out survives a reload with a cold worker");
    await page.waitForFunction(() => document.getElementById("area-size").textContent.startsWith("0 MB / "));
  } finally {
    await context.close();
  }
}
