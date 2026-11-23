import test from "node:test";
import assert from "node:assert/strict";
import { ViewportReadAhead } from "../web/read-ahead.js";
import { pageBytes } from "../web/ranges.js";
import { blockBytes } from "../web/range-cache.js";

test("local whole-tile prefetch requires repeated slow reads or distinct long gaps", () => {
  const ahead = new ViewportReadAhead();
  const timings = [];
  function observe(start, duration, pausedBefore = 0) {
    const read = { start, headersAt: start + duration, end: start + duration, pausedBefore };
    timings.push(read);
    ahead.observeRead(pageBytes, read);
  }
  observe(0, 150);
  assert.equal(ahead.shouldExpandLocal(timings, 300), false);
  assert.equal(ahead.shouldExpandLocal(timings, 310), false);
  observe(310, 2, 160);
  assert.equal(ahead.shouldExpandLocal(timings, 420), false);
  observe(420, 2);
  assert.equal(ahead.shouldExpandLocal(timings, 521), false);
  assert.equal(ahead.shouldExpandLocal(timings, 522), true);
  observe(523, 25);
  assert.equal(ahead.shouldExpandLocal(timings, 549), false);
  observe(549, 25);
  assert.equal(ahead.shouldExpandLocal(timings, 574), true);
});

test("portable GOL directory schedules disjoint viewport headers together", async () => {
  const first = new Uint8Array(pageBytes);
  const header = new DataView(first.buffer);
  header.setUint32(0, 0x1ce50d6e, true);
  header.setUint32(4, 2, true);
  header.setUint32(96, 3, true); // root and zoom one
  header.setUint32(152, 1, true); // directory at 4096
  header.setUint32(4096, 24, true);
  const starts = [1, 3, 5, 7, 9].map((n) => n * 1024 * 1024);
  const tileWord = (offset) => (offset / 4096) * 4 + 2;
  header.setUint32(4100, tileWord(starts[0]), true);
  header.setUint32(4104, 15, true);
  for (let i = 1; i < starts.length; i++)
    header.setUint32(4104 + 4 * i, tileWord(starts[i]), true);
  const ahead = new ViewportReadAhead();
  ahead.remember(0, first);
  const reads = [];
  let active = 0,
    peak = 0;
  const source = {
    size: 10 * 1024 * 1024,
    read: async (start, length) => {
      reads.push(start);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      const data = new Uint8Array(length);
      new DataView(data.buffer).setUint32(0, 2 * pageBytes - 4, true);
      return data;
    },
  };
  const windows = [[-0.1, -0.1, 0.1, 0.1]];
  await ahead.prepareHeaders(source, windows, () => 1024, false);
  assert.deepEqual(reads, []);
  const plan = await ahead.prepareHeaders(source, windows, () => source.size, false);
  assert.deepEqual(plan.spans.filter((s) => s.zoom !== undefined),
    starts.map((start, i) => ({ start, end: start + 2 * pageBytes, zoom: i === 0 ? 0 : 1 })));
  assert.deepEqual(
    reads.sort((a, b) => a - b),
    starts,
  );
  assert.equal(peak, starts.length);
  await ahead.prepareHeaders(source, windows, () => source.size, false);
  assert.equal(reads.length, 5);
});

test("remote misses batch nearby pages and same-zoom peers only when headers dominate", async () => {
  const mib = 1024 * 1024;
  const spans = [0, 9, 18, 27, 36, 45, 54].map((n, i) => ({
    start: n * mib + 4096, end: (n + 8) * mib - 4096, zoom: i === 0 ? 0 : 12,
  }));
  const plan = { spans, visited: new Set(), peerBytes: 0 };
  const reads = [];
  let active = 0, peak = 0;
  const source = {
    size: 64 * mib,
    async read(start, length) {
      reads.push([start, length]);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return new Uint8Array(length).fill(start / mib);
    },
  };
  const start = 10 * mib;
  for (const [wait, body] of [[5, 1], [100, 70]]) {
    const fastOrBandwidthLimited = new ViewportReadAhead();
    fastOrBandwidthLimited.observeRead(pageBytes, { start: 0, headersAt: wait, end: wait + body });
    await fastOrBandwidthLimited.readAround(source, start, pageBytes, plan, 48 * mib);
  }
  const ahead = new ViewportReadAhead();
  ahead.observeRead(pageBytes, { start: 0, headersAt: 200, end: 203 });
  await ahead.readAround(source, start, pageBytes, plan, 2 * mib + pageBytes);
  await ahead.readAround(source, 8 * mib + pageBytes, pageBytes, plan, 48 * mib);
  assert.deepEqual(reads, []);
  const data = await ahead.readAround(source, start, pageBytes, plan, 48 * mib);
  assert.equal(data[0], 10);
  assert.deepEqual(reads[0], [start, mib]);
  assert.equal(peak, 5);
  assert(reads.slice(1).every(([p, length]) => p >= 18 * mib && length <= mib / 2));
  assert.equal(plan.peerBytes, 2 * mib);
  assert.equal(ahead.get(start + pageBytes, pageBytes)[0], 10);

  reads.length = 0;
  await ahead.readAround(source, 11 * mib, pageBytes, plan, 3 * mib);
  assert.deepEqual(reads, [[11 * mib, mib]], "demand keeps the final 2 MiB");
  for (let i = 12; i < 17; i++)
    await ahead.readAround(source, i * mib, pageBytes, plan, 48 * mib);
  assert.equal(plan.peerBytes, 8 * mib);
  reads.length = 0;
  await ahead.readAround(source, 24 * mib, pageBytes, plan, 48 * mib);
  assert.deepEqual(reads, [[24 * mib, mib]], "the per-query peer budget is exhausted");
});

