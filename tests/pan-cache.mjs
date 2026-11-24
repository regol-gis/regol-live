import assert from "node:assert/strict";

export async function checkPanCache(browser, base) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  try {
    // Hold delivery of a real Wasm result while the camera and renderer keep moving.
    await page.addInitScript(() => {
      window.queryRequests = 0;
      window.Worker = class extends Worker {
        postMessage(message, ...args) {
          if (message.request?.sets) window.queryRequests++;
          super.postMessage(message, ...args);
        }
        constructor(url, options) {
          super(url, options);
          if (new URL(url, location.href).pathname !== "/worker.js") return;
          this.addEventListener("message", (e) => {
            if (e.data.type === "view" && window.holdView) {
              e.stopImmediatePropagation();
              window.releaseView = () => {
                window.holdView = false;
                this.dispatchEvent(new MessageEvent("message", { data: e.data }));
              };
              return;
            }
            if (e.data.type !== "result") return;
            window.resultIDs = e.data.features.map((f) => f.id);
            if (!window.holdResult) return;
            e.stopImmediatePropagation();
            window.releaseResult = () => {
              window.holdResult = false;
              window.releaseResult = null;
              this.dispatchEvent(new MessageEvent("message", { data: e.data }));
            };
          });
        }
      };
    });
    await page.goto(base + "/?dataset=monaco");
    const finished = () =>
      page.waitForFunction(() =>
        /\b(ms|s) · /.test(document.querySelector("#status").textContent),
      );
    const sizeReady = () => page.waitForFunction(() =>
      document.querySelector("#area-size").textContent.includes(" to fetch"));
    await sizeReady();
    assert.equal(await page.evaluate(() => window.queryRequests), 0);
    assert(await page.getByLabel("Update on pan").isChecked());
    // Obtain the running map at the normal viewport-query entry point.
    await page.evaluate(() => {
      const bounds = maplibregl.Map.prototype.getBounds;
      maplibregl.Map.prototype.getBounds = function () {
        window.testMap = this;
        maplibregl.Map.prototype.getBounds = bounds;
        return bounds.call(this);
      };
    });
    await page.selectOption("#dataset", "local-sample");
    await sizeReady();
    await page.evaluate(() => testMap.panBy([20, 0], { duration: 0 }));
    await sizeReady();
    await page.selectOption("#dataset", "monaco");
    await sizeReady();
    assert.equal(await page.evaluate(() => window.queryRequests), 0);
    assert.equal(await page.textContent("#count"), "0");
    await page.click("#run");
    await finished();
    assert.equal(await page.evaluate(() => window.queryRequests), 1);
    const original = await page.evaluate(() => testMap.getCenter().toArray());
    assert.equal(await page.evaluate(() => testMap.getPitch()), 0);
    const originalIDs = await page.evaluate(() => window.resultIDs);
    await page.locator(".result").first().click();
    const picked = await page.textContent("#detail-id");
    const pan = (center) =>
      page.evaluate((center) => {
        window.previousIDs = window.resultIDs;
        testMap.jumpTo({ center });
      }, center);
    await pan([original[0] - 0.014, original[1] - 0.003]);
    await page.waitForFunction(() => window.previousIDs !== window.resultIDs);
    await finished();
    const adjacentIDs = await page.evaluate(() => window.resultIDs);
    assert.equal(await page.textContent("#count"), String(adjacentIDs.length));
    assert.equal(await page.textContent("#detail-id"), picked);
    assert(await page.locator("#inspector").isVisible());
    const originalOnly = originalIDs.filter((id) => !adjacentIDs.includes(id));
    assert(originalOnly.length);
    await page.evaluate(() => {
      window.holdResult = true;
    });
    await pan([original[0] + 0.0001, original[1]]);
    await page.waitForFunction(() => !!window.releaseResult);
    await page.waitForFunction(
      (ids) =>
        testMap
          .queryRenderedFeatures({ layers: ["match-point", "match-fill"] })
          .some((f) => ids.includes(f.properties.fid)),
      originalOnly,
    );
    await pan(original);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("Cached view"),
    );
    // A superseded worker may still have a result queued for the main thread.
    await page.evaluate(() => window.releaseResult());
    assert.match(await page.textContent("#status"), /Cached view/);
    assert.equal(await page.textContent("#count"), String(originalIDs.length));
    await page.fill(
      "#selector",
      "$empty = n[amenity=nonexistent_regol_fixture]\nshow($empty)",
    );
    await page.click("#run");
    await finished();
    await page.waitForFunction(
      () =>
        testMap.isSourceLoaded("matches") &&
        !testMap.queryRenderedFeatures({
          layers: ["match-point", "match-fill"],
        }).length,
    );
    assert(await page.locator("#inspector").isHidden());
    const canvas = await page.locator(".maplibregl-canvas").boundingBox();
    const x = canvas.x + 24,
      y = canvas.y + canvas.height / 2;
    const center = await page.evaluate(() => testMap.getCenter().toArray());
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(x, y - 40);
    assert.equal(await page.evaluate(() => testMap.getPitch()), 20);
    await page.mouse.move(x - 48, y - 180);
    assert.equal(await page.evaluate(() => testMap.getPitch()), 60);
    await page.mouse.move(x - 48, y - 160);
    await page.mouse.up({ button: "middle" }); // Release over the sidebar.
    await page.mouse.move(x, y);
    assert.equal(await page.evaluate(() => testMap.getPitch()), 50);
    assert.equal(await page.evaluate(() => testMap.getBearing()), 0);
    assert.deepEqual(
      await page.evaluate(() => testMap.getCenter().toArray()),
      center,
    );
    assert.equal(await page.getByRole("button", { name: "Reset map view" }).count(), 0);
    // A late city lookup must respect a camera move even with auto-run off.
    await page.getByLabel("Update on pan").uncheck();
    await page.selectOption("#dataset", "custom");
    await page.fill("#url", base + "/data/monaco-2026-01-01.gol");
    await page.evaluate(() => { window.holdView = true; });
    await page.click("#run");
    await page.waitForFunction(() => !!window.releaseView);
    await pan([7.444, 43.75]);
    await page.evaluate(() => window.releaseView());
    await finished();
    assert.deepEqual(await page.evaluate(() => testMap.getCenter().toArray()), [7.444, 43.75]);
  } finally {
    await page.close();
  }
}
