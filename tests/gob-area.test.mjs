import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GobArea, GobQueryError, planetGobURL } from "../web/gob-area.js";
import { AreaDownload } from "../web/area-download.js";
import { RangeQueries } from "../web/query-backend.js";
import { RangeFile, planetURL } from "../web/ranges.js";

const west = [[-2, 0, -1, 1]];
const east = [[1, 0, 2, 1]];
const modified = "Sun, 22 Nov 2026 00:00:00 GMT";
const tileset = "5582b71fd24a428bac7a15bb9d82e91c";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fixture(decodedTiles = Infinity) {
  const prefixLength = 68 + 3 * 8 + 8;
  const file = new Uint8Array(prefixLength + 24);
  const header = new DataView(file.buffer);
  header.setUint32(0, 0xe0f6b060, true);
  header.setUint32(4, 2, true);
  header.setUint32(28, 3, true);
  header.setUint32(48, 8, true);
  const entry = (tip) => ({ tip, offset: prefixLength + 8 * (tip - 1), length: 8 });
  const reads = [];
  function reply(url, options, headers = {}) {
    assert.equal(url, planetGobURL);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range).map(Number);
    reads.push([start, end]);
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { "Last-Modified": modified, "Content-Length": end - start + 1, ...headers },
    });
  }
  function engine() {
    const memory = new Uint8Array(4096);
    const loaded = new Set();
    let inputLength;
    const output = (value) => encoder.encodeInto(JSON.stringify(value), memory.subarray(1024)).written;
    const status = (tip) => ({ ...entry(tip), loaded: loaded.has(tip) });
    function allocate(length) {
      inputLength = length;
      return 1;
    }
    return {
      memory,
      output_ptr: () => 1024,
      gob_input_buffer: allocate,
      input_buffer: allocate,
      gob_open() {
        loaded.clear();
        assert.deepEqual(memory.slice(1, 1 + inputLength), file.slice(0, prefixLength));
        return output({ tileset, revision: 124410, size: file.length });
      },
      gob_plan: (longitude) => output({ tiles: [status(1), status(longitude < 0 ? 2 : 3)] }),
      gob_import(tip) {
        assert.equal(inputLength, entry(tip).length);
        assert(!loaded.has(tip));
        if (loaded.size >= decodedTiles) return output({ error: "Decoded tile limit", decodedLimit: true });
        loaded.add(tip);
        return 0;
      },
      gob_entry: (tip) => output(status(tip)),
      gob_query() {
        const { dependency, invalid } = JSON.parse(decoder.decode(memory.subarray(1, 1 + inputLength)));
        if (invalid) return output({ error: "Invalid selector" });
        const missing = [dependency].flat().find(tip => tip && !loaded.has(tip));
        return missing
          ? output({ missingTile: missing })
          : output({ features: [] });
      },
    };
  }
  return { engine, reply, prefixLength, reads };
}

test("GOB plans from the compressed catalog and loads cross-tile dependencies within budget", async (t) => {
  const { engine, reply, prefixLength, reads } = fixture();
  t.mock.method(globalThis, "fetch", reply);
  const signal = new AbortController().signal;
  const catalog = await GobArea.open(engine, () => {}, signal);
  assert.deepEqual(reads, [[0, 63], [64, prefixLength - 1]]);
  const plan = catalog.plan(west);
  assert.deepEqual(catalog.estimate(plan), { tiles: 2, missing: 16, total: 16 });
  const downloaded = await catalog.download(plan, signal);
  assert.deepEqual(reads[2], [prefixLength, prefixLength + 15]);
  assert.deepEqual(downloaded.estimate(downloaded.plan(west)), { tiles: 2, missing: 0, total: 16 });
  assert.deepEqual(downloaded.estimate(downloaded.plan([...west, ...east])), { tiles: 3, missing: 8, total: 24 });
  const request = encoder.encode(JSON.stringify({ dependency: 3 }));
  await assert.rejects(downloaded.query(request, () => 7), /more planet tiles/);
  assert.equal(reads.length, 3);
  assert.deepEqual((await downloaded.query(request, () => 8)).value, { features: [] });
  assert.deepEqual(reads[3], [prefixLength + 16, prefixLength + 23]);
  await downloaded.query(request, () => 0);
  assert.equal(reads.length, 4);
  await assert.rejects(downloaded.query(encoder.encode('{"invalid":true}'), () => 8), GobQueryError);
  assert.equal(reads.length, 4);
  const fresh = await GobArea.open(engine, () => {}, signal);
  assert(downloaded.matchesArchive(fresh));
  fresh.prefix[68] ^= 1;
  assert(!downloaded.matchesArchive(fresh), "same-size, same-validator prefix changes prevent reuse");
});

