// Stream a snapshot in bounded physical ranges. Only derived candidate rows are checkpointed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGzip } from "node:zlib";
import { readCatalog, tileEnd, tileStarts } from "../web/tile-catalog.js";

const page = 4096;
const align = (n) => Math.ceil(n / page) * page;
const batchBytes = 24 * 1024 ** 2;
const maxTileBytes = 256 * 1024 ** 2;

async function openSource(input) {
  if (!/^https?:\/\//.test(input)) {
    const file = await open(input);
    const size = (await file.stat()).size;
    return {
      size,
      close: () => file.close(),
      async read(offset, length) {
        const data = Buffer.allocUnsafe(length);
        let used = 0;
        while (used < length) {
          const { bytesRead } = await file.read(
            data,
            used,
            length - used,
            offset + used,
          );
          if (!bytesRead) throw Error("Short local GOL read");
          used += bytesRead;
        }
        return data;
      },
    };
  }
  const head = await fetch(input, {
    method: "HEAD",
    signal: AbortSignal.timeout(30000),
  });
  const etag = head.headers.get("etag");
  const size = Number(head.headers.get("content-length"));
  if (
    !head.ok ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !/^"[^"\r\n]+"$/.test(etag ?? "")
  )
    throw Error("The planet host must supply its size and a strong ETag");
  const stopped = new AbortController();
  return {
    size,
    close: () => stopped.abort(),
    async read(offset, length) {
      const end = offset + length - 1;
      for (let attempt = 0; ; attempt++) {
        const request = new AbortController();
        try {
          const response = await fetch(input, {
            headers: {
              Range: `bytes=${offset}-${end}`,
              "If-Match": etag,
              "Accept-Encoding": "identity",
            },
            signal: AbortSignal.any([
              stopped.signal,
              request.signal,
              AbortSignal.timeout(180000),
            ]),
          });
          if (
            response.status === 412 ||
            (response.ok && response.headers.get("etag") !== etag)
          ) {
            stopped.abort();
            throw Error("The upstream GOL changed. Start a new snapshot scan.");
          }
          if (
            response.status !== 206 ||
            response.headers.get("content-range") !==
              `bytes ${offset}-${end}/${size}` ||
            Number(response.headers.get("content-length")) !== length ||
            ![null, "identity"].includes(
              response.headers.get("content-encoding"),
            )
          )
            throw Error(
              `Invalid HTTP ${response.status} range for bytes ${offset}-${end}`,
            );
          const data = Buffer.from(await response.arrayBuffer());
          if (data.length !== length) throw Error("Short GOL response");
          return data;
        } catch (error) {
          if (stopped.signal.aborted || attempt === 4) throw error;
          console.error(`Retrying bytes ${offset}-${end}: ${error.message}`);
          await delay(1000 * 2 ** attempt);
        } finally {
          request.abort();
        }
      }
    },
  };
}

function snapshotKey(header, size) {
  // Keep the identity of the original GOL when scanning reduced batches.
  let hash = 0xcbf29ce484222325n;
  for (const byte of header.subarray(0, 256))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `v1-${header.toString("hex", 8, 16)}${header.toString("hex", 64, 80)}-${hash.toString(16).padStart(16, "0")}-${size}`;
}

