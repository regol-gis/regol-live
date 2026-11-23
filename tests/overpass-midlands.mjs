import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { json } from "node:stream/consumers";
import { chromium } from "playwright-core";
import { overpassExamples } from "../web/overpass.js";

// Acceptance check for the UK benchmark snapshot. Point REGOL_CLI to the
// matching Regol build and generate the UK area index with npm run build.
const gol = process.env.UK_GOL;
if (!gol) throw Error("Set UK_GOL to the UK benchmark GOL.");
const index = resolve("dist/datasets/uk.gol.areas");
const label = "Isolated groups of five wind turbines (English Midlands)";
const text = overpassExamples.get(label);
const expected = [
  "N3523485319", "N4596374126", "N4596374136", "N4596374158", "N4631922525",
  "N5088910763", "N5088910764", "N5088910765", "N5088910766", "N5088910767",
  "N5707831715", "N5707831718", "N5707831719", "N5707831720", "N5707833521",
];
const cli = spawnSync(process.env.REGOL_CLI || "regol", [
  "overpass", gol, "--file", "-", "--area-index", index, "-f", "ids",
], { input: text, encoding: "utf8" });
if (cli.error) throw cli.error;
assert.equal(cli.status, 0, cli.stderr);
const groups = cli.stdout.trim().split("\n").map(line => JSON.parse(line));
assert.deepEqual(groups.map(g => [g.name, g.mode]), [["groups", "geom"], ["groups", "count"]]);
assert.deepEqual(groups[0].ids.toSorted(), expected);
assert.deepEqual(groups[1].counts, { nodes: 15, ways: 0, relations: 0, total: 15 });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
async function checkSite(mode, binary, args, env) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  // This acceptance check needs no network access beyond the local GOL server.
  await page.route("https://tiles.openfreemap.org/**", route => route.abort());
  const server = spawn(binary, args, { env, stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(server, "exit");
  const lines = createInterface({ input: server.stdout });
  try {
    const [line] = await Promise.race([
      once(lines, "line"), exited.then(([code]) => { throw Error("Server exited with " + code); }),
    ]);
    const url = line.match(/http:\/\/\S+/)[0];
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof document.querySelector("#query-language")?.onchange === "function" &&
      !document.querySelector("#run").disabled);
    await page.getByRole("radio", { name: "Overpass QL" }).check();
    await page.getByLabel("Update on pan").uncheck();
    await page.locator("#example").selectOption({ label });
    assert.equal(await page.locator("#selector").inputValue(), text);
    if (mode === "WASM") await page.click("#run");
    await page.waitForFunction(() => document.querySelector("#status").classList.contains("error") ||
      document.querySelector("#count-types").textContent.includes("15 nodes"), null, { timeout: 120_000 });
    assert.deepEqual((await page.locator(".result small").allTextContents()).sort(), expected,
      await page.locator("#status").textContent());
    assert.equal(await page.locator("#count-types").innerText(), ".groups out count · 15 nodes · 0 ways · 0 relations");
    // The GeoJSON carries the ordinal of the feature output within the query.
    await page.getByLabel("Export format").selectOption("geojson");
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const collection = await json(await (await downloaded).createReadStream());
    assert.deepEqual(collection.features.map(f => f.id).sort(), expected.map(id => "0:" + id));
    console.log(mode + " returned 15 expected IDs followed by the 15-node count.");
  } catch (error) {
    throw Error(mode + ": " + await page.locator("#status").textContent({ timeout: 1000 }).catch(() => "unavailable"), { cause: error });
  } finally {
    lines.close();
    server.kill();
    await Promise.all([page.close(), exited]);
  }
}
try {
  await checkSite("Native", process.env.REGOL_LIVE || "target/debug/regol-live",
    [gol, "--port", "0", "--area-index", index, "--view", "-0.128,51.507,15"], process.env);
  await checkSite("WASM", process.execPath, ["scripts/serve.mjs"], { ...process.env, PORT: "0" });
  console.log("CLI, native Live and browser WASM returned the same 15 turbine IDs followed by the 15-node count.");
} finally {
  await browser.close();
}