test("a later reader loads the same checked GOB prefix in one request", async (t) => {
  const { engine, reply, prefixLength, reads } = fixture();
  t.mock.method(globalThis, "fetch", reply);
  const previous = globalThis.caches;
  const stored = new Map();
  globalThis.caches = { open: async () => ({
    match: async (url) => stored.get(url),
    put: async (url, hint) => stored.set(url, hint),
  }) };
  t.after(() => {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  });
  const signal = new AbortController().signal;
  const date = "2026-11-22";
  const open = () => GobArea.open(engine, () => {}, signal, planetGobURL, date);
  const first = await open();
  assert.deepEqual(reads, [[0, 63], [64, prefixLength - 1]]);
  reads.length = 0;
  const repeat = await open();
  assert.deepEqual(reads, [[0, prefixLength - 1]]);
  assert(first.matchesArchive(repeat));

  function hint(length, savedDate = date) {
    stored.set(planetGobURL, new Response(null, { headers: {
      "X-Regol-Prefix-Length": String(length), "X-Regol-Snapshot-Date": savedDate,
    } }));
    reads.length = 0;
  }
  hint(prefixLength - 10);
  assert(first.matchesArchive(await open()));
  assert.deepEqual(reads, [[0, prefixLength - 11], [prefixLength - 10, prefixLength - 1]]);
  hint(prefixLength + 10);
  assert(first.matchesArchive(await open()));
  assert.deepEqual(reads, [[0, prefixLength + 9]]);
  hint(prefixLength + 100);
  assert(first.matchesArchive(await open()));
  assert.deepEqual(reads, [[0, prefixLength + 99], [0, 63], [64, prefixLength - 1]]);
  hint(prefixLength, "2026-11-21");
  assert(first.matchesArchive(await open()));
  assert.deepEqual(reads, [[0, 63], [64, prefixLength - 1]]);
  hint(4 * 1024 * 1024 + 1);
  assert(first.matchesArchive(await open()));
  assert.deepEqual(reads, [[0, 63], [64, prefixLength - 1]]);
});

test("a download larger than the decoded working set remains usable without network", async (t) => {
  const { engine, reply, reads } = fixture(1);
  t.mock.method(globalThis, "fetch", reply);
  const signal = new AbortController().signal;
  const catalog = await GobArea.open(engine, () => {}, signal);
  const both = catalog.plan([...west, ...east]);
  const saved = await catalog.download(both, signal);
  const gets = reads.length;
  assert.equal(saved.estimate(saved.plan([...west, ...east])).missing, 0);
  const query = dependency => saved.query(encoder.encode(JSON.stringify({ dependency })), () => 0, signal);
  for (const tip of [1, 2, 3]) assert.deepEqual((await query(tip)).value.features, []);
  await assert.rejects(query([1, 2]), /Decoded tile limit/);
  assert.deepEqual((await query(3)).value.features, []);
  assert.equal(reads.length, gets);
});

test("oversize GOB estimates report the full archive footprint and suppress body reads", async (t) => {
  const { engine, reply, reads } = fixture();
  t.mock.method(globalThis, "fetch", reply);
  const signal = new AbortController().signal;
  const catalog = await GobArea.open(engine, () => {}, signal);
  const entries = [140, 120].map((mib, tip) => ({ tip, length: mib * 2 ** 20 }));
  const estimate = catalog.estimate(entries);
  assert.equal(estimate.total, 260 * 2 ** 20);
  assert.equal(estimate.limitBytes, 256 * 2 ** 20);
  const count = reads.length;
  await assert.rejects(catalog.download(entries, signal), /smaller area/);
  assert.equal(reads.length, count);
});

