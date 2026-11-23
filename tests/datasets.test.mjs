import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { serveDataset } from "../scripts/datasets.mjs";

async function request(method, headers, options, upstream) {
  const res = Object.assign(new EventEmitter(), {
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code, h = {}) {
      this.status = code;
      for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
      return this;
    },
    end(data) {
      this.body = data;
    },
  });
  await serveDataset({ method, headers }, res, options, upstream);
  return res;
}

test("local GOL serves exact bytes and advertises CORS on partial and error responses", async () => {
  const ukPath = new URL("../web/data/monaco-2026-01-01.gol", import.meta.url);
  const { size } = await stat(ukPath);
  const read = (method, headers = {}) => request(method, headers, { ukPath });
  const head = await read("HEAD");
  assert.equal(head.headers["content-length"], size);
  const res = await read("GET", {
    range: "bytes=0-3",
    "if-match": head.headers.etag,
  });
  assert.equal(res.status, 206);
  assert(Number(res.headers["x-gol-handler-start"]) > 0);
  assert.match(res.headers["server-timing"], /^gol;dur=[\d.]+$/);
  assert.deepEqual([...res.body], [0x6e, 0x0d, 0xe5, 0x1c]);
  assert.equal(res.headers["content-range"], "bytes 0-3/" + size);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.match(
    res.headers["access-control-expose-headers"],
    /Content-Range.*ETag/,
  );
  assert.equal(
    (await read("GET", { range: "bytes=0-3", "if-match": '"stale"' })).status,
    412,
  );
  assert.equal(
    (await read("GET", { range: `bytes=${size}-${size + 3}` })).status,
    416,
  );
  assert.equal((await read("OPTIONS")).status, 204);
});

test("planet proxy forwards one range with its validator and refuses a full-file response", async () => {
  const read = (headers, origin) =>
    request("GET", headers, { planet: true }, origin);
  const res = await read(
    { range: "bytes=4294967296-4294967298", "if-match": '"v1"' },
    async (url, init) => {
      assert.equal(new URL(url).hostname, "download.openplanetdata.com");
      assert.equal(init.headers.Range, "bytes=4294967296-4294967298");
      assert.equal(init.headers["if-match"], '"v1"');
      return new Response(new Uint8Array([3, 2, 1]), {
        status: 206,
        headers: {
          "Content-Range": "bytes 4294967296-4294967298/6000000000",
          ETag: '"v1"',
        },
      });
    },
  );
  assert.equal(res.status, 206);
  assert.deepEqual([...res.body], [3, 2, 1]);
  assert.equal(res.headers.etag, '"v1"');
  assert.equal(
    (await read({ range: "bytes=10-11" }, async () => new Response("full")))
      .status,
    502,
  );
  assert.equal(
    (await read({}, () => assert.fail("unexpected origin request"))).status,
    400,
  );
});
