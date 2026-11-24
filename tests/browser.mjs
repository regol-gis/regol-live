import assert from "node:assert/strict";
import { examples, parseProgram, predicates } from "../web/query-language.js";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import sirv from "sirv";
import { checkGobArea } from "./gob-area.mjs";
import { checkPlanetReader } from "./planet-reader.mjs";
import { checkHostedPages } from "./hosted-pages.mjs";
import { checkNative } from "./native-browser.mjs";
import { checkMapExport } from "./map-export.mjs";
import { checkPanCache } from "./pan-cache.mjs";
import { checkRangeStorage, checkRangeEviction } from "./range-storage.mjs";

const files = sirv("dist", { etag: true });
const fixtures = sirv("tests/fixtures", { etag: true });
let releaseSlowRead;
let reachedSlowRead;
const slowRead = new Promise((resolve) => {
  reachedSlowRead = resolve;
});
const sample = "/data/monaco-2026-01-01.gol";
const sampleReads = [];
// Padding keeps the valid Monaco GOL above the remote planning threshold.
const padded = Buffer.alloc(2 * 1024 * 1024);
(await readFile("web" + sample)).copy(padded);
const wideReads = new Set();
let smallTransferAllowance = false;
const server = createServer((req, res) => {
  if (req.url === "/geography.gol" || req.url === "/stress.gol") return fixtures(req, res);
  if (req.url.startsWith("/adaptive.gol?")) {
    const [start, end] = req.headers.range.slice(6).split("-").map(Number);
    const wide = end - start + 1 > 128 * 1024;
    if (wide) wideReads.add(req.url);
    setTimeout(() => {
      if (wide && req.url.endsWith("?small-only")) return res.writeHead(503).end();
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${padded.length}`,
        "Content-Length": end - start + 1,
        "Cache-Control": "no-store",
        ETag: wide ? '"changed"' : '"initial"',
      }).end(padded.subarray(start, end + 1));
    }, 120);
    return;
  }
  if (req.url === "/ranges.js" && smallTransferAllowance) {
    return res
      .writeHead(200, { "Content-Type": "text/javascript" })
      .end(
        'export * from "./original-ranges.js"; export const transferAllowance = () => 512 * 1024;',
      );
  }
  if (req.url === "/original-ranges.js") req.url = "/ranges.js";
  if (req.url === "/local-datasets.js") {
    const local = {
      id: "local-sample",
      label: "Local sample",
      path: sample,
      localFile: true,
      view: { center: [7.422, 43.739], zoom: 15 },
    };
    return res
      .writeHead(200, { "Content-Type": "text/javascript" })
      .end("export default " + JSON.stringify([local]));
  }
  if (req.url === sample) sampleReads.push(req.headers.range);
  if (req.url === "/slow.gol") {
    releaseSlowRead = () => {
      if (!res.destroyed) res.writeHead(503).end();
    };
    reachedSlowRead();
    return;
  }
  files(req, res);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/chromium",
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
try {
  await checkPlanetReader(browser, base, sample);
  sampleReads.length = 0;
  await checkGobArea(browser, base);
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors = [],
    ranges = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (res) => {
    if (res.url().endsWith(".gol")) ranges.push(res.status());
  });
  const finished = () =>
    page.waitForFunction(
      () => /\b(ms|s) · /.test(document.querySelector("#status").textContent),
      null,
      { timeout: 30000 },
    );
  const run = async () => {
    await page.click("#run");
    await finished();
  };
  const program = async (text) => {
    await page.fill("#selector", text);
    await run();
  };
  const example = async (label) => {
    await page.selectOption("#example", { label });
    await finished();
  };
  const download = async (format) => {
    await page.getByLabel("Export format").selectOption(format);
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const file = await pending;
    assert(file.suggestedFilename().endsWith("." + format));
    return text(await file.createReadStream());
  };
  const count = async () =>
    Number((await page.textContent("#count")).replaceAll(",", ""));
  await page.goto(base);
  assert.equal(await page.inputValue("#dataset"), "planet");
  await page.goto(base + "/?dataset=monaco");
  const aboutButton = page.getByRole("button", { name: "About", exact: true });
  const about = page.getByRole("dialog", { name: "About Regol Live" });
  await aboutButton.click();
  await about.getByRole("heading", { name: "Standalone mode" }).waitFor();
  assert.equal(await about.getByRole("heading", { name: "Native mode" }).count(), 0);
  assert.equal(await about.getByRole("link", { name: "Regol project" }).getAttribute("href"), "https://regol.org/");
  assert.equal(await about.getByRole("link", { name: "Regol Live source" }).getAttribute("href"), "https://github.com/regol-gis/regol-live");
  assert.equal(await about.getByRole("link", { name: "Regol engine source" }).getAttribute("href"), "https://github.com/regol-gis/regol");
  const buildURL = await about.getByRole("link", { name: "Build details" }).evaluate((link) => link.href);
  const build = await (await page.request.get(buildURL)).json();
  assert.match(build.version, /^\d+\.\d+\.\d+/);
  await about.getByText("Regol Live " + build.version, { exact: false }).waitFor();
  if (build.revision) {
    const versionLabel = await about.getByRole("status").textContent();
    assert(versionLabel.includes(build.revision.slice(0, 8)));
    assert.equal(versionLabel.includes("local changes"), build.dirty);
  }
  await about.getByRole("button", { name: "Close" }).click();
  assert(await about.isHidden());
  assert(await aboutButton.evaluate((button) => document.activeElement === button));
  assert.equal(await page.locator(".result").count(), 0);
  await run();
  await page.evaluate(() => {
    const getBounds = maplibregl.Map.prototype.getBounds;
    maplibregl.Map.prototype.getBounds = function () {
      window.testMap = this;
      maplibregl.Map.prototype.getBounds = getBounds;
      return getBounds.call(this);
    };
  });
  const timings = await page.textContent("#timing-values");
  assert.match(timings, /[\d,]+ ms in browser storage writes/);
  assert.match(timings, /[\d,]+ ms in the query engine outside range waits/);
  assert(
    await page.getByRole("button", { name: "Point", exact: true }).isVisible(),
  );
  assert(await page.getByRole("button", { name: "GeoJSON…" }).isVisible());
  const checkPanToggle = async () => {
    const select = await page.locator(".top #dataset").boundingBox();
    const downloadArea = await page.locator(".top #download-area").boundingBox();
    const aboutBox = await aboutButton.boundingBox();
    assert(downloadArea.x + downloadArea.width <= select.x, "area download precedes the dataset");
    assert(select.y < downloadArea.y + downloadArea.height && downloadArea.y < select.y + select.height);
    const right = await page.locator(".top").evaluate((header) =>
      header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight));
    assert(select.x + select.width <= aboutBox.x, "About follows the dataset");
    assert(select.y < aboutBox.y + aboutBox.height && aboutBox.y < select.y + select.height);
    assert(Math.abs(aboutBox.x + aboutBox.width - right) < 1, "About stays at the right edge");
    assert(aboutBox.x + aboutBox.width <= page.viewportSize().width, "About fits in the viewport");
    const logo = await page.locator(".identity").boundingBox();
    assert(select.y < logo.y + logo.height && logo.y < select.y + select.height, "selector stays on the top row");
    const runButton = await page.locator("#run").boundingBox();
    const checkbox = await page.getByLabel("Update on pan").boundingBox();
    assert(checkbox.x >= runButton.x + runButton.width);
    assert(
      checkbox.y >= runButton.y &&
        checkbox.y + checkbox.height <= runButton.y + runButton.height,
    );
  };
  await checkPanToggle();
  const all = await count();
  assert(all > 1, "Monaco cafés should be visible");
  assert(
    ranges.length > 0 && ranges.every((s) => s === 206),
    "all GOL GETs should be partial responses",
  );
  const genericReads = sampleReads.splice(0);
  const firstPage = await page.locator(".result").allTextContents();
  await page.selectOption("#dataset", "local-sample");
  await finished();
  assert.equal(await count(), all);
  assert.deepEqual(await page.locator(".result").allTextContents(), firstPage);
  assert(
    sampleReads.length < genericReads.length,
    "local reads should need fewer GETs",
  );
  const intervals = sampleReads
    .map((range) => range.slice("bytes=".length).split("-").map(Number))
    .sort((a, b) => a[0] - b[0]);
  assert(intervals.some(([first, last]) => last - first + 1 > 128 * 1024));
  assert(intervals.every(([first], i) => !i || first > intervals[i - 1][1]));
  sampleReads.length = 0;
  await run();
  assert.equal(sampleReads.length, 0);
  assert.match(await page.textContent("#status"), /Cached/);
  await page.fill(
    "#selector",
    "$bounds = a[boundary=administrative][name=France,Monaco]\nshow($bounds)",
  );
  await run();
  assert.equal(await count(), 2);
  assert.equal(
    await page.innerText("#geometry-warning"),
    "Skipped 1 invalid geometry.",
  );
  const mapCanvas = page.locator(".maplibregl-canvas");
  const carousel = page.getByRole("group", { name: "Overlapping features" });
  // The worker can finish just before MapLibre paints its new GeoJSON tiles.
  for (
    let attempt = 0;
    attempt < 10 && !(await carousel.isVisible());
    attempt++
  )
    await mapCanvas.click();
  assert.equal(await page.textContent("#hit-position"), "1 of 2 at this point");
  const firstHit = await page.textContent("#detail-id");
  await page.getByRole("button", { name: "Next feature" }).click();
  const nextHit = await page.textContent("#detail-id");
  assert.notEqual(nextHit, firstHit);
  assert.equal(await page.textContent("#hit-position"), "2 of 2 at this point");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.textContent("#detail-id"), firstHit);
  await page.getByRole("button", { name: "Previous feature" }).click();
  assert.equal(await page.textContent("#detail-id"), nextHit);
  await page.click("#use-feature");
  assert(
    (await page.textContent("#reference-status")).includes(
      nextHit.split(" · ")[0],
    ),
  );
  await page.locator(".result").first().click();
  assert(await carousel.isHidden());
  await page.click("#close-detail");
  await example("Cafés");
  assert(await page.locator("#geometry-warning").isHidden());
  const warning = page.locator("#query-warning");
  await page.fill(
    "#selector",
    "$parks = a[leisure=park]\n$benches = n[amenity=bench] | within($parks)\n" +
      "$cafes = na[amenity=cafe]\nshow($cafes)",
  );
  assert.match(await warning.innerText(), /\$parks, \$benches are unused/);
  await run();
  assert.equal(await count(), all);
  await page.click("#open-builder");
  assert.equal(
    await page.innerText("#builder-warning"),
    await warning.textContent(),
  );
  await page.getByRole("dialog").getByLabel("Show this set").nth(1).check();
  assert(await page.locator("#builder-warning").isHidden());
  await page.click("#cancel-builder");
  assert(await warning.isVisible());
  const language = page.getByRole("radiogroup", { name: "Query language" });
  const goql = language.getByRole("radio", { name: "GOQL", exact: true });
  const overpass = language.getByRole("radio", { name: "Overpass QL" });
  for (const label of await language.locator("label").all()) {
    const segment = await label.boundingBox();
    const text = await label.locator("span").boundingBox();
    assert(text.x - segment.x >= 8);
    assert(segment.x + segment.width - text.x - text.width >= 8);
  }
  const regolDraft = await page.inputValue("#selector");
  assert(await goql.isChecked());
  await overpass.check();
  assert(await overpass.isChecked());
  const compatibilityWarning = page.locator("#experimental");
  assert.equal(await compatibilityWarning.innerText(), "Overpass QL support is experimental and not compatible with all Overpass queries");
  const headingBox = await page.getByRole("heading", { name: "Query workspace" }).boundingBox();
  const modeBox = await language.boundingBox();
  assert(modeBox.x >= headingBox.x + headingBox.width && modeBox.y < headingBox.y + headingBox.height);
  assert((await compatibilityWarning.boundingBox()).y >= modeBox.y + modeBox.height);
  assert(await page.locator("#open-builder").isHidden());
  await page.fill("#selector", 'node["amenity"="cafe"]({{bbox}});');
  await page.waitForFunction(() => document.querySelector("#query-warning").textContent.includes("out geom"));
  const qlDraft = 'node["amenity"="cafe"]({{bbox}}); out geom;';
  await program(qlDraft);
  assert((await count()) > 0);
  await goql.check();
  assert.equal(await page.inputValue("#selector"), regolDraft);
  assert(await page.locator("#experimental").isHidden());
  await goql.focus();
  await page.keyboard.press("ArrowRight");
  assert(await overpass.isChecked());
  assert.equal(await page.inputValue("#selector"), qlDraft);
  await example("Cafés near bus stops");
  assert((await count()) > 0);
  const breakdown = page.locator("#count-types");
  await example("Count cafés and restaurants");
  const venueCount = await count();
  assert(venueCount > 0);
  assert.match(await breakdown.innerText(), /[\d,]+ nodes? · [\d,]+ ways? · [\d,]+ relations?/);
  assert.equal(await page.locator(".result").count(), 0);
  assert.doesNotMatch(await page.innerText("#status"), /No matches/);
  await program((await page.inputValue("#selector")).replace("out count;", "out center;"));
  assert.equal(await count(), venueCount);
  assert(await breakdown.isHidden());
  assert((await page.locator(".result").count()) > 0);
  await program('nwr[amenity=nonexistent_regol_fixture]({{bbox}}); out count;');
  assert.equal(await count(), 0);
  assert.equal(await breakdown.innerText(), "0 nodes · 0 ways · 0 relations");
  await program(`node[amenity=cafe]({{bbox}})->.cafes;
    .cafes out geom;
    .cafes out count;
    .cafes out skel center qt;
    node[amenity=nonexistent_regol_fixture]({{bbox}})->.empty;
    .empty out count;`);
  assert.match(await breakdown.innerText(), /\.cafes out count · [1-9][\d,]* nodes? · 0 ways · 0 relations\n\.empty out count · 0 nodes · 0 ways · 0 relations/);
  assert.deepEqual(await page.locator("#set-legend span").allTextContents(), [
    ".cafes out geom", ".cafes out skel center qt",
  ]);
  const cafeOutputs = JSON.parse(await download("geojson")).features;
  const split = cafeOutputs.length / 2;
  assert(split >= 1 && Number.isInteger(split));
  assert.equal(await count(), cafeOutputs.length);
  const firstCafes = new Map(cafeOutputs.slice(0, split).map((f) => [f.properties.osm_id, f]));
  for (const feature of cafeOutputs.slice(split)) {
    assert.equal(feature.properties.query_set, ".cafes");
    const first = firstCafes.get(feature.properties.osm_id);
    assert.equal(first.properties.query_set, ".cafes");
    assert.equal(first.id, "0:" + feature.properties.osm_id);
    assert.equal(feature.id, "2:" + feature.properties.osm_id);
    assert.equal(first.properties["tag:amenity"], "cafe");
    assert.equal(feature.properties["tag:amenity"], undefined);
  }
  const overlappingCafe = await page.waitForFunction(async () => {
    const { features } = await testMap.getSource("matches").getData();
    for (const feature of features) {
      const point = testMap.project(feature.geometry.coordinates);
      const canvas = testMap.getCanvas();
      if (point.x <= 0 || point.x >= canvas.clientWidth || point.y <= 0 || point.y >= canvas.clientHeight) continue;
      const ids = new Set(testMap
        .queryRenderedFeatures(point, { layers: ["match-point"] })
        .map((hit) => hit.properties.fid));
      if (ids.size === 2 && ids.has("0:" + feature.id) && ids.has("2:" + feature.id)) {
        return { x: point.x, y: point.y, id: feature.id };
      }
    }
  });
  const { x, y, id: cafeId } = await overlappingCafe.jsonValue();
  await mapCanvas.click({ position: { x, y } });
  assert.equal(await page.textContent("#hit-position"), "1 of 2 at this point");
  assert.equal(await page.textContent("#detail-id"), cafeId + " · Point");
  const firstTagCount = await page.locator("#tags dt").count();
  await page.getByRole("button", { name: "Next feature" }).click();
  assert.equal(await page.textContent("#detail-id"), cafeId + " · Point");
  const secondTagCount = await page.locator("#tags dt").count();
  assert.equal(Math.min(firstTagCount, secondTagCount), 0);
  assert(Math.max(firstTagCount, secondTagCount) > 0);
  await goql.check();
  assert(await breakdown.isHidden());
  await page.fill("#selector", "$unfinished =");
  assert.match(await warning.innerText(), /selector.*after =/);

  const sheet = page.locator("#regol-syntax");
  await sheet.getByText("Query syntax", { exact: true }).click();
  assert.equal(await sheet.locator("details").count(), 0);
  const writing = sheet.getByRole("region", { name: "Write a query" });
  const sampleStatements = await writing.locator("dt code").allTextContents();
  const tags = sheet.getByRole("region", { name: "Select features by tag" });
  const selectors = await tags.locator("dt code").allTextContents();
  const spatial = sheet.getByRole("region", { name: "Filter by location" });
  const calls = await spatial.locator("dt code").allTextContents();
  assert.deepEqual(
    calls.map((call) => call.split("(")[0]).sort(),
    [...predicates.keys()].sort(),
  );
  // The engine validates every GOQL source, including unshown branches.
  const declarations = selectors.map(
    (s, i) => "$tag" + i + " = " + (s.startsWith("[") ? "*" : "") + s,
  );
  declarations.push("$ref = a", "$filtered = n | " + calls.join(" | "), ...sampleStatements);
  await program(declarations.join("\n"));
  assert(await warning.isVisible());
  await sheet.locator(":scope > summary").click();
  await example("Cafés");
  assert(await warning.isHidden());
  const self =
    "$cafes = na[amenity=cafe]\n$matches = $cafes | within_distance($cafes, 0)\nshow($matches)";
  await program(self);
  assert.equal(await count(), all);
  await program(self.replace("within_distance($cafes, 0)", "disjoint($cafes)"));
  assert.equal(await count(), 0);
  const empty =
    "$empty = n[amenity=nonexistent_regol_fixture]\n$cafes = na[amenity=cafe] | disjoint($empty)\nshow($cafes)";
  await program(empty);
  assert.equal(await count(), all);
  assert.match(await page.innerText("#reference-note"), /\$empty.*disjoint excluded no candidates/);
  await program(empty.replace("disjoint", "intersects"));
  assert.match(await page.innerText("#reference-note"), /\$empty.*intersects matched no candidates/);
  assert.equal(await count(), 0);
  await program(
    empty
      .replace(
        "n[amenity=nonexistent_regol_fixture]",
        "a[boundary=administrative][name=France]",
      )
      .replace("disjoint", "intersects"),
  );
  assert.equal(await count(), 0);
  assert.match(
    await page.innerText("#geometry-warning"),
    /1 from the reference query/,
  );
  await program("na[amenity=cafe] |\n where [name]");
  assert(await page.locator("#reference-note").isHidden());
  assert(await warning.isHidden());
  assert((await count()) > 0);
  await page.locator("#query-steps > summary").click();
  const cells = await page.locator("#step-counts tr").first().locator("td").allTextContents();
  assert.equal(cells[0], "$result");
  assert.equal(Number(cells[2].replaceAll(",", "")), await count());
  assert.equal(cells[3], "0");
  await page.locator("#query-steps > summary").click();
  await page.click("#open-builder");
  const brackets = page.getByRole("dialog").getByLabel("GOQL tag brackets");
  assert.equal(await brackets.inputValue(), "[name]");
  await brackets.fill("[outdoor_seating=yes]");
  await page.click("#apply-builder");
  await finished();
  assert.equal(await page.inputValue("#selector"), "na[amenity=cafe]\n  | where [outdoor_seating=yes]");
  await page.fill("#selector", "n | where [name=]");
  await page.waitForFunction(() => /column 17: expected key or value/.test(document.querySelector("#query-warning").textContent));
  await page.fill("#selector", "$cafes = na[amenity=cafe]");
  await page.waitForFunction(() => document.querySelector("#query-warning").textContent.includes("show($cafes)"));
  await page.click("#run");
  await page.waitForSelector("#status.error");
  assert.match(await page.textContent("#status"), /show/);
  await page.click("#open-builder");
  const showCafes = page.getByRole("dialog").getByLabel("Show this set");
  assert.equal(await showCafes.count(), 1);
  assert.equal(await showCafes.isChecked(), false);
  assert.match(await page.innerText("#builder-warning"), /Select a set/);
  await showCafes.check();
  assert(await page.locator("#builder-warning").isHidden());
  await page.click("#apply-builder");
  await finished();
  assert(await warning.isHidden());
  assert.equal(await page.inputValue("#selector"), "$cafes = na[amenity=cafe]\nshow($cafes)");
  await example("Cafés");
  if (process.env.SCREENSHOT)
    await page.screenshot({ path: process.env.SCREENSHOT });
  await page.locator(".result").first().click();
  const id = (await page.textContent("#detail-id")).split(" · ")[0];
  await page.click("#use-feature");
  const attached =
    "$cafes = na[amenity=cafe] | within_distance($geometry, 0)\nshow($cafes)";
  await program(attached);
  assert((await count()) >= 1 && (await count()) < all);
  assert((await page.textContent("#list")).includes(id));
  await program(
    attached.replace("within_distance($geometry, 0)", "disjoint($geometry)"),
  );
  assert(!(await page.textContent("#list")).includes(id));
  await page.click("#paste");
  await page.fill(
    "#geometry",
    JSON.stringify({
      type: "Polygon",
      coordinates: [
        [
          [7.38, 43.72],
          [7.46, 43.72],
          [7.46, 43.77],
          [7.38, 43.77],
          [7.38, 43.72],
        ],
      ],
    }),
  );
  await page.click("#use-json");
  await program(
    attached.replace("within_distance($geometry, 0)", "within($geometry)"),
  );
  assert.equal(await count(), all, "the polygon encloses the viewport cafés");
  const refLayer = () =>
    page.evaluate(() => testMap.getSource("reference").getData());
  assert.deepEqual((await refLayer()).features, []);
  const rangeCount = ranges.length;
  const csv = await download("csv");
  assert.equal(csv.trimEnd().split("\r\n").length, all + 1);
  assert(!csv.includes('"$geometry"'), "an unshown reference stays out of the file");
  assert.equal(ranges.length, rangeCount, "export reuses displayed geometries");
  await program("show($geometry)");
  assert.equal((await refLayer()).geometry.type, "Polygon");
  const referenceKml = await download("kml");
  assert.equal(referenceKml.match(/<Placemark>/g).length, 1);
  assert.match(referenceKml, /<value>\$geometry<\/value>/);
  assert.match(referenceKml, /<Polygon>/);
  assert.equal(await count(), 0);
  await program(
    attached.replace("within_distance($geometry, 0)", "within($geometry)"),
  );
  assert.deepEqual((await refLayer()).features, []);
  await page.click('[data-draw="Polygon"]');
  const canvas = page.locator(".maplibregl-canvas");
  for (const [x, y] of [
    [100, 200],
    [350, 200],
    [230, 430],
  ])
    await canvas.click({ position: { x, y } });
  await page.click("#finish");
  await run();
  assert((await count()) < all, "drawn triangle should narrow the queryset");
  await page.fill("#selector", "n[");
  await page.click("#run");
  await page.waitForSelector("#status.error");
  await example("Roads");
  assert((await count()) > all);
  const roads = JSON.parse(await download("geojson"));
  assert.equal(roads.features.length, await count());
  assert(roads.features.length > await page.locator(".result").count());
  assert(roads.features.every((f) => f.properties.query_set === "$result" &&
    f.properties.osm_id === f.id && f.properties["tag:highway"] && f.geometry));
  await page.selectOption("#dataset", "custom");
  assert(await page.locator("#export-results").isDisabled());
  await page.fill("#url", new URL("/data/monaco-2026-01-01.gol", base).href);
  await run();
  assert((await count()) > all);
  assert.match(await page.textContent("#coords"), /43\.7311°, 7\.4198°/);
  await page.fill("#url", new URL("/slow.gol", base).href);
  await page.click("#run");
  await slowRead;
  await page.click("#cancel");
  releaseSlowRead();
  assert.match(await page.textContent("#status"), /cancelled/);
  await page.fill("#url", new URL("/data/monaco-2026-01-01.gol", base).href);
  await run();
  await page.setViewportSize({ width: 320, height: 844 });
  await checkPanToggle();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await checkPanToggle();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "mobile overflow",
  );
  await example("Cafés");
  assert((await count()) >= 1);
  assert.deepEqual(errors, []);

  await example("Stop members of bus routes");
  await page.click("#open-builder");
  const roleFilter = page.locator("#builder fieldset").last();
  assert.equal(await roleFilter.getByLabel("Member role", { exact: true }).inputValue(), "stop");
  assert.equal(await roleFilter.getByLabel("Reference set").locator('option[value="geometry"]').count(), 0);
  await roleFilter.getByLabel("Member role", { exact: true }).fill("");
  await page.click("#apply-builder");
  await finished();
  assert.match(await page.inputValue("#selector"), /members_of\(\$routes, ""\)/);
  await page.click("#open-builder");
  await roleFilter.getByLabel("Match member role").uncheck();
  await page.click("#apply-builder");
  await finished();
  assert.match(await page.inputValue("#selector"), /members_of\(\$routes\)/);

  for (const [label, text] of examples) {
    await example(label);
    assert.equal(await page.inputValue("#selector"), text);
  }
  await page.click("#open-builder");
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByLabel("Set name", { exact: true }).count(), 3);
  await dialog.getByLabel("Show this set").nth(1).uncheck();
  await dialog.getByLabel("Distance in metres").fill("200");
  await page.click("#apply-builder");
  await finished();
  const edited = parseProgram(await page.inputValue("#selector"));
  assert.deepEqual(edited.show, ["cafes"]);
  assert.equal(edited.sets[2].filters[0].meters, 200);
  const unchanged = await page.inputValue("#selector");
  await page.click("#open-builder");
  await page.click("#add-set");
  await page.click("#cancel-builder");
  assert.equal(await page.inputValue("#selector"), unchanged);
  await page.fill("#selector", "");
  await page.click("#open-builder");
  for (const [name, source] of [
    ["parks", "a[leisure=park,garden]"],
    ["benches", "n[amenity=bench]"],
  ]) {
    await page.click("#add-set");
    const set = dialog.locator("fieldset").last();
    await set.getByLabel("Set name", { exact: true }).fill(name);
    await set.getByLabel("GOQL selector or earlier set").fill(source);
    if (name === "parks") await set.getByLabel("Show this set").uncheck();
    else {
      await set.getByRole("button", { name: "Add filter" }).click();
      await set.getByLabel("Relationship").selectOption("within");
      assert.equal(await set.getByLabel("Reference set").inputValue(), "parks");
    }
  }
  await page.click("#apply-builder");
  await finished();
  const parkBenches = await count();
  assert.equal(
    await page.inputValue("#selector"),
    examples.get("Benches in parks and gardens"),
  );
  assert.deepEqual((await refLayer()).features, []);
  await program(
    (await page.inputValue("#selector")).replace(
      "show($benches)",
      "show($parks, $benches)",
    ),
  );
  assert((await count()) > parkBenches);
  const groups = await page.evaluate(async () =>
    [
      ...new Set(
        (await testMap.getSource("matches").getData()).features.map(
          (f) => f.properties.group,
        ),
      ),
    ].sort(),
  );
  assert.deepEqual(groups, [0, 1]);
  await page.uncheck("#auto");
  await page.selectOption("#dataset", "custom");
  await page.evaluate(() => testMap.jumpTo({ center: [-100, 20], zoom: 15 }));
  await page.fill("#url", base + sample + "?area-download");
  const areaButton = page.locator(".top #download-area");
  const confirmArea = page.locator("#confirm-area");
  const waitAreaSize = () => page.waitForFunction(() =>
    document.querySelector("#area-size").textContent.includes(" MB / "));
  await waitAreaSize();
  if (await areaButton.isEnabled()) {
    await areaButton.click();
    await confirmArea.click();
    await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Area ready"));
  }
  assert(await areaButton.isDisabled());
  assert.match(await page.textContent("#area-size"), /^0 MB \/ 0\.21 MB$/);
  await page.evaluate(() => testMap.jumpTo({ center: [7.422, 43.739], zoom: 15 }));
  await waitAreaSize();
  assert(await areaButton.isEnabled(), "panning with automatic queries off finds additional tiles");
  const beforeDownload = await page.textContent("#area-size");
  assert.match(beforeDownload, / MB \/ 1 MB$/);
  await areaButton.click();
  await page.waitForFunction(() =>
    !document.querySelector("#confirm-area").hidden || !document.querySelector("#area-dialog").open);
  assert(await confirmArea.isVisible(), await page.textContent("#status"));
  assert.match(await confirmArea.textContent(), /^Download /);
  await page.keyboard.press("Escape");
  assert.match(await page.textContent("#status"), /Area download cancelled/);
  await areaButton.click();
  await confirmArea.click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Area ready"));
  assert(await areaButton.isDisabled());
  assert.equal(await page.textContent("#area-size"), "0 MB / 1 MB");
  await program("$cafes = n[amenity=cafe]\nshow($cafes)");
  assert((await count()) > 0);
  assert.match(await page.textContent("#status"), /Cached · 0 ranges/);
  const querySource = (url) => page.evaluate((url) => new Promise((resolve, reject) => {
    const worker = new Worker("./worker.js", { type: "module" });
    worker.onerror = (e) => { worker.terminate(); reject(Error(e.message)); };
    worker.onmessage = ({ data }) => {
      if (data.type !== "result" && data.type !== "error") return;
      worker.terminate();
      resolve(data);
    };
    worker.postMessage({ id: 1, url, request: {
      windows: [[7.4, 43.72, 7.44, 43.75]], sets: [{ name: "cafes", source: "na[amenity=cafe]" }], show: ["cafes"],
    } });
  }), url);
  const expected = await querySource(base + sample);
  const recovered = await querySource(base + "/adaptive.gol?small-only");
  assert.equal(expected.type, "result");
  assert.equal(recovered.type, "result");
  assert.deepEqual(recovered.features, expected.features);
  const changed = await querySource(base + "/adaptive.gol?changed");
  assert.equal(changed.type, "error");
  assert.equal(changed.invalidated, true);
  assert.deepEqual(wideReads, new Set(["/adaptive.gol?small-only", "/adaptive.gol?changed"]));
  await checkNative(browser, page);
  await checkRangeStorage(page, base);
  await checkRangeEviction(page);
  await checkPanCache(browser, base);
  await checkMapExport(browser, base);
  await page.getByLabel("Update on pan").uncheck();
  await overpass.check();
  await page.selectOption("#dataset", "custom");
  await page.fill("#url", new URL("/geography.gol", base).href);
  for (const [query, ids] of [
    ['nw["test:group"=dateline](poly:"-0.25 179.8 -0.25 -179.8 0.25 -179.8 0.25 179.8"); out center;', ["N11", "N12", "W103"]],
    ['rel[name=Courtyard](-3,177,3,-177); map_to_area; nw["test:group"=dateline](area); out center;', ["N10", "N13", "N9", "W107"]],
    ['wr["test:group"=arc](around:25,80.3342036,0); out center;', ["R202", "W105"]],
    ['wr["test:group"=polar_arc](around:25,90,130); out center;', ["R209", "W113"]],
  ]) {
    await program(query);
    assert.deepEqual((await page.locator(".result small").allTextContents()).sort(), ids, query);
  }
  smallTransferAllowance = true;
  const paused = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await paused.goto(base + "/?dataset=monaco");
  await paused.click("#run");
  const resume = paused.locator("#continue-query");
  await resume.waitFor();
  assert.match(await paused.textContent("#status"), /transfer limit/);
  await paused.click("#cancel");
  assert(await resume.isHidden());
  assert.match(await paused.textContent("#status"), /cancelled/);
  sampleReads.length = 0;
  await paused.click("#run");
  await resume.waitFor();
  assert(sampleReads.length < genericReads.length);
  await resume.click();
  await paused.waitForFunction(() =>
    /\b(ms|s) · /.test(document.querySelector("#status").textContent),
  );
  assert.deepEqual(
    sampleReads,
    genericReads,
    "resuming reads each original range exactly once",
  );
  assert.equal(await paused.textContent("#count"), String(all));
  await paused.close();
  await checkHostedPages(browser, base);
  console.log(
    "Browser checks passed for selectors, cached ranges and views, overlapping features, spatial references, custom sources and mobile layout.",
  );
} finally {
  await browser.close();
  server.close();
}