test("a partially persisted page refills only missing blocks and clips the final page", async () => {
  const ahead = new ViewportReadAhead();
  const known = new Set([blockBytes, 2 * blockBytes]);
  const reads = [];
  const size = pageBytes + 37;
  const bytes = Uint8Array.from({ length: size }, (_, i) => Math.floor(i / blockBytes));
  await ahead.fill({
    size, cache: { known },
    async read(start, length) {
      reads.push([start, length]);
      return bytes.slice(start, start + length);
    },
  }, [0, pageBytes], 2 * pageBytes);
  assert.deepEqual(reads, [[0, blockBytes], [blockBytes, 2 * blockBytes], [3 * blockBytes, size - 3 * blockBytes]]);
  assert.deepEqual(ahead.get(0, size), bytes);
});

test("evicting speculative pages across queries preserves explicitly downloaded tiles", () => {
  const ahead = new ViewportReadAhead();
  ahead.pinned.add(0);
  // Eviction counts page slots. Small buffers exercise the same order.
  for (let i = 0; i <= 390; i++) ahead.remember(i * pageBytes, Uint8Array.of(1));
  assert.equal(ahead.pages.size, 1 + 48 * 1024 * 1024 / pageBytes);
  assert(ahead.pages.has(0));
  assert(!ahead.pages.has(pageBytes));
  assert(ahead.pages.has(390 * pageBytes));
});

test("a larger prefetch batch serves every range with at most eight active reads", async () => {
  const ahead = new ViewportReadAhead();
  const pages = Array.from({ length: 19 }, (_, i) => 2 * i * pageBytes);
  let active = 0,
    peak = 0;
  const reads = [];
  const source = {
    size: pages.at(-1) + pageBytes,
    async read(start, length) {
      reads.push(start);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return new Uint8Array(length);
    },
  };
  await ahead.fill(source, pages, source.size);
  assert.equal(peak, 8);
  assert.deepEqual(reads, pages);
  assert.equal(ahead.pages.size, pages.length);
});

test("local read-ahead fills disjoint ranges concurrently, clips EOF and reuses pages", async (t) => {
  const url = "http://localhost/datasets/uk-tiles.json";
  const windows = [[-0.2, 51.4, 0, 51.6]];
  const size = 20 * pageBytes + 37;
  const source = { etag: '"v1"', size };
  const hints = {
    etag: source.etag,
    directory: [8 * pageBytes, 8 * pageBytes + 8],
    metadataEnd: 4096,
    tiles: [{ start: 20 * pageBytes, end: size, zoom: 12 }],
  };
  t.mock.method(globalThis, "fetch", async (request) => {
    assert.equal(
      new URL(request).searchParams.get("bbox"),
      windows[0].join(","),
    );
    return Response.json(hints);
  });
  const ahead = new ViewportReadAhead();
  let active = 0,
    peak = 0,
    gets = 0;
  source.read = async (start, length) => {
    assert(start + length <= size);
    peak = Math.max(peak, ++active);
    gets++;
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    const data = new Uint8Array(length);
    for (let i = 0; i < length; i += pageBytes)
      data.fill((start + i) / pageBytes, i, i + pageBytes);
    return data;
  };
  await ahead.prepare(source, url, windows, size);
  assert.equal(peak, 3);
  assert.equal(gets, 3);
  assert.equal(ahead.get(20 * pageBytes, 37).at(-1), 20);
  assert.equal(ahead.get(20 * pageBytes + 16, 22), null);
  assert.equal(ahead.get(8 * pageBytes, 2 * pageBytes).at(-1), 9);
  assert.equal(ahead.get(8 * pageBytes + 16384, 16384)[0], 8);
  assert.deepEqual([...ahead.get(9 * pageBytes - 2, 5)], [8, 8, 9, 9, 9]);
  assert.equal(ahead.get(4 * pageBytes - 2, 5), null);
  assert.equal(ahead.get(4 * pageBytes, pageBytes), null);
  await ahead.prepare(source, url, windows, size);
  assert.equal(gets, 3);
  for (const [etag, budget] of [
    ['"v2"', size],
    ['"v1"', 0],
  ]) {
    const empty = new ViewportReadAhead();
    await empty.prepare({ ...source, etag }, url, windows, budget);
    assert.equal(empty.get(0, pageBytes), null);
  }
  assert.equal(gets, 3);
});
