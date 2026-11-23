import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { text } from "node:stream/consumers";

export async function checkMapExport(browser, base) {
  const context = await browser.newContext({
    viewport: { width: 1050, height: 720 },
  });
  const dir = await mkdtemp(join(tmpdir(), "regol-export-map-"));
  try {
    await context.addInitScript(() => {
      let library;
      Object.defineProperty(window, "maplibregl", {
        get: () => library,
        set(value) {
          library = value;
          library.Map = class extends value.Map {
            constructor(options) {
              super(options);
              window.testMap = this;
            }
          };
        },
      });
    });
    const page = await context.newPage();
    await page.route("https://tiles.openfreemap.org/styles/liberty", (route) =>
      route.fulfill({
        json: {
          version: 8,
          name: "</script><script>window.executed = true</script>",
          sources: {},
          layers: [
            {
              id: "paper",
              type: "background",
              paint: { "background-color": "#ddeeff" },
            },
          ],
        },
      }),
    );
    await page.goto(base + "/?dataset=monaco");
    await page.click("#run");
    await page.waitForFunction(
      () => Number(document.querySelector("#count").textContent) > 0,
    );
    await page.uncheck("#auto");
    await page.evaluate(() => testMap.jumpTo({ bearing: 24, pitch: 40 }));
    await page.waitForFunction(
      () =>
        testMap.loaded() &&
        testMap.queryRenderedFeatures({ layers: ["match-point"] }).length > 0,
    );
    const download = async (format) => {
      await page.getByLabel("Export format").selectOption(format);
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const file = await pending;
      assert.equal(file.suggestedFilename(), "regol-map." + format);
      return file;
    };
    const file = await download("svg");
    const svgText = await text(await file.createReadStream());
    const result = await page.evaluate(async (xml) => {
      const svg = new DOMParser().parseFromString(xml, "image/svg+xml");
      const circles = [...svg.querySelectorAll("#matches circle")];
      const visible = circles.find(
        (c) =>
          Number(c.getAttribute("cx")) > 5 && Number(c.getAttribute("cy")) > 5,
      );
      const features = (await testMap.getSource("matches").getData()).features;
      const point = features.find((f) => f.id === visible.dataset.osmId);
      const { x, y } = testMap.project(point.geometry.coordinates);
      const pixel = [
        Number(visible.getAttribute("cx")),
        Number(visible.getAttribute("cy")),
      ];
      const image = new Image();
      image.src = svg
        .getElementById("basemap")
        .getAttributeNS("http://www.w3.org/1999/xlink", "href");
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const backdrop = Array.from(
        ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data,
      );
      return {
        error: svg.querySelector("parsererror")?.textContent,
        delta: Math.hypot(pixel[0] - x, pixel[1] - y),
        backdrop,
        featureCount: features.length,
        center: testMap.getCenter().toArray(),
      };
    }, svgText);
    assert(!result.error);
    assert(
      result.delta < 0.05,
      "SVG point matches the pitched and rotated map",
    );
    assert.deepEqual(
      result.backdrop,
      [221, 238, 255, 255],
      "the basemap underneath the editable point is clean",
    );
    assert.match(svgText, /© OpenStreetMap contributors/);
    assert.equal(
      await page.evaluate(() => !!testMap.getLayer("regol-svg-capture")),
      false,
    );

    const html = await download("html");
    const path = join(dir, html.suggestedFilename());
    await html.saveAs(path);
    const saved = await context.newPage();
    const requests = [];
    await saved.route(/^https?:/, (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    await saved.goto(pathToFileURL(path).href);
    await saved.waitForFunction(() => window.testMap?.loaded());
    const scene = await saved.evaluate(async () => ({
      center: testMap.getCenter().toArray(),
      pitch: testMap.getPitch(),
      bearing: testMap.getBearing(),
      count: (await testMap.getSource("matches").getData()).features.length,
      injected: window.executed === true,
      zoom: testMap.getZoom(),
    }));
    assert.deepEqual(scene.center, result.center);
    assert.equal(scene.pitch, 40);
    assert.equal(scene.bearing, 24);
    assert.equal(scene.count, result.featureCount);
    assert.equal(scene.injected, false);
    await saved.locator(".maplibregl-ctrl-zoom-in").click();
    await saved.waitForFunction(
      (previous) => testMap.getZoom() > previous,
      scene.zoom,
    );
    assert.deepEqual(
      requests,
      [],
      "standalone HTML needs no explorer assets or GOL",
    );

    const [lon, lat] = result.center;
    const ring = (size) => [
      [lon - size, lat - size],
      [lon + size, lat - size],
      [lon + size, lat + size],
      [lon - size, lat + size],
      [lon - size, lat - size],
    ];
    await page.click("#paste");
    await page.fill(
      "#geometry",
      JSON.stringify({
        type: "GeometryCollection",
        geometries: [
          {
            type: "Polygon",
            coordinates: [ring(0.002), ring(0.001).reverse()],
          },
          {
            type: "MultiLineString",
            coordinates: [
              [
                [lon, lat - 5],
                [lon, lat + 5],
              ],
            ],
          },
          { type: "MultiPoint", coordinates: [[lon, lat]] },
        ],
      }),
    );
    await page.click("#use-json");
    await page.fill("#selector", "show($geometry)");
    await page.click("#run");
    await page.waitForFunction(() =>
      document
        .getElementById("status")
        .textContent.includes("Map geometry shown"),
    );
    const referenceSvg = await text(
      await (await download("svg")).createReadStream(),
    );
    const paths = await page.evaluate((xml) => {
      const doc = new DOMParser().parseFromString(xml, "image/svg+xml");
      const layer = doc.getElementById("reference");
      return {
        rings: layer.querySelector('[fill-rule="evenodd"]').getAttribute("d"),
        line: layer.querySelector('[fill="none"]').getAttribute("d"),
        points: layer.querySelectorAll("circle").length,
        matches: doc.getElementById("matches").childElementCount,
      };
    }, referenceSvg);
    assert.equal(paths.matches, 0);
    assert.equal(paths.points, 1);
    assert.equal(paths.rings.match(/Z/g).length, 2);
    assert.match(paths.line, /^M[-.\d]+ [-.\d]+L[-.\d]+ [-.\d]+$/);

    await page.fill("#selector", "$empty = n[regol_missing_tag]\nshow($empty)");
    await page.click("#run");
    await page.waitForFunction(
      () =>
        document.getElementById("count").textContent === "0" &&
        document.getElementById("status").textContent.includes("No matches"),
    );
    await page.selectOption("#export-format", "geojson");
    assert(await page.locator("#export-results").isDisabled());
    await page.selectOption("#export-format", "svg");
    assert(await page.locator("#export-results").isEnabled());
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
  }
}
