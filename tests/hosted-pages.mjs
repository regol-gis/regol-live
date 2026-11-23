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
    const sizeReady = () => page.waitForFunction(() => document.getElementById("area-size").textContent.includes(" MB / "));
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
    await pan(center, 16);
    await page.waitForFunction(() => queries.includes(true));
    await finished();
    await sizeReady();
    const before = await page.evaluate(() => queries.length);
    await pan([7.49, 43.77], 16);
    await sizeReady();
    assert(await auto.isDisabled());
    assert.equal(await page.evaluate(() => queries.length), before);
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
  } finally {
    await context.close();
  }
}
