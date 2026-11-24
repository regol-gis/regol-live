import assert from "node:assert/strict";

export async function checkHostedPages(browser, base) {
  const context = await browser.newContext();
  await context.route(base + "/site-mode.js", route =>
    route.fulfill({ contentType: "text/javascript",
      body: 'export * from "./site-mode.js?defaults"; export const hostedPages = true;' }));
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.queries = [];
    window.Worker = class extends Worker {
      postMessage(message, ...args) {
        if (message.request?.sets) window.queries.push(message.downloadedOnly === true);
        super.postMessage(message, ...args);
        if (message.request?.sets && window.switchDuringQuery) {
          const radio = window.switchDuringQuery;
          window.switchDuringQuery = null;
          queueMicrotask(() => radio.click());
        }
      }
    };
  });
  try {
    await page.goto(base + "/?dataset=monaco");
    const intro = page.getByRole("dialog", { name: "Explore an area" });
    await intro.waitFor();
    assert((await intro.innerText()).includes("Download this area"));
    await intro.getByRole("button").click();
    await page.reload();
    await page.waitForFunction(() => !document.getElementById("run").disabled);
    assert(!(await intro.isVisible()));
    const auto = page.getByLabel("Update on pan");
    assert(await auto.isDisabled());
    assert.equal(await page.locator('#example option[value="Bus routes serving selected stops"]').count(), 0);
    await page.getByRole("radio", { name: "Overpass QL" }).check();
    assert.equal(await page.locator('#example option[value="Routes serving stops in view"]').count(), 0);
    await page.fill("#selector", "node[public_transport=stop_position]({{bbox}})->.stops; rel(bn.stops)[type=route]; out center;");
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("requires the local server"));
    assert.deepEqual(await page.evaluate(() => queries), []);
    await page.getByRole("radio", { name: "GOQL" }).check();
    await page.fill("#selector", "$stops = n[highway=bus_stop]\n$routes = r | parents_of($stops)\nshow($routes)");
    await page.click("#run");
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("requires the local server"));
    assert.deepEqual(await page.evaluate(() => queries), []);
    await page.fill("#selector", "n[amenity=cafe]");
    // Capture the map when the app next resolves the viewport.
    await page.evaluate(() => {
      const original = maplibregl.Map.prototype.getBounds;
      maplibregl.Map.prototype.getBounds = function () {
        window.testMap = this;
        maplibregl.Map.prototype.getBounds = original;
        return original.call(this);
      };
    });
    await page.click("#run");
    const finished = () => page.waitForFunction(() => /\b(ms|s) · /.test(document.getElementById("status").textContent));
    await finished();
    const sizeReady = () => page.waitForFunction(() => document.getElementById("area-size").textContent.includes(" to fetch"));
    await sizeReady();
    const center = await page.evaluate(() => testMap.getCenter().toArray());
    const pan = (center, zoom) => page.evaluate(([center, zoom]) => testMap.jumpTo({ center, zoom }), [center, zoom]);
    await pan(center, 14);
    await sizeReady();
    assert.deepEqual(await page.evaluate(() => queries), [false]);
    await page.click("#download-area");
    await page.click("#confirm-area");
    await page.waitForFunction(() => !document.getElementById("auto").disabled);
    assert(await auto.isChecked());
    const outline = () => page.evaluate(() => testMap.getSource("downloaded-area").getData());
    const downloaded = await outline();
    assert.equal(await page.evaluate(() => testMap.getStyle().layers.some(
      layer => layer.source === "downloaded-area" && layer.type === "fill")), false);
    assert.equal(downloaded.geometry.type, "MultiLineString");
    assert(await page.locator("#downloaded-legend").isVisible());
    const bounds = await page.evaluate(() => testMap.getBounds().toArray());
    const ring = downloaded.geometry.coordinates[0];
    for (const [corner, expected] of [[ring[0], bounds[0]], [ring[2], bounds[1]]])
      assert(corner.every((value, i) => Math.abs(value - expected[i]) < 1e-9));
    await pan(center, 16);
    await page.waitForFunction(() => queries.includes(true));
    await finished();
    await sizeReady();
    // Switch after compilation dispatches the query and before the worker can
    // return its result. Each language must then search the same pinned pages.
    const transfers = [];
    context.on("request", req => { if (req.url().endsWith(".gol")) transfers.push(req.url()); });
    for (const [language, selector] of [
      ["Overpass QL", "node[amenity=cafe]({{bbox}}); out count;"],
      ["GOQL", "n[amenity=cafe]"],
    ]) {
      const radio = page.getByRole("radio", { name: language, exact: true });
      await radio.evaluate(el => { window.switchDuringQuery = el; });
      await page.click("#run");
      await page.waitForFunction(() => !window.switchDuringQuery && document.getElementById("status").textContent === "Ready to run.");
      assert(await radio.isChecked());
      assert(await auto.isChecked());
      await page.fill("#selector", selector);
      await page.click("#run");
      await finished();
      assert.match(await page.textContent("#status"), /Cached · 0 ranges/);
    }
    assert.deepEqual(transfers, []);
    assert.deepEqual(await outline(), downloaded);
    const before = await page.evaluate(() => queries.length);
    await pan([7.49, 43.77], 16);
    await sizeReady();
    assert(await auto.isDisabled());
    assert.equal(await page.evaluate(() => queries.length), before);
    assert.deepEqual(await outline(), downloaded);
    await page.click("#download-area");
    await page.keyboard.press("Escape");
    assert.deepEqual(await outline(), downloaded);
    await page.click("#run");
    await finished();
    assert.equal(await page.evaluate(() => queries.at(-1)), false);
    await pan(center, 17);
    await page.waitForFunction(() => !document.getElementById("auto").disabled && queries.at(-1));
    await finished();
    await auto.uncheck();
    await pan([7.49, 43.77], 16);
    await sizeReady();
    await pan(center, 16);
    await sizeReady();
    assert(!(await auto.isChecked()));
    await page.selectOption("#dataset", "custom");
    assert(!(await page.locator("#downloaded-legend").isVisible()));
    assert.deepEqual((await outline()).features, []);
  } finally {
    await context.close();
  }
}
