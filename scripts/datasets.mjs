import { open } from "node:fs/promises";
import { planetURL, readBody } from "../web/ranges.js";

const maxRange = 8 * 1024 * 1024;
const visibleHeaders =
  "Accept-Ranges, Content-Range, Content-Length, Content-Encoding, ETag, Last-Modified, Server-Timing, X-GOL-Handler-Start";

export function parseRange(value) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value || "");
  if (!match) return null;
  const first = Number(match[1]),
    last = Number(match[2]);
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    last < first ||
    last - first >= maxRange
  )
    return null;
  return { first, last };
}

function hasSnapshot(req, etag, modified) {
  const match = req.headers["if-match"];
  if (match)
    return (
      match === "*" ||
      (etag &&
        !etag.startsWith("W/") &&
        match.split(",").some((value) => value.trim() === etag))
    );
  const since = Date.parse(req.headers["if-unmodified-since"]);
  return !Number.isFinite(since) || !modified || Date.parse(modified) <= since;
}

export function localETag(stat) {
  return `"${stat.dev}-${stat.ino}-${stat.size}-${stat.mtimeNs}"`;
}

async function localFile(req, res, path, range) {
  const start = performance.now();
  const file = await open(path, "r");
  try {
    const stat = await file.stat({ bigint: true });
    const size = Number(stat.size);
    const etag = localETag(stat);
    const modified = stat.mtime.toUTCString();
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", modified);
    if (!hasSnapshot(req, etag, modified)) return res.writeHead(412).end();
    if (req.method === "HEAD")
      return res.writeHead(200, { "Content-Length": size }).end();
    if (range.first >= size)
      return res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    const end = Math.min(range.last, size - 1);
    const length = end - range.first + 1;
    const bytes = Buffer.allocUnsafe(length);
    let n = 0;
    while (n < length) {
      const { bytesRead } = await file.read(
        bytes,
        n,
        length - n,
        range.first + n,
      );
      if (!bytesRead) throw Error("Local GOL changed during the read.");
      n += bytesRead;
    }
    if ((await file.stat({ bigint: true })).mtimeNs !== stat.mtimeNs)
      throw Error("Local GOL changed during the read.");
    res
      .writeHead(206, {
        "X-GOL-Handler-Start": (performance.timeOrigin + start).toFixed(2),
        "Server-Timing": "gol;dur=" + (performance.now() - start).toFixed(2),
        "Content-Length": length,
        "Content-Range": `bytes ${range.first}-${end}/${size}`,
      })
      .end(bytes);
  } finally {
    await file.close();
  }
}

async function proxyPlanet(req, res, range, fetchOrigin) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    const headers = { "Accept-Encoding": "identity" };
    if (range) headers.Range = `bytes=${range.first}-${range.last}`;
    for (const field of ["if-match", "if-unmodified-since"]) {
      if (req.headers[field]) headers[field] = req.headers[field];
    }
    const upstream = await fetchOrigin(planetURL, {
      method: req.method,
      headers,
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    });
    const header = (name) => upstream.headers.get(name);
    for (const name of ["ETag", "Last-Modified"])
      if (header(name)) res.setHeader(name, header(name));
    if (upstream.status === 416 || upstream.status === 412) {
      if (
        upstream.status === 416 &&
        /^bytes \*\/\d+$/.test(header("Content-Range"))
      )
        res.setHeader("Content-Range", header("Content-Range"));
      await upstream.body?.cancel();
      return res.writeHead(upstream.status).end();
    }
    if (
      upstream.status !== (range ? 206 : 200) ||
      (header("Content-Encoding") && header("Content-Encoding") !== "identity")
    ) {
      await upstream.body?.cancel();
      throw Error(
        "The planet host did not return the requested uncompressed representation.",
      );
    }
    if (!hasSnapshot(req, header("ETag"), header("Last-Modified"))) {
      await upstream.body?.cancel();
      return res.writeHead(412).end();
    }
    if (!range) {
      const total = header("Content-Length");
      if (!/^\d+$/.test(total) || !Number.isSafeInteger(Number(total)))
        throw Error("Missing planet length.");
      return res.writeHead(200, { "Content-Length": total }).end();
    }
    const raw = header("Content-Range");
    const parts = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(raw);
    const total = Number(parts?.[3]);
    if (
      !parts ||
      !Number.isSafeInteger(total) ||
      total <= range.first ||
      Number(parts[1]) !== range.first ||
      Number(parts[2]) !== Math.min(range.last, total - 1)
    ) {
      await upstream.body?.cancel();
      throw Error("The planet host returned an inconsistent Content-Range.");
    }
    const length = Number(parts[2]) - range.first + 1;
    const data = await readBody(upstream, length);
    res
      .writeHead(206, { "Content-Range": raw, "Content-Length": length })
      .end(data);
  } finally {
    res.off("close", abort);
  }
}

export async function serveDataset(
  req,
  res,
  { ukPath, planet },
  fetchOrigin = fetch,
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", visibleHeaders);
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Range, If-Match, If-Unmodified-Since",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method !== "HEAD" && req.method !== "GET")
    return res.writeHead(405, { Allow: "GET, HEAD, OPTIONS" }).end();
  const range = req.method === "GET" ? parseRange(req.headers.range) : null;
  if (req.method === "GET" && !range)
    return res
      .writeHead(400)
      .end("Supply one explicit byte range of at most 8 MiB.");
  res.setHeader("Content-Type", "application/octet-stream");
  try {
    if (planet) await proxyPlanet(req, res, range, fetchOrigin);
    else await localFile(req, res, ukPath, range);
  } catch (error) {
    if (!res.destroyed && !res.headersSent)
      res
        .writeHead(planet ? 502 : 500, { "Content-Type": "text/plain" })
        .end(error.message);
  }
}
