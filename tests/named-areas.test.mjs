import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { areaIndexFiles, hasNamedAreas, hostedPlanetIndexURL, nameHash } from "../web/named-areas.js";
import { planetURL } from "../web/ranges.js";

const url = "https://data.example/snapshot.gol";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });

function imports(index, source = url, names) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const files = areaIndexFiles(() => memory, source, () => index, names);
  return {
    fetch(path, limit, snapshot = "") {
      const bytes = encoder.encode(path);
      new Uint8Array(memory.buffer, 8, bytes.length).set(bytes);
      const open = encoder.encode(snapshot);
      new Uint8Array(memory.buffer, 1024, open.length).set(open);
      return files.fetch_area_file(8, bytes.length, limit, 1024, open.length);
    },
    copy(size) {
      if (!files.copy_area_file(256, size)) return null;
      return decoder.decode(new Uint8Array(memory.buffer, 256, size));
    },
  };
}

test("the transport fetches relative assets and copies their unparsed bytes", async () => {
  const files = imports();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push([url.href, options.cache]);
    return new Response("raw bytes");
  };
  const manifest = await files.fetch("manifest.json", 4096);
  assert.equal(files.copy(manifest), "raw bytes");
  assert.equal(files.copy(manifest), null);
  const shard = await files.fetch("v1-generation/aa.json", 64 * 1024 * 1024);
  assert.equal(files.copy(shard), "raw bytes");
  assert.deepEqual(calls, [
    [url + ".areas/manifest.json", "no-cache"],
    [url + ".areas/v1-generation/aa.json", "force-cache"],
  ]);
});

test("the transport stops oversized streams and reports unavailable assets", async () => {
  const files = imports("https://other.example/areas/?token=x");
  let cancelled = false;
  globalThis.fetch = async url => {
    assert.equal(url.href, "https://other.example/areas/manifest.json?token=x");
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("123"));
        controller.enqueue(encoder.encode("456"));
      },
      cancel() { cancelled = true; },
    }));
  };
  assert.equal(await files.fetch("manifest.json", 5), -2);
  assert.equal(cancelled, true);
  assert.equal(files.copy(6), null);
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal(await files.fetch("missing.json", 5), -1);
});

test("a compressed generation supplies plain v1 bytes to Wasm and caps inflated size", async () => {
  const files = imports();
  const snapshot = "v1-1234-abc123-10000";
  const directory = snapshot + "-0123456789abcdef";
  const original = { version: 1, shards: 256, snapshot };
  const payload = JSON.stringify([["Disneyland", [[-50, 12]]]]);
  let compressed = gzipSync(payload);
  globalThis.fetch = async href => {
    if (href.pathname.endsWith("/manifest.json")) {
      return Response.json({ ...original, storage: { format: "gzip", directory }, coverage: {}, attribution: {} });
    }
    assert.equal(href.href, url + ".areas/" + directory + "/aa.json.gz");
    return new Response(compressed);
  };
  assert.deepEqual(JSON.parse(files.copy(await files.fetch("manifest.json", 4096))), original);
  assert.equal(await files.fetch("wrong/aa.json", 4096), -1);
  assert.equal(files.copy(await files.fetch(snapshot + "/aa.json", 4096)), payload);
  compressed = gzipSync("x".repeat(1000));
  assert.equal(await files.fetch(snapshot + "/aa.json", 100), -2);
  assert.equal(files.copy(100), null);
});

test("only named-area queries require the original GOL instead of a GOB view", () => {
  assert.equal(hasNamedAreas({ sets: [{ source: "n[amenity=cafe]" }] }), false);
  assert.equal(hasNamedAreas({ selector: "*" }), false);
  assert.equal(hasNamedAreas({ sets: [{ overpass: { namedArea: { name: "England" } } }] }), true);
});

test("only the hosted planet pairs old coordinate shards with a different open GOL", async () => {
  const published = "v1-1234-aaa-10000", open = "v1-1234-bbb-10001";
  const directory = published + "-0123456789abcdef";
  const manifest = { version: 1, shards: 256, snapshot: published, storage: { format: "gzip", directory } };
  const payload = JSON.stringify([["Disneyland", [[-50, 12]]]]);
  globalThis.fetch = async href => {
    if (href.pathname.endsWith("/manifest.json")) return Response.json(manifest);
    assert.equal(href.href, hostedPlanetIndexURL + "/" + directory + "/a8.json.gz");
    return new Response(gzipSync(payload));
  };
  const planet = imports(hostedPlanetIndexURL, planetURL);
  const queryManifest = JSON.parse(planet.copy(await planet.fetch("manifest.json", 4096, open)));
  assert.deepEqual(queryManifest, { version: 1, shards: 256, snapshot: open });
  assert.equal(await planet.fetch(published + "/a8.json", 4096), -1);
  assert.equal(planet.copy(await planet.fetch(open + "/a8.json", 4096)), payload);
  for (const other of [imports(hostedPlanetIndexURL, url), imports(url + ".areas", planetURL)]) {
    assert.equal(JSON.parse(other.copy(await other.fetch("manifest.json", 4096, open))).snapshot, published);
  }
});

test("a partitioned index sends one small shard for an exact UTF-8 name and reuses it only within the query", async () => {
  const snapshot = "v1-1234-abc123-10000", directory = snapshot + "-0123456789abcdef";
  const calls = [];
  const manifest = { version: 1, snapshot, shards: 256, storage: { format: "gzip", directory, partitionBits: 4 } };
  globalThis.fetch = async href => {
    calls.push(href.pathname);
    return href.pathname.endsWith("/manifest.json") ? Response.json(manifest) : new Response(gzipSync("[]"));
  };
  const hex = id => id.toString(16).padStart(2, "0");
  const run = async (names, name) => {
    const files = imports(undefined, url, names);
    const h = nameHash(name), shard = hex(h & 255);
    for (let pass = 0; pass < 2; pass++) {
      assert.equal(JSON.parse(files.copy(await files.fetch("manifest.json", 4096))).snapshot, snapshot);
      assert.equal(files.copy(await files.fetch(snapshot + "/" + shard + ".json", 65536)), "[]");
    }
    return { shard, part: hex((h >>> 8) & 15) };
  };
  const {shard,part} = await run(["São Paulo", "São Paulo"], "São Paulo");
  assert.deepEqual(calls, ["/snapshot.gol.areas/manifest.json", "/snapshot.gol.areas/" + directory + "/p4/" + shard + "/" + part + ".json.gz"]);
  calls.length = 0;
  assert.equal(nameHash("Monaco") & 255, nameHash("Parc Disneyland") & 255);
  const joined = await run(["Monaco", "Parc Disneyland"], "Monaco");
  assert.deepEqual(calls, ["/snapshot.gol.areas/manifest.json", "/snapshot.gol.areas/" + directory + "/" + joined.shard + ".json.gz"]);
  calls.length = 0;
  globalThis.fetch = async href => {
    calls.push(href.pathname);
    if (href.pathname.endsWith("/manifest.json")) return Response.json(manifest);
    if (href.pathname.includes("/p4/")) return new Response(null, {status:404});
    return new Response(gzipSync("[]"));
  };
  await run(["São Paulo"], "São Paulo");
  assert.deepEqual(calls, ["/snapshot.gol.areas/manifest.json",
    "/snapshot.gol.areas/" + directory + "/p4/" + shard + "/" + part + ".json.gz",
    "/snapshot.gol.areas/" + directory + "/" + shard + ".json.gz"]);
});
