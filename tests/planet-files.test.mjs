import assert from "node:assert/strict";
import test from "node:test";
import { isPlanetFile, planetGobURL, planetURL, selectPlanetFiles } from "../web/planet-files.js";

const now = Date.parse("2026-11-23T01:00:00Z");
function row(ext, day, name = day) {
  return {
    remote_path: "osm/planet/" + ext, remote_version: ext === "gob" ? "v1" : "v2",
    extension: ext, remote_filename: `planet-${name}.osm.${ext}`, updated: Date.parse(day),
  };
}

test("chooses the newest common UTC day and prefers an addressable dated file", () => {
  const rows = [
    row("gol", "2026-11-23", "latest"), row("gob", "2026-11-21"),
    row("gol", "2026-11-21"), row("gol", "2026-11-22"), row("gob", "2026-11-22", "latest"),
    row("gob", "2026-11-23", "2026-11-22"), { ...row("gob", "2026-11-23"), deprecated: true },
  ];
  for (const files of [rows, rows.toReversed()]) {
    const { gol, gob } = selectPlanetFiles(files, now);
    assert.equal(gol.date, "2026-11-22");
    assert.equal(gob.date, gol.date);
    assert.equal(gol.url, planetURL.replace("latest", gol.date));
    assert.equal(gob.url, planetGobURL.replace("latest", gob.date));
  }
});

test("accepts the seventh UTC day and falls back to individual dates outside the window", () => {
  const latest = [row("gol", "2026-11-23", "latest"), row("gob", "2026-11-22", "latest")];
  const pair = date => [row("gol", date), row("gob", date)];
  assert.equal(selectPlanetFiles([...latest, ...pair("2026-11-17")], now).gol.date, "2026-11-17");
  const files = selectPlanetFiles([...latest, ...pair("2026-11-16"), ...pair("2026-11-24")], now);
  assert.equal(files.gol.date, "2026-11-23");
  assert.equal(files.gob.date, "2026-11-22");
  assert.equal(files.gol.url, planetURL);
  assert.equal(files.gob.url, planetGobURL);
});

test("missing catalog records leave the rolling files available with unknown dates", () => {
  const wrong = { ...row("gol", "2026-11-23"), remote_version: "v1" };
  const files = selectPlanetFiles([wrong, row("gob", "2026-02-31", "2026-02-31")], now);
  assert.deepEqual(files, { gol: { url: planetURL, date: null }, gob: { url: planetGobURL, date: null } });
  assert.equal(isPlanetFile(planetURL.replace("planet-latest", "../planet-latest"), "gol"), false);
});
