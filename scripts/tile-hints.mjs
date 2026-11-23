import { open } from "node:fs/promises";
import { readCatalog, tileStarts, tileEnd, projectedBox } from "../web/tile-catalog.js";
import { localETag } from "./datasets.mjs";

const page = 4096;
const maxConcurrent = 4;

function check(condition) {
  if (!condition) throw Error("Tile hints unavailable");
}

async function read(file, offset, length) {
  const bytes = Buffer.alloc(length);
  let n = 0;
  while (n < length) {
    const { bytesRead } = await file.read(bytes, n, length - n, offset + n);
    check(bytesRead > 0);
    n += bytesRead;
  }
  return bytes;
}

// The byte index is shared only between requests for the same file snapshot.
// Header reads are limited to the intersecting tiles. No feature data is decoded.
export function createTileHints(path) {
  let cached;
  let active = 0;
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method !== "GET") return res.writeHead(405, { Allow: "GET" }).end();
    const url = new URL(req.url, "http://localhost");
    const box = projectedBox(url.searchParams.get("bbox"));
    if (!box || active >= maxConcurrent) return res.writeHead(204).end();
    ++active;
    let file;
    try {
      file = await open(path, "r");
      const stat = await file.stat({ bigint: true });
      const etag = localETag(stat);
      const size = Number(stat.size);
      check(Number.isSafeInteger(size) && size >= page);
      if (cached?.etag !== etag)
        cached = {
          etag,
          catalog: readCatalog(
            (offset, length) => read(file, offset, length),
            size,
          ),
        };
      const catalog = await cached.catalog;
      const starts = tileStarts(catalog, box);
      const tiles = await Promise.all(
        Array.from(starts, async ([start, zoom]) => ({
          start, zoom, end: tileEnd(catalog, size, start, await read(file, start, 4)),
        })),
      );
      check(
        tiles.reduce((n, tile) => n + tile.end - tile.start, 0) <=
          512 * 1024 * 1024,
      );
      check(localETag(await file.stat({ bigint: true })) === etag);
      const payload = {
        etag,
        metadataEnd: catalog.metadataEnd,
        directory: catalog.directory,
        tiles,
      };
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(payload));
    } catch {
      // Falling back to ordinary range reads also handles other GOL layouts.
      if (!res.headersSent) res.writeHead(204).end();
    } finally {
      try {
        await file?.close();
      } finally {
        --active;
      }
    }
  };
}
