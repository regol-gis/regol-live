import assert from "node:assert/strict";
import { examples, parseProgram } from "../web/query-language.js";
import { executionPlan } from "../web/query-plan.js";
import { checkTagEditor, checkSuggestionCounts } from "./tag-completion.mjs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Native and Wasm inverse Mercator can differ by a few floating-point ULPs.
function compareGeometry(actual, expected) {
  if (typeof expected === "number") {
    assert(Math.abs(actual - expected) <= 1e-12, `coordinate ${actual} vs ${expected}`);
  } else if (expected && typeof expected === "object") {
    assert.equal(Array.isArray(actual), Array.isArray(expected));
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    for (const key of Object.keys(expected)) compareGeometry(actual[key], expected[key]);
  } else {
    assert.equal(actual, expected);
  }
}

export async function checkNative(browser, staticPage) {
  const binary = "../target/debug/regol-live" + (process.platform === "win32" ? ".exe" : "");
  const sample = "../web/data/monaco-2026-01-01.gol";
  const server = spawn(fileURLToPath(new URL(binary, import.meta.url)), [
    fileURLToPath(new URL(sample, import.meta.url)), "--port", "0",
    "--view", "7.422,43.739,15",
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const stopped = once(server, "exit");
  const lines = createInterface({ input: server.stdout });
  const address = Promise.race([
    once(lines, "line"),
    stopped.then(([code]) => { throw Error("Native server exited with " + code); }),
  ]);
  let page;
  try {
    const [line] = await address;
    const base = new URL(line.match(/http:\/\/\S+/)[0]);
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const requests = [];
    page.on("request", (req) => requests.push(new URL(req.url()).pathname));
    await page.addInitScript(() => {
      Object.defineProperty(WebAssembly, "Suspending", { value: undefined });
    });
    const first = page.waitForResponse((res) => res.url() === new URL("api/query", base).href);
    await page.goto(base.href);
    const response = await first;
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Native query"));
    assert(await page.locator("#dataset").isDisabled());
    assert(await page.locator("#download-area").isHidden());
    assert.equal(await page.locator("#dataset option:checked").textContent(), "monaco-2026-01-01.gol");
    const output = await response.json();
    assert(output.features.length > 1);
    assert.equal(await page.locator("#count").textContent(), String(output.features.length));
    await page.locator(".result").first().click();
    assert(await page.locator("#inspector").isVisible());
    await page.getByRole("button", { name: "About" }).click();
    const about = page.getByRole("dialog", { name: "About Regol Live" });
    await about.getByRole("heading", { name: "Native mode" }).waitFor();
    assert.equal(await about.getByRole("heading", { name: "Standalone mode" }).count(), 0);
    const cliVersion = execFileSync(fileURLToPath(new URL(binary, import.meta.url)), ["--version"], { encoding: "utf8" }).trim();
    await about.getByText(cliVersion.replace("regol-live", "Regol Live"), { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert(await about.isHidden());
    assert(await page.locator("#inspector").isVisible(), "closing About preserves the selected feature");
    assert(!requests.some((path) => /(?:\.gol|\.wasm|\/worker\.js)$/.test(path)));

    // Hold the result response so the indicator is testable even on a fast machine.
    const queryURL = new URL("api/query", base).href;
    let pending;
    await page.route(queryURL, (route) => { pending = route; });
    await page.route("**/api/query/*/progress", async (route) => {
      const id = await pending.request().headerValue("x-regol-query-id");
      assert.match(id, /^[0-9a-f]{32}$/);
      assert.equal(route.request().url(), queryURL + "/" + id + "/progress");
      await route.fulfill({ json: { setIndex: 0, candidatesRead: 256 } });
    });
    await page.click("#run");
    await page.getByRole("progressbar", { name: "Native query in progress" }).waitFor();
    await page.waitForFunction(() => /Evaluating \$result · 256 candidates read · [1-9]\d* s/.test(
      document.querySelector("#native-phase").textContent,
    ));
    await page.click("#cancel");
    assert(await page.locator("#native-progress").isHidden());
    assert.equal(await page.textContent("#status"), "Query cancelled.");
    await pending.abort();
    await page.unroute(queryURL);
    await page.unroute("**/api/query/*/progress");
    await page.click("#run");
    await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Native query"));
    assert(await page.locator("#native-progress").isHidden());

    const wasmQuery = (request, source = "./data/monaco-2026-01-01.gol") =>
      staticPage.evaluate(({ request, source }) => new Promise((resolve, reject) => {
        const worker = new Worker("./worker.js", { type: "module" });
        worker.onmessage = ({ data }) => {
          if (data.type === "progress") return;
          worker.terminate();
          if (data.type === "error") return reject(Error(data.message));
          const { features, limited, skippedGeometries, skippedReferences } = data;
          resolve({ features, limited, skippedGeometries, skippedReferences,
            ...(data.counts && { counts: data.counts }), ...(data.outputs && { outputs: data.outputs }),
            ...(data.setStats && { setStats: data.setStats }) });
        };
        worker.onerror = (event) => { worker.terminate(); reject(Error(event.message)); };
        worker.postMessage({ url: new URL(source, location.href).href, request });
      }), { request, source });
    const compare = async (request) => {
      const res = await fetch(new URL("api/query", base), {
        method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(request),
      });
      assert.equal(res.status, 200);
      assert(res.headers.get("x-regol-snapshot"));
      assert.match(res.headers.get("server-timing"), /^query;dur=/);
      const native = await res.json();
      const wasm = await wasmQuery(request);
      const { features, ...metadata } = native;
      const { features: other, ...wasmMetadata } = wasm;
      assert.deepEqual(metadata, wasmMetadata);
      assert.equal(features.length, other.length);
      features.forEach(({ geometry, ...feature }, index) => {
        const { geometry: otherGeometry, ...otherFeature } = other[index];
        assert.deepEqual(feature, otherFeature);
        compareGeometry(geometry, otherGeometry);
      });
      return native;
    };
    await compare(response.request().postDataJSON());
    await checkTagEditor(page);
    await checkTagEditor(staticPage);
    await checkSuggestionCounts(staticPage, base);
    const window = [7.407, 43.72, 7.44, 43.75];
    const workspace = text => compare({ ...executionPlan(parseProgram(text), [window]), windows: [window] });
    const namedCafes = await workspace("na[amenity=cafe][name]");
    const fused = await compare({ ...executionPlan(parseProgram(
      "$all = na; $named = $all | where [amenity=cafe][name]; show($named)"
    ), [window]), windows: [window], setStats: true });
    assert.deepEqual(fused.features.map(f => f.id), namedCafes.features.map(f => f.id));
    assert.equal(fused.setStats.length, 1);
    assert.equal(fused.setStats[0].retained, 0);
    assert.equal(fused.setStats[0].matchesKept, namedCafes.features.length);
    const stored = await workspace("$cafes = na[amenity=cafe]; $named = $cafes | where [name]; $other = $cafes | except($named); show($named, $other)");
    assert.deepEqual(stored.features.filter(f => f.properties.group === 0).map(f => f.id), namedCafes.features.map(f => f.id));
    const diagnostic = [{text:'n[name="Café"][amenity=]',line:3,column:5}];
    for (const [ui, native] of [[page,true],[staticPage,false]]) {
      const issue = await ui.evaluate(async ({ diagnostic, native }) => {
        const { validateSelectors } = await import("./overpass.js");
        return validateSelectors(diagnostic, native);
      }, { diagnostic, native });
      assert.match(issue, /^Line 3, column 28: expected key or value/);
    }
    const far = await workspace(examples.get("Cafés over 100 m from every selected bus stop"));
    assert.deepEqual(far.features.map(f => f.id).sort(), ["N1704462423", "N7778339678", "N9918830819"]);
    const routes = await workspace(examples.get("Bus routes serving selected stops"));
    assert.equal(routes.features.length, 54);
    assert(routes.features.every(f => f.id.startsWith("R") && f.tags.route === "bus"));
    const stops = await workspace(examples.get("Stop members of bus routes"));
    assert.equal(stops.features.length, 100);
    assert(stops.features.every(f => f.id.startsWith("N")));
    const city = await workspace(`$country = a[admin_level=2][name=Monaco]
$city = a | members_of($country, "subarea")
$parent = a | parents_of($city, "subarea")
show($city, $parent)`);
    assert.deepEqual(city.features.map(f => f.id), ["R2220322", "R1124039"]);
    const grid = [[-0.002, 50.9999, 0.002, 51.004]];
    const links = parseProgram(`$way = w[name="Path 1"]
$nodes = n | members_of($way)
$first = n[name="Grid 2"]
$kept = $nodes | except($first)
$parents = w[name="Path 1"] | parents_of($kept)
$route = r[name="Route 0"]
$empty_role = a | members_of($route, "")
$back = r | parents_of($empty_role, "")
$way_role = $first | members_of($way, "")
show($kept, $parents, $empty_role, $back, $way_role)`);
    const gridResult = await wasmQuery({ ...executionPlan(links, grid), windows: grid }, "/stress.gol");
    assert.deepEqual(gridResult.features.map(f => [f.properties.group, f.id]).sort(),
      [[0, "N3"], [0, "N34"], [0, "N35"], [1, "W2001"], [2, "W2000"], [3, "R3000"]]);
    const nearStops = await compare({
      windows: [window],
      sets: [
        { name: "stops", source: "n[highway=bus_stop]" },
        { name: "cafes", source: "na[amenity=cafe][name]", filters: [{ predicate: "within_distance", reference: "stops", meters: 100 }] },
      ],
      show: ["cafes"],
    });
    assert.equal(nearStops.features.length, 19);
    const chain = await compare({
      windows: [window, window],
      sets: [
        { name: "areas", source: "a[boundary=administrative][name=France,Monaco]" },
        { name: "cafes", source: "na[amenity=cafe]", filters: [{ predicate: "within", reference: "areas" }] },
      ],
      show: ["areas", "cafes"],
    });
    assert(chain.skippedGeometries > 0 && chain.features.some((f) => f.properties.group === 1));
    const compileURL = new URL("api/overpass/compile", base);
    const compileNative = input => fetch(compileURL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const compileStandalone = input => staticPage.evaluate(async ({ text, viewport }) => {
      const { parseOverpass } = await import("/overpass.js");
      try { return await parseOverpass(text, viewport); }
      catch (err) { return { error: err.message }; }
    }, input);
    for (const text of ["node({{bbox}});\nout invalid;", "node[name=](1,2,3,4); out;"]) {
      const input = { text, viewport: [window] };
      const response = await compileNative(input);
      assert.equal(response.status, 422);
      const diagnostic = await response.json();
      assert.match(diagnostic.error, /^Line [12]: /);
      assert.deepEqual(await compileStandalone(input), diagnostic);
    }
    const ql = async (text) => {
      const input = { text, viewport: [window] };
      const response = await compileNative(input);
      const plan = await response.json();
      assert.equal(response.status, 200, plan.error);
      compareGeometry(await compileStandalone(input), plan);
      return compare({ ...plan, windows: [window] });
    };
    // Known Monaco features from the bundled snapshot. A separate great-circle
    // calculation on all 114 stop coordinates gives seven five-stop first hops
    // at 100 m. Only this group still contains five stops after the second hop.
    const isolated = await ql(`node[highway=bus_stop]({{bbox}})->.stops;
      foreach.stops->.stop {
        node.stops(around.stop:100)->.first;
        node.stops(around.first:100)->.second;
        if ((first.count(nodes) == 5) && (second.count(nodes) == 5)) {
          (.groups; .first;)->.groups;
        }
      }
      (.groups;);
      out body; >; out skel qt; .groups out count;`);
    assert.deepEqual(isolated.features.map(f => f.id).sort(), [
      "N11449887672", "N11449887676", "N13299075866", "N4939150452", "N4939150459",
    ]);
    assert.deepEqual(isolated.outputs.map(g => g.mode), ["geom", "geom", "count"]);
    assert.equal(isolated.outputs[2].counts.nodes, 5);
    assert(isolated.features.every(f => f.properties.group === 0 && f.tags.highway === "bus_stop"));

    // Global name lookup works outside the supplied viewport and preserves namesakes.
    const named = await ql('area[name="Villa Léonie"]; out count;');
    assert.equal(named.counts.total, 2);
    assert.equal((await ql('area[name="Missing test name"]; out count;')).counts.total, 0);
    const boundedPark = 'wr[name="Jardin Japonais"]({{bbox}}); map_to_area->.park;';
    const namedPark = 'area[leisure=park][name="Jardin Japonais"]->.park;';
    const benchesInPark = 'node[amenity=bench](area.park); out;';
    const indexed = await ql(namedPark + benchesInPark);
    assert(indexed.features.length > 0);
    assert.deepEqual(indexed.features.map(f => f.id).sort(),
      (await ql(boundedPark + benchesInPark)).features.map(f => f.id).sort());
    const combinedParks = await ql(namedPark + `
      area[name="Villa Léonie"]->.villa;
      (.villa; .park; .park;)->.both;
      (.both; - .villa;)->.remaining;
      .both out count;
      node[amenity=bench](area.remaining); out;`);
    assert.equal(combinedParks.outputs[0].counts.total, 3);
    assert.deepEqual(combinedParks.features.map(f => f.id).sort(), indexed.features.map(f => f.id).sort());

    const wayNodes = await ql(`way[footway=link](43.729668,7.411096,43.729672,7.411100)->.link;
      node(w.link)->.ends; .ends out body;
      way(bn.ends)[footway=link]; out body;`);
    assert.deepEqual(wayNodes.features.filter(f => f.properties.group === 0).map(f => f.id).sort(),
      ['N252358385', 'N4939122076']);
    assert(wayNodes.features.some(f => f.properties.group === 1 && f.id === 'W1326222739'));

    // Both endpoints are over 8 m away. The fountain sits on the middle of the segment.
    const corridor = await ql(`node[amenity](around:4,43.7270832,7.41827,43.7270832,7.41849)
      (if:t["amenity"] == "drinking_water"); out;`);
    assert.deepEqual(corridor.features.map(f => f.id), ['N5504097712']);

    const buildingsWithLevels = 'wr[building]["building:levels"](43.737,7.418,43.745,7.426)';
    const buildingsInBox = (await ql(buildingsWithLevels + '; out center;')).features;
    const tall = await ql(buildingsWithLevels +
      '(if:is_number(t["building:levels"]) && number(t["building:levels"]) >= 10); out center;');
    const expectedTall = buildingsInBox.filter(f => parseFloat(f.tags['building:levels']) >= 10);
    assert(expectedTall.length > 0 && expectedTall.length < buildingsInBox.length);
    assert.deepEqual(tall.features.map(f => f.id).sort(), expectedTall.map(f => f.id).sort());
    const cafes = await ql('node[highway=bus_stop]({{bbox}})->.stops; node[amenity=cafe](around.stops:150)({{bbox}}); out geom;');
    assert.equal(cafes.features.length, 26);
    assert(cafes.features.every(f => f.id.startsWith("N") && f.tags.amenity === "cafe"));
    // The stop is inside this box. The café is just east of its edge.
    const nearEdge = 'node[highway=bus_stop](43.73225,7.41857,43.73228,7.41860)->.s; node[amenity=cafe](around.s:150)';
    assert((await ql(nearEdge + '; out;')).features.some(f => f.id === 'N1712696781'));
    assert.equal((await ql(nearEdge + '(43.73225,7.41857,43.73228,7.41860); out;')).features.length, 0);
    const access = await ql('(nwr[access=no]({{bbox}}); nwr[access=no]({{bbox}});)->.a; nwr.a[access]; out;');
    assert.equal(access.features.length, 8);
    assert.equal(new Set(access.features.map(f => f.id)).size, 8);
    const fixed = await ql('node[amenity=cafe](around:200,43.739,7.422); out;');
    assert.deepEqual(fixed.features.map(f => f.id), ['N3087468610']);
    const buildings = await ql('way[building](43.733,7.42,43.735,7.424); out geom;');
    assert(buildings.features.some(f => f.geometry.type === "Polygon"));
    assert(buildings.features.every(f => f.id.startsWith("W")));
    const relations = await ql('rel[building]({{bbox}}); out geom;');
    assert(relations.features.length > 0 && relations.features.every(f => f.id.startsWith("R")));
    const venues = 'nw[amenity~"^(CAFE|RESTAURANT)$",i]({{bbox}})->.venues;';
    const centres = await ql(venues + '.venues out center;');
    assert(centres.features.length > 0);
    assert(centres.features.every(f => f.geometry.type === "Point" && ["cafe", "restaurant"].includes(f.tags.amenity)));
    const counted = await ql(venues + '.venues out count;');
    assert.deepEqual(counted.features, []);
    assert.deepEqual(counted.counts, {
      nodes: centres.features.filter(f => f.id.startsWith("N")).length,
      ways: centres.features.filter(f => f.id.startsWith("W")).length,
      relations: 0, total: centres.features.length,
    });
    const benches = 'node[amenity=bench]({{bbox}})->.all;';
    const inParks = 'wr[leisure=park]({{bbox}}); map_to_area->.parks; node.all(area.parks)->.inside;';
    const parkCount = (await ql(benches + inParks + 'node.all.inside; out count;')).counts.total;
    const streetCount = (await ql(benches + inParks + '(.all; - .inside;); out count;')).counts.total;
    assert(parkCount > 0 && streetCount > 0);
    assert.equal(parkCount + streetCount, (await ql(benches + '.all out count;')).counts.total);
    const areas = (await ql('wr[leisure=park]({{bbox}}); map_to_area; out count;')).counts;
    assert(areas.ways > 0 && areas.areas > 0 && areas.total === areas.ways + areas.areas);
    const railway = await ql('way[railway=rail]({{bbox}})->.rail; way[building](around.rail:50)({{bbox}}); out center;');
    assert(railway.features.length > 0 && railway.features.every(f => f.id.startsWith("W") && f.geometry.type === "Point"));
    const polygon = await ql('node[amenity=bench](poly:"43.72 7.407 43.75 7.407 43.75 7.44 43.72 7.44"); out count;');
    assert.equal(polygon.counts.nodes, parkCount + streetCount);
    const stopMembers = await ql('node[public_transport=stop_position]({{bbox}})->.stops; rel(bn.stops)[route=bus]->.routes; node(r.routes:"stop"); out geom;');
    assert(stopMembers.features.length > 0 && stopMembers.features.every(f => f.id.startsWith("N")));
    assert.equal((await fetch(new URL("api/query", base))).status, 405);
    assert.equal((await fetch(new URL("data/monaco-2026-01-01.gol", base))).status, 404);
    assert.equal((await fetch(new URL("api/query", base), {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({sets: [], show: ["missing"], windows: [window]}),
    })).status, 422);
    console.log("Native HTTP and Wasm agree on Monaco features, groups, geometries and limit metadata. Native UI issued zero GOL or Wasm requests.");
  } finally {
    server.kill();
    await stopped;
    await page?.close();
  }
}