async function layout(source) {
  const catalog = await readCatalog(source.read, source.size);
  const metadata = await source.read(0, catalog.metadataEnd);
  const tiles = [];
  tileStarts(catalog, [0, 0, 1, 1], Infinity, (offset, entry) =>
    tiles.push({ offset, entry }),
  );
  const active = 128 + 64 * metadata[16];
  if (tiles.length !== metadata.readUInt32LE(active + 28))
    throw Error("Tile count differs from the GOL header");
  tiles.sort((a, b) => a.offset - b.offset);
  // Keep the original tile hierarchy and coordinates for Regol's usual duplicate
  // suppression. An empty R-tree stands in for tiles outside the current batch.
  const directory = align(metadata.length);
  const empty = align(directory + 4 + catalog.bytes.byteLength);
  const template = Buffer.alloc(align(empty + 32));
  metadata.copy(template);
  template.writeUInt32LE(directory / page, active + 24);
  template.writeUInt32LE(catalog.bytes.byteLength, directory);
  Buffer.from(
    catalog.bytes.buffer,
    catalog.bytes.byteOffset,
    catalog.bytes.byteLength,
  ).copy(template, directory + 4);
  template.writeUInt32LE(28, empty);
  const batches = [];
  let batch;
  for (const [i, tile] of tiles.entries()) {
    template.writeUInt32LE((empty / page) * 4 + 2, directory + 4 + tile.entry);
    const next = tiles[i + 1]?.offset ?? source.size;
    tile.end =
      tile.offset < catalog.directory[0]
        ? Math.min(next, catalog.directory[0])
        : next;
    if (tile.end - tile.offset > batchBytes) {
      tile.end = tileEnd(
        catalog,
        source.size,
        tile.offset,
        await source.read(tile.offset, 4),
      );
      if (tile.end - tile.offset > maxTileBytes || tile.end > next)
        throw Error("Oversized or overlapping tile");
    }
    if (
      !batch ||
      tile.end - batch.start > batchBytes ||
      tile.offset - batch.end > page
    ) {
      batch = { start: tile.offset, end: tile.end, tiles: [] };
      batches.push(batch);
    }
    batch.end = tile.end;
    batch.tiles.push(tile);
  }
  return {
    catalog,
    directory,
    template,
    batches,
    snapshot: snapshotKey(metadata, source.size),
  };
}

async function scanBatch(source, plan, batch, scanner, output) {
  const bytes = await source.read(batch.start, batch.end - batch.start);
  const image = Buffer.alloc(plan.template.length + bytes.length + page);
  plan.template.copy(image);
  let used = plan.template.length;
  for (const tile of batch.tiles) {
    const offset = tile.offset - batch.start;
    const end = tileEnd(
      plan.catalog,
      source.size,
      tile.offset,
      bytes.subarray(offset, offset + 4),
    );
    if (end > tile.end) throw Error("Tile overlaps its neighbour");
    image.writeUInt32LE((used / page) * 4 + 2, plan.directory + 4 + tile.entry);
    bytes.copy(image, used, offset, end - batch.start);
    used += align(end - tile.offset);
  }
  image.writeUInt32LE(used / page, 24);
  const temp = `${output}.${randomUUID()}.tmp`;
  try {
    const child = spawn(scanner, ["--planet-candidates"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`Candidate scanner exited ${code}`)),
      );
    });
    await Promise.all([
      exit,
      pipeline([image.subarray(0, used)], child.stdin),
      pipeline(
        child.stdout,
        createGzip({ level: 1 }),
        createWriteStream(temp, { flags: "wx" }),
      ),
    ]);
    await rename(temp, output);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function scanPlanet(input, work, scanner, concurrency = 4) {
  const source = await openSource(input);
  try {
    const plan = await layout(source);
    const directory = join(work, `candidates-v1`, plan.snapshot);
    await mkdir(directory, { recursive: true });
    const existing = new Set(await readdir(directory));
    const filename = (b) => `${b.start}-${b.end}.jsonl.gz`;
    const pending = plan.batches.filter((b) => !existing.has(filename(b)));
    const total = plan.batches.length;
    let done = total - pending.length,
      next = 0,
      lastReport = Date.now();
    console.error(`${plan.snapshot}: ${total} batches, ${done} checkpointed`);
    async function worker() {
      while (next < pending.length) {
        const batch = pending[next++];
        await scanBatch(
          source,
          plan,
          batch,
          scanner,
          join(directory, filename(batch)),
        );
        done++;
        if (Date.now() - lastReport >= 30000 || done === total) {
          console.error(`${new Date().toISOString()} ${done}/${total} batches`);
          lastReport = Date.now();
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (snapshotKey(await source.read(0, 256), source.size) !== plan.snapshot)
      throw Error("GOL changed during scan");
    return {
      snapshot: plan.snapshot,
      files: plan.batches.map((b) => join(directory, filename(b))),
    };
  } finally {
    await source.close();
  }
}
