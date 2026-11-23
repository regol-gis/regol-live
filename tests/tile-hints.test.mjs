import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localETag } from "../scripts/datasets.mjs";
import { createTileHints } from "../scripts/tile-hints.mjs";

const sample = new URL("../web/data/monaco-2026-01-01.gol", import.meta.url);
const monaco = "7.4,43.72,7.45,43.76";

async function query(handler, bbox) {
  const response = {
    setHeader() {},
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(body) {
      if (body) this.data = JSON.parse(body);
    },
  };
  await handler(
    { method: "GET", url: "/datasets/uk-tiles.json?bbox=" + bbox },
    response,
  );
  return response;
}

test("tile hints carry the GOL validator and exact header and tile extents", async () => {
  const handler = createTileHints(sample);
  const [r, again] = await Promise.all([
    query(handler, monaco),
    query(handler, monaco),
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(again.data, r.data);
  const { etag, metadataEnd, directory, tiles } = r.data;
  assert.equal(etag, localETag(await stat(sample, { bigint: true })));
  const bytes = await readFile(sample);
  assert.equal(metadataEnd, 4096 + bytes.readUInt32LE(20));
  assert.equal(
    directory[1],
    directory[0] + 4 + bytes.readUInt32LE(directory[0]),
  );
  assert.deepEqual(
    tiles.map((tile) => tile.zoom),
    [0, 2, 4, 6, 8, 10, 12],
  );
  for (const { start, end } of tiles) {
    assert.equal(end, start + 4 + (bytes.readUInt32LE(start) & 0x3fff_ffff));
  }
  const away = await query(handler, "-100,20,-99,21");
  assert.equal(away.status, 200);
  assert(away.data.tiles.length < tiles.length);
  for (const bounds of [
    "",
    "a,0,1,2",
    "1,2,0,3",
    "0,-91,1,2",
    "-180,-90,180,90",
  ]) {
    assert.equal((await query(handler, bounds)).status, 204);
  }
});

test("replacing a GOL invalidates cached hints and malformed catalogs fall back", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "regol-hints-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "sample.gol");
  const bytes = await readFile(sample);
  await writeFile(path, bytes);
  const handler = createTileHints(path);
  const original = await query(handler, monaco);
  await writeFile(join(dir, "replacement"), bytes);
  await rename(join(dir, "replacement"), path);
  const replaced = await query(handler, monaco);
  assert.equal(replaced.status, 200);
  assert.notEqual(original.data.etag, replaced.data.etag);
  const bad = await open(path, "r+");
  try {
    await bad.write(Buffer.alloc(4, 0xff), 0, 4, replaced.data.directory[0]);
  } finally {
    await bad.close();
  }
  assert.equal((await query(handler, monaco)).status, 204);
});

test("directory offsets above 4 GiB and the highest bit of an 8×8 child mask", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "regol-hints-large-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "sparse.gol");
  const base = 2 ** 32;
  const file = await open(path, "wx");
  try {
    const header = Buffer.alloc(256);
    header.writeUInt32LE(0x1ce50d6e, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(1 | (1 << 3), 96);
    header.writeUInt32LE(base / 4096, 128 + 24);
    await file.write(header, 0, header.length, 0);
    const tile = Buffer.alloc(4);
    tile.writeUInt32LE(28);
    for (const start of [4096, 8192]) await file.write(tile, 0, 4, start);
    const catalog = Buffer.alloc(20);
    catalog.writeUInt32LE(16, 0);
    catalog.writeUInt32LE(1 * 4 + 2, 4);
    catalog.writeBigUInt64LE(1n << 63n, 8);
    catalog.writeUInt32LE(2 * 4 + 2, 16);
    await file.write(catalog, 0, catalog.length, base);
  } finally {
    await file.close();
  }
  const r = await query(createTileHints(path), "160,-83,161,-82");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.directory, [base, base + 20]);
  assert.deepEqual(r.data.tiles, [
    { start: 4096, end: 4128, zoom: 0 },
    { start: 8192, end: 8224, zoom: 3 },
  ]);
});