test("GOB cancellation and snapshot changes preserve a previously completed store", async (t) => {
  const { engine, reply, prefixLength } = fixture();
  let startDelayedRead;
  const delayed = new Promise((resolve) => { startDelayedRead = resolve; });
  let later;
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (options.headers.Range !== `bytes=${prefixLength + 16}-${prefixLength + 23}`)
      return reply(url, options);
    if (later) return reply(url, options, { "Last-Modified": later });
    return new Promise((_, reject) => {
      startDelayedRead();
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const catalog = await GobArea.open(engine, () => {}, controller.signal);
  const downloaded = await catalog.download(catalog.plan(west), controller.signal);
  const extension = downloaded.download(downloaded.plan(east), controller.signal);
  await delayed;
  controller.abort();
  await assert.rejects(extension, { name: "AbortError" });
  assert.equal(downloaded.invalidated, undefined);
  assert(downloaded.plan(west).every(({ loaded }) => loaded));
  assert(downloaded.plan(east).some(({ loaded }) => !loaded));
  later = "Mon, 23 Nov 2026 00:00:00 GMT";
  await assert.rejects(downloaded.download(downloaded.plan(east), new AbortController().signal), /snapshot changed/);
  assert.equal(downloaded.invalidated, true);
  assert(downloaded.plan(west).every(({ loaded }) => loaded));
});

test("rolling files that advanced past the catalog date cannot enter the selected pair", async (t) => {
  const { engine, reads, reply } = fixture();
  t.mock.method(globalThis, "fetch", async (url, options) => url === planetURL
    ? new Response(null, { headers: { "Last-Modified": modified, "Content-Length": "1024" } })
    : reply(url, options));
  const date = "2026-11-21";
  await assert.rejects(GobArea.open(engine, () => {}, new AbortController().signal, planetGobURL, date), /date was selected/);
  assert.deepEqual(reads, [[0, 63]], "no tiles read from a GOB with the wrong date");
  await assert.rejects(new RangeFile(planetURL, () => {}).open(date), /date was selected/);
});

test("switching datasets discards the worker even with an area estimate in flight", (t) => {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    messages = [];
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  };
  t.after(() => {
    if (original === undefined) delete globalThis.Worker;
    else globalThis.Worker = original;
  });
  const backend = new RangeQueries();
  backend.run({ type: "estimate-area", url: planetURL }, () => {}, () => {});
  const previous = backend.worker;
  backend.cancel();
  assert.equal(previous.messages.at(-1).type, "cancel-area");
  assert.equal(previous.terminated, undefined);
  backend.reset();
  assert.equal(previous.terminated, true);
  assert.equal(backend.worker, null);
  backend.run({ type: "estimate-area", url: planetURL }, () => {}, () => {});
  assert.notEqual(backend.worker, previous);
});

test("worker reconfirms GOL fallback, refreshes failed catalogs, and keeps valid downloaded tiles", { timeout: 3000 }, async (t) => {
  const file = new Uint8Array(await readFile(new URL("./fixtures/geography.gol", import.meta.url)));
  let golOpens = 0;
  let golSource;
  let pauseOpen;
  t.mock.method(RangeFile.prototype, "open", async function () {
    golOpens++;
    golSource = this;
    await pauseOpen?.(this.signal);
    this.size = file.length;
    this.modified = modified;
  });
  t.mock.method(RangeFile.prototype, "read", async (start, length) => file.slice(start, start + length));
  // Exercise failed archive imports with a more expensive GOL alternative.
  t.mock.method(AreaDownload.prototype, "planFromCache", async () => ({ tiles: 1, missing: 16 }));
  t.mock.method(globalThis, "fetch", async () => new Response());
  t.mock.method(WebAssembly, "compileStreaming", async () => ({}));
  t.mock.method(WebAssembly, "instantiate", async () => {
    const memory = new Uint8Array(4096);
    const outputLength = encoder.encodeInto('{"features":[]}', memory.subarray(1024)).written;
    return { exports: {
      memory, open_gol: () => 0, cached_block: () => 0,
      input_buffer: () => 1, output_ptr: () => 1024, query: () => outputLength,
    } };
  });
  t.mock.method(WebAssembly, "promising", (fn) => fn);
  let unavailable = true;
  let downloadFails = true;
  let queryMode = "application-error";
  let pendingQuery;
  let archiveSnapshot = "archive";
  let opened = 0;
  t.mock.method(GobArea, "open", async () => {
    opened++;
    if (unavailable) throw Error("Archive unavailable");
    return {
      snapshot: archiveSnapshot,
      api: { memory: new Uint8Array(4096) },
      matchesArchive(other) { return this.snapshot === other.snapshot; },
      async prepare() {},
      async preload() {},
      plan(windows) { return [{ loaded: this.active && windows[0][0] < 0 }]; },
      estimate(entries) { return { tiles: 1, missing: entries[0].loaded ? 0 : 8, total: 8 }; },
      async download() {
        if (downloadFails) throw Error("Chunk unavailable");
        this.active = true;
        return this;
      },
      async query(_request, _remaining, signal) {
        if (pendingQuery) {
          pendingQuery();
          return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }
        if (queryMode === "application-error") throw new GobQueryError("Invalid selector");
        if (queryMode === "changed") {
          this.invalidated = true;
          throw Error("Archive snapshot changed");
        }
        return { value: { features: [] }, resultBytes: 15, engineMs: 0 };
      },
    };
  });

  const messages = [];
  let receive;
  globalThis.onmessage = null;
  globalThis.postMessage = (message) => {
    messages.push(message);
    receive?.(message);
  };
  t.after(() => { delete globalThis.onmessage; delete globalThis.postMessage; });
  await import("../web/worker.js");
  const request = { windows: [[-1, -1, 1, 1]] };
  const send = (id, type, publicPlanet = true, areaRequest = request) =>
    globalThis.onmessage({ data: { id, type, publicPlanet, url: planetURL, gobURL: planetGobURL, request: areaRequest } });
  const next = (type, transport) => new Promise((resolve) => {
    receive = (message) => {
      if (message.type === type && message.transport === transport) resolve(message);
    };
  });
  async function plan(id, areaRequest) {
    const pending = next("area-estimate", "gob");
    const finished = send(id, "plan-area", true, areaRequest);
    return { estimate: await pending, finished };
  }

  await send(1, "estimate-area", false);
  assert.equal(messages.at(-1).type, "area-estimate");
  assert.equal(opened, 0, "custom dataset requests stay on GOL even for the public GOL URL");
  await send(2, "estimate-area");
  assert.equal(opened, 1);
  assert.equal(messages.at(-1).transport, undefined);

  unavailable = false;
  const initial = await plan(3);
  assert.equal(initial.estimate.missing, 8);
  const direct = next("area-estimate");
  send(3, "confirm-area");
  const fallback = await direct;
  assert.equal(fallback.id, 3);
  assert.equal(fallback.archiveTotal, initial.estimate.total, "switching transfer formats keeps the same footprint");
  assert(fallback.total > fallback.archiveTotal);
  assert(messages.some(({ type }) => type === "area-fallback"));
  assert(!messages.some(({ id, type }) => id === 3 && type === "area-ready"));
  send(3, "confirm-area");
  await initial.finished;
  assert.equal(messages.at(-1).type, "area-ready");
  assert.equal(golOpens, 1, "a different GOB snapshot leaves the open GOL usable");

  const wider = { windows: [[-2, -2, 2, 2]] };
  const cancelled = await plan(4, wider);
  assert.equal(opened, 3, "retrying a failed download opens a fresh archive catalog");
  send(4, "cancel-area");
  await cancelled.finished;
  assert(!messages.some(({ id, type }) => id === 4 && (type === "area-ready" || type === "area-fallback")));

  downloadFails = false;
  const activate = await plan(5, wider);
  send(5, "confirm-area");
  await activate.finished;
  await send(6, "query");
  assert.equal(messages.at(-1).message, "Invalid selector");
  assert.equal(golOpens, 1, "application errors do not reopen GOL");

  const entered = new Promise(resolve => { pendingQuery = resolve; });
  const running = send(60, "query");
  await entered;
  const queued = send(61, "query");
  send(61, "cancel-query");
  send(60, "cancel-query");
  await Promise.all([running, queued]);
  pendingQuery = null;
  assert(!messages.some(message => [60, 61].includes(message.id)));
  assert.equal(golOpens, 1, "cancellation never falls back to the GOL");
  await send(62, "estimate-area");
  assert.equal(messages.at(-1).covered, true);
  assert.deepEqual(messages.at(-1).downloadedWindows, wider.windows);
  assert.equal(messages.at(-1).missing, 0);

  downloadFails = true;
  const replacement = await plan(7, { windows: east });
  assert.equal(replacement.estimate.missing, 8);
  const replacementFallback = next("area-estimate");
  send(7, "confirm-area");
  await replacementFallback;
  send(7, "confirm-area");
  await replacement.finished;
  assert.equal(messages.at(-1).type, "area-ready");
  assert.equal(golOpens, 1);
  await send(71, "query", true, { windows: east });
  assert.equal(messages.at(-1).transport, undefined, "the active direct download serves queries inside its bounds");
  queryMode = "success";
  await send(8, "query");
  assert.equal(messages.at(-1).transport, "gob", "a recoverable replacement failure keeps the completed GOB store");

  const refreshed = await plan(9);
  assert.equal(opened, 4);
  assert.equal(refreshed.estimate.missing, 0, "matching fresh catalogs reuse downloaded chunks");
  send(9, "cancel-area");
  await refreshed.finished;

  const failedAgain = await plan(10, { windows: [[1, 0, 3, 1]] });
  const fallbackAgain = next("area-estimate");
  send(10, "confirm-area");
  await fallbackAgain;
  send(10, "cancel-area");
  await failedAgain.finished;

  archiveSnapshot = "new-archive-revision";
  const changed = await plan(11);
  assert.equal(changed.estimate.missing, 8);
  send(11, "cancel-area");
  await changed.finished;
  await send(12, "query");
  assert.equal(messages.at(-1).type, "result");
  assert.equal(messages.at(-1).transport, undefined, "a fresh revision makes the previous GOB store stale");
  assert.equal(golOpens, 1);

  downloadFails = false;
  const activateChanged = await plan(13);
  send(13, "confirm-area");
  await activateChanged.finished;
  queryMode = "changed";
  await send(14, "query");
  assert.equal(messages.at(-1).type, "result");
  assert.equal(messages.at(-1).transport, undefined);
  assert.equal(golOpens, 1, "GOB invalidation leaves the independent GOL reader warm");
  golSource.invalidated = true;
  await send(141, "query");
  assert.equal(golOpens, 2, "a change to the GOL itself reopens its reader");

  const customURL = "https://example.test/local.gol";
  let openedSignal;
  const opening = new Promise((resolve) => { openedSignal = resolve; });
  let releaseOpen;
  const released = new Promise((resolve) => { releaseOpen = resolve; });
  pauseOpen = async (signal) => { openedSignal(signal); await released; };
  const interrupted = globalThis.onmessage({ data: { id: 15, type: "estimate-area", url: customURL, request } });
  const signal = await opening;
  globalThis.onmessage({ data: { id: 15, type: "cancel-area", reuseSource: customURL } });
  const foreground = globalThis.onmessage({ data: { id: 16, type: "query", url: customURL, request } });
  releaseOpen();
  await Promise.all([interrupted, foreground]);
  assert.equal(signal.aborted, false);
  assert.equal(golOpens, 3, "the next query reuses the superseded same-source bootstrap");
  assert(!messages.some(({ id, type }) => id === 15 && type === "area-estimate"));
  assert.equal(messages.at(-1).type, "result");
});
