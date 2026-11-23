import assert from "node:assert/strict";
import test from "node:test";
import { AreaDownload } from "../web/area-download.js";
import { ViewportReadAhead } from "../web/read-ahead.js";
import { blockBytes } from "../web/range-cache.js";
import { pageBytes } from "../web/ranges.js";

// Three tiles: the root and the two northern quadrants. The eastern tile
// finishes at an unaligned EOF. A wrapped viewport visits the root twice.
function fixture() {
  const starts = [pageBytes, 4 * pageBytes, 8 * pageBytes];
  const bytes = new Uint8Array(starts[2] + pageBytes + 37);
  for (let p = 0; p < bytes.length; p += blockBytes)
    bytes.fill(p / blockBytes, p, p + blockBytes);
  const header = new DataView(bytes.buffer);
  const set = (p, n) => header.setUint32(p, n, true);
  set(0, 0x1ce50d6e);
  set(4, 2);
  set(96, 3);
  set(152, 1);
  set(4096, 16);
  set(4100, 4 * starts[0] / 4096 + 2);
  set(4104, 3);
  set(4108, 4 * starts[1] / 4096 + 2);
  set(4112, 4 * starts[2] / 4096 + 2);
  for (const p of starts) set(p, pageBytes - 4);
  set(starts[2], pageBytes + 33);
  const known = new Set([starts[1] + blockBytes]);
  const network = [];
  const source = {
    size: bytes.length, cache: { known },
    async read(start, length) {
      let hits = 0;
      for (let p = start; p < start + length; p += blockBytes) hits += Number(known.has(p));
      assert(!hits || hits === Math.ceil(length / blockBytes), "separate stored and missing ranges");
      if (!hits) network.push([start, length]);
      return bytes.slice(start, start + length);
    },
  };
  const ahead = new ViewportReadAhead();
  ahead.remember(0, bytes.subarray(0, pageBytes));
  const wasmBlock = (start, length) => start === starts[2] + blockBytes
    ? bytes.subarray(start, start + length) : null;
  const plan = () => new AreaDownload(source, ahead, wasmBlock, false);
  return { bytes, starts, source, ahead, network, plan, set };
}

const wrapped = [[179, 1, 180, 2], [-180, 1, -179, 2]];
test("comparing a warm GOL with the GOB reads only cached metadata", async () => {
  const { plan, network, source } = fixture();
  source.cached = async () => null;
  const area = plan();
  assert.equal(await area.planFromCache(wrapped), null);
  assert.deepEqual(network, []);
  const expected = await area.plan(wrapped);
  network.length = 0;
  assert.deepEqual(await area.planFromCache(wrapped), expected);
  assert.deepEqual(network, []);
});

test("estimate discovers only headers and downloads exactly the uncached blocks", async () => {
  const { bytes, starts, source, ahead, network, plan } = fixture();
  const area = plan();
  const { tiles, missing, total } = await area.plan(wrapped);
  assert.equal(tiles, 3);
  assert.equal(total, 4 * pageBytes + 37);
  assert.deepEqual(network, starts.map((s) => [s, blockBytes]));
  assert.equal(missing, 3 * pageBytes + 37 - 5 * blockBytes);
  network.length = 0;
  await area.download();
  assert.equal(network.reduce((n, [, length]) => n + length, 0), missing);
  for (const p of ahead.pinned)
    assert.deepEqual(ahead.get(p, Math.min(pageBytes, source.size - p)), bytes.slice(p, p + pageBytes));
  network.length = 0;
  await ahead.fill(source, new Set(), 0, true);
  const repeat = plan();
  assert.deepEqual(await repeat.plan(wrapped), { tiles: 3, missing: 0, total });
  await repeat.download();
  assert.deepEqual(network, []);
});

test("rechecking the header size reuses discovery reads and keeps the pinned view", async () => {
  const { ahead, network, plan, starts, source } = fixture();
  const area = plan();
  const west = [wrapped[1]];
  const initial = await area.plan(west);
  network.length = 0;
  assert.deepEqual(await area.plan(west), initial);
  assert.deepEqual(network, []);
  source.cache.known.add(starts[1] + 2 * blockBytes);
  assert.deepEqual(await area.plan(west), { ...initial, missing: initial.missing - blockBytes });
  await area.download();
  const pinned = [...ahead.pinned];
  const larger = await area.plan(wrapped);
  assert(larger.total > initial.total && larger.missing > 0);
  assert.deepEqual([...ahead.pinned], pinned);
  assert(!ahead.pinned.has(starts[2]));
  assert.deepEqual(await area.plan(west), { ...initial, missing: 0 });
});

test("invalid extents and interrupted downloads preserve the last complete area", async () => {
  const { starts, source, ahead, plan, set } = fixture();
  const west = plan();
  await west.plan([wrapped[1]]);
  await west.download();
  const previous = ahead.pinned;
  const both = plan();
  await both.plan(wrapped);
  const read = source.read;
  source.read = async () => { throw Error("interrupted"); };
  await assert.rejects(both.download(), /interrupted/);
  assert.equal(ahead.pinned, previous);
  assert(!ahead.pages.has(starts[2]));
  source.read = read;
  set(starts[2], source.size);
  await assert.rejects(plan().plan(wrapped));
  assert.equal(ahead.pinned, previous);
});
