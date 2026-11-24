import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadOutline, insideDownloadedArea, windows } from "../web/viewport.js";
import { RangeFile, readBody } from "../web/ranges.js";

test("wrapped and whole-world views remain within valid GOL query bounds", () => {
  assert.deepEqual(windows(170, -5, 190, 5), [
    [170, -5, 180, 5],
    [-180, -5, -170, 5],
  ]);
  assert.deepEqual(windows(367, -2, 369, 3), [[7, -2, 9, 3]]);
  assert.deepEqual(windows(-310, -92, 310, 91), [[-180, -90, 180, 90]]);
});
test("truncated and oversized range bodies are rejected before caching", async () => {
  await assert.rejects(readBody(new Response(new Uint8Array(3)), 4), /early/);
  await assert.rejects(readBody(new Response(new Uint8Array(5)), 4), /exceeds/);
});
test("rejects a full file and detects a changing or displaced range", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  const size = 131080;
  const response = (start, end, etag) =>
    new Response(new Uint8Array(end - start + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${size}`, ETag: etag },
    });
  const file = new RangeFile("https://example.test/v1.gol", () => {});
  fetch.mock.mockImplementation(async () => new Response("full"));
  await assert.rejects(file.open(), /206/);
  fetch.mock.mockImplementation(async () => response(0, 131071, '"first"'));
  await file.open();
  await file.read(0, 131072);
  fetch.mock.mockImplementation(async () =>
    response(131072, 131079, '"different"'),
  );
  await assert.rejects(file.read(131072, 8), /changed/);
  fetch.mock.mockImplementation(async () => response(0, 7, '"first"'));
  await assert.rejects(file.read(131072, 8), /different range/);
});

test("automatic queries require every viewport segment to fit the confirmed download", () => {
  const download = [[170,-10,180,10],[-180,-10,-170,10]];
  assert(insideDownloadedArea(download, [[175,-2,180,2],[-180,-2,-175,2]]));
  assert(!insideDownloadedArea(download, [[175,-2,180,2],[-180,-2,-169,2]]));
  assert(!insideDownloadedArea(download, [[0,-2,1,2]]));
  assert(!insideDownloadedArea(undefined, download));
});

test("the downloaded outline stays on the two sides of a wrapped view", () => {
  const shape = downloadOutline(windows(170, -5, 190, 5));
  assert.deepEqual(shape.coordinates, [
    [[180,5],[170,5],[170,-5],[180,-5]],
    [[-180,-5],[-170,-5],[-170,5],[-180,5]],
  ]);
  assert.equal(downloadOutline(null), null);
});
