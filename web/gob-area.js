import { engineJSON } from "./result-json.js";
import { maxAreaBytes } from "./area-download.js";
import { GobTileCache, sha256 } from "./gob-tile-cache.js";
import { TileCountLimit } from "./tile-catalog.js";
import { fetchByteRange, readBody } from "./ranges.js";
import { planetGobURL, utcDate } from "./planet-files.js";
export { planetGobURL } from "./planet-files.js";

const headerLength = 64;
const maxPrefixBytes = 4 * 1024 * 1024;
const maxTiles = 256;
const maxRangeBytes = 4 * 1024 * 1024;
const maxConcurrentRanges = 8;
const maxQueryDependencies = 64;
const prefixCacheName = "regol-gob-prefix-length-v1";

export const planetSnapshot = (tileset, revision) =>
  JSON.stringify(["planet", tileset, revision]);

export function golPlanetSnapshot(header) {
  if (header.length < 196) return null;
  const bytes = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const active = bytes.getUint8(16);
  const tileset = header.subarray(64, 80);
  if (bytes.getUint32(0, true) !== 0x1ce50d6e ||
      bytes.getUint32(4, true) !== 2 || active > 1 || !tileset.some(Boolean)) return null;
  return planetSnapshot(
    Array.from(tileset, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    bytes.getUint32(128 + 64 * active, true),
  );
}

export class GobQueryError extends Error {}

class DecodedLimit extends GobQueryError {}

function readOutput(api, length, ErrorType = Error, forDisplay = false) {
  const value = engineJSON(api, length, forDisplay);
  if (value.decodedLimit) throw new DecodedLimit(value.error);
  if (value.error) throw new ErrorType(value.error);
  return value;
}

function writeInput(api, allocate, bytes) {
  const ptr = allocate(bytes.length) >>> 0;
  if (!ptr) throw Error("The query or tile is too large for the browser.");
  new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
}

function openPrefix(api, prefix) {
  writeInput(api, api.gob_input_buffer, prefix);
  return readOutput(api, api.gob_open());
}

function importTile(api, tip, bytes) {
  writeInput(api, api.gob_input_buffer, bytes);
  const error = api.gob_import(tip);
  if (error) readOutput(api, error);
}

function coalesce(entries, gap = 0) {
  const ranges = [];
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    const tail = ranges.at(-1);
    const end = entry.offset + entry.length;
    if (tail && tail.offset + tail.length + gap >= entry.offset &&
        end - tail.offset <= maxRangeBytes) {
      tail.length = end - tail.offset;
      tail.entries.push(entry);
    } else {
      ranges.push({ offset: entry.offset, length: entry.length, entries: [entry] });
    }
  }
  return ranges;
}

async function prefixHint(url, date) {
  if (!date) return {};
  try {
    const cache = await globalThis.caches?.open(prefixCacheName);
    const stored = await cache?.match(url);
    const length = Number(stored?.headers.get("X-Regol-Prefix-Length"));
    return {
      cache,
      length: stored?.headers.get("X-Regol-Snapshot-Date") === date &&
        Number.isSafeInteger(length) && length >= 68 && length <= maxPrefixBytes
        ? length : undefined,
    };
  } catch {
    return {};
  }
}

export class GobArea {
  chunks = new Map();
  chunkBytes = 0;
  cacheAllowed = true;

  static async open(engine, progress, signal, url = planetGobURL, expectedDate) {
    const hints = await prefixHint(url, expectedDate);
    signal.throwIfAborted();
    let area = new GobArea(engine, progress, url);
    let initial;
    if (hints.length) {
      try {
        initial = await area.read(0, hints.length, signal, 10000);
      } catch {
        signal.throwIfAborted();
        // A rolling archive can shrink or reject a previously valid range.
        area = new GobArea(engine, progress, url);
      }
    }
    initial ??= await area.read(0, headerLength, signal, 10000);
    if (expectedDate && utcDate(area.validator.modified) !== expectedDate)
      throw Error("The planet GOB has changed since the date was selected.");
    const view = new DataView(initial.buffer, initial.byteOffset, initial.byteLength);
    const prefixLength = 68 + 8 * view.getUint32(28, true) + view.getUint32(48, true);
    if (view.getUint32(0, true) !== 0xe0f6b060 || view.getUint32(4, true) !== 2 ||
        prefixLength > maxPrefixBytes)
      throw Error("The planet GOB catalog is unavailable or unsupported.");
    const prefix = initial.length >= prefixLength
      ? initial.subarray(0, prefixLength) : new Uint8Array(prefixLength);
    const [rest, engineResult] = await Promise.allSettled([
      initial.length < prefixLength && area.read(initial.length, prefixLength - initial.length, signal, 10000),
      engine(),
    ]);
    signal.throwIfAborted();
    if (rest.status === "rejected") throw rest.reason;
    if (engineResult.status === "rejected") throw engineResult.reason;
    const api = engineResult.value;
    if (rest.value) {
      prefix.set(initial);
      prefix.set(rest.value, initial.length);
    }
    const { tileset, revision, size } = openPrefix(api, prefix);
    if (!Number.isSafeInteger(size) || size < prefixLength ||
        (area.size !== undefined && area.size !== size))
      throw Error("The planet GOB catalog has an invalid file size.");
    area.size = size;
    area.prefix = prefix;
    area.api = api;
    area.snapshot = planetSnapshot(tileset, revision);
    if (area.cacheAllowed && globalThis.crypto?.subtle) {
      const { etag, modified } = area.validator;
      const strong = /^"[^"]+"$/.test(etag);
      if (strong || utcDate(modified)) {
        try {
          const identity = JSON.stringify([url, size, etag, modified, area.snapshot, await sha256(prefix)]);
          area.tileCache = await GobTileCache.open(identity);
          area.verifyStored = !strong;
        } catch {
          // A failed optional cache must not affect the normal opening path.
        }
      }
    }
    if (hints.cache && hints.length !== prefixLength) {
      try {
        await hints.cache.put(url, new Response(null, { headers: {
          "X-Regol-Prefix-Length": String(prefixLength), "X-Regol-Snapshot-Date": expectedDate,
        } }));
      } catch {
        // Storage is optional. Every open still validates the live archive.
      }
    }
    signal.throwIfAborted();
    return area;
  }

  constructor(engine, progress, url) {
    this.url = url;
    this.engine = engine;
    this.progress = progress;
  }

  matchesArchive(other) {
    return this.size === other.size && this.validator.etag === other.validator.etag &&
      this.validator.modified === other.validator.modified && this.prefix.length === other.prefix.length &&
      this.prefix.every((byte, i) => byte === other.prefix[i]);
  }

  async read(offset, length, signal, timeout) {
    const start = performance.now();
    const end = offset + length - 1;
    const response = await fetchByteRange(this.url, offset, end, signal, timeout);
    const headersAt = performance.now();
    if (/\bno-store\b/i.test(response.headers.get("Cache-Control") || "")) this.cacheAllowed = false;
    const etag = response.headers.get("ETag");
    const modified = response.headers.get("Last-Modified");
    const range = response.headers.get("Content-Range");
    // The public host exposes Last-Modified across origins. Validate the
    // full byte range and stronger validator where the browser exposes them.
    const rangeParts = range?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const size = Number(rangeParts?.[3]);
    const validRange = range === null || (
      Number(rangeParts?.[1]) === offset && Number(rangeParts?.[2]) === end &&
      Number.isSafeInteger(size) && size > end && size === (this.size ?? size)
    );
    const changed = this.validator &&
      (this.validator.etag !== etag || this.validator.modified !== modified);
    if ((!modified && !/^"[^"]*"$/.test(etag)) || changed || !validRange) {
      this.invalidated = true;
      await response.body?.cancel();
      throw Error("The planet GOB snapshot changed or returned an invalid range.");
    }
    this.validator ??= { etag, modified };
    if (rangeParts) this.size = size;
    const bytes = await readBody(response, length);
    this.progress(length, {
      start, headersAt, end: performance.now(), disk: null, handlerAt: null,
    });
    return bytes;
  }

  plan(windows) {
    const entries = new Map();
    for (const window of windows) {
      const { tiles, tileLimit } = readOutput(this.api, this.api.gob_plan(...window));
      if (tileLimit) throw new TileCountLimit(tileLimit);
      for (const tile of tiles) entries.set(tile.tip, tile);
      if (entries.size > maxTiles) throw new TileCountLimit(maxTiles);
    }
    return [...entries.values()];
  }

  estimate(entries, cached) {
    let missing = 0;
    let total = 0;
    let retainedBytes = 0;
    const hints = !this.invalidated && this.cacheAllowed ? this.tileCache : undefined;
    for (const { tip, length } of entries) {
      total += length;
      if (this.chunks.has(tip) || cached?.has(tip)) continue;
      missing += length;
      if (cached) hints?.forgetHint(tip);
      else if (hints?.hasHint(tip, length)) retainedBytes += length;
    }
    if (total > maxAreaBytes)
      return { tiles: entries.length, total, missing: null, limitBytes: maxAreaBytes };
    return { tiles: entries.length, missing, total, ...(retainedBytes && { retainedBytes }) };
  }

  async prepare(entries, signal) {
    if (!this.tileCache || !this.cacheAllowed) return;
    const unknown = entries.filter(({ tip }) => !this.chunks.has(tip));
    if (!unknown.length) return;
    const cached = await this.tileCache.read(unknown, signal);
    if (this.verifyStored && cached.size) {
      const ranges = coalesce(unknown.filter(({ tip }) => cached.has(tip))
        .map(entry => ({ ...entry, length: 8 })), 4096);
      try {
        await this.visitRanges(ranges, signal, async (range, readSignal) => {
          const bytes = await this.read(range.offset, range.length, readSignal);
          for (const entry of range.entries) {
            const offset = entry.offset - range.offset;
            if (!bytes.subarray(offset, offset + 8).every((byte, i) => byte === cached.get(entry.tip)[i]))
              cached.delete(entry.tip);
          }
        });
      } catch (error) {
        signal.throwIfAborted();
        if (this.invalidated) throw error;
        cached.clear();
      }
    }
    if (!this.cacheAllowed) cached.clear();
    return cached;
  }

  async visitRanges(ranges, signal, visit) {
    const reads = new AbortController();
    const readSignal = AbortSignal.any([signal, reads.signal]);
    let next = 0;
    let failure;
    const run = async () => {
      while (!readSignal.aborted && next < ranges.length) {
        try {
          await visit(ranges[next++], readSignal);
        } catch (error) {
          failure ??= error;
          reads.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ranges.length, maxConcurrentRanges) }, run));
    signal.throwIfAborted();
    if (failure) throw failure;
  }

  async download(entries, signal, cached) {
    const estimate = this.estimate(entries, cached);
    if (estimate.limitBytes) throw Error("Select a smaller area before downloading.");
    if (this.active && entries.every(({ tip }) => this.chunks.has(tip))) return this;
    const chunks = new Map();
    const missing = [];
    for (const entry of entries) {
      const previous = this.chunks.get(entry.tip) ?? cached?.get(entry.tip);
      if (previous) chunks.set(entry.tip, previous);
      else missing.push(entry);
    }
    // Stage both the network reads and imports. Cancellation and failed
    // transfers leave the engine used by the last completed download intact.
    const ordinal = new Map(entries.map(({ tip }, index) => [tip, index]));
    const rank = range => Math.min(...range.entries.map(entry => ordinal.get(entry.tip)));
    const ranges = coalesce(missing).sort((a, b) => rank(a) - rank(b));
    const tickets = new Map(missing.map(({ tip }) => [tip, Promise.withResolvers()]));
    const stop = new AbortController();
    const requestSignal = AbortSignal.any([signal, stop.signal]);
    let fetchFailure;
    const fetched = this.visitRanges(ranges, requestSignal, async (range, readSignal) => {
      const bytes = await this.read(range.offset, range.length, readSignal);
      for (const entry of range.entries) {
        const start = entry.offset - range.offset;
        chunks.set(entry.tip, range.entries.length === 1 ? bytes : bytes.slice(start, start + entry.length));
        tickets.get(entry.tip).resolve();
      }
    }).catch(error => {
      fetchFailure = error;
      for (const ticket of tickets.values()) ticket.resolve();
    });
    const candidate = new GobArea(this.engine, this.progress, this.url);
    const lazy = Boolean(cached?.size && !missing.length);
    const imported = [];
    let api;
    try {
      api = await this.engine();
      signal.throwIfAborted();
      openPrefix(api, this.prefix);
      for (const { tip } of lazy ? [] : entries) {
        if (!chunks.has(tip)) {
          await tickets.get(tip).promise;
        }
        signal.throwIfAborted();
        if (fetchFailure) throw fetchFailure;
        try {
          const bytes = chunks.get(tip);
          importTile(api, tip, bytes);
          if (tickets.has(tip)) imported.push([tip, bytes]);
        } catch (error) {
          if (!(error instanceof DecodedLimit)) throw error;
          // Finish collecting the compressed tiles. Queries can rebuild just
          // the decoded working set they need from the validated archive.
          break;
        }
        // Let the worker process cancel-area and completed reads between tiles.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await fetched;
      signal.throwIfAborted();
      if (fetchFailure) throw fetchFailure;
    } finally {
      stop.abort();
      await fetched;
    }
    if (this.tileCache && this.cacheAllowed && imported.length) {
      await this.tileCache.put(imported, signal);
      signal.throwIfAborted();
    }
    Object.assign(candidate, {
      api, prefix: this.prefix, size: this.size, snapshot: this.snapshot, validator: this.validator,
      tileCache: this.tileCache, cacheAllowed: this.cacheAllowed, verifyStored: this.verifyStored,
      lazy,
      chunks, chunkBytes: entries.reduce((sum, { length }) => sum + length, 0), active: true,
    });
    return candidate;
  }

  async preload(entries, signal) {
    if (!this.lazy) return;
    for (const { tip, loaded } of entries) {
      if (loaded) continue;
      signal.throwIfAborted();
      try {
        importTile(this.api, tip, this.chunks.get(tip));
      } catch (error) {
        if (error instanceof DecodedLimit) break;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  async query(request, remaining, signal, forDisplay = false) {
    const fetched = new Set();
    const attempted = new Set();
    let rebuilt = false;
    let engineMs = 0;
    for (;;) {
      writeInput(this.api, this.api.input_buffer, request);
      const start = performance.now();
      const resultBytes = await this.api.gob_query();
      engineMs += performance.now() - start;
      signal?.throwIfAborted();
      const value = readOutput(this.api, resultBytes, GobQueryError, forDisplay);
      if (value.missingTile === undefined) return { value, resultBytes, engineMs };
      const tip = value.missingTile;
      if (attempted.has(tip)) throw Error("The query could not load a required planet tile.");
      attempted.add(tip);
      let bytes = this.chunks.get(tip);
      if (!bytes) {
        const { length, offset } = readOutput(this.api, this.api.gob_entry(tip));
        if (fetched.size >= maxQueryDependencies || length > remaining() || this.chunkBytes + length > maxAreaBytes)
          throw Error("The query needs more planet tiles than the browser can load.");
        bytes = await this.read(offset, length, signal);
        fetched.add(tip);
        this.chunks.set(tip, bytes);
        this.chunkBytes += length;
      }
      try {
        importTile(this.api, tip, bytes);
      } catch (error) {
        if (!(error instanceof DecodedLimit)) {
          this.chunks.delete(tip);
          this.chunkBytes -= bytes.length;
          throw error;
        }
        if (rebuilt) throw error;
        // Drop decoded tiles from other views. Replaying this query can now
        // use its own working set, including dependencies fetched above.
        signal?.throwIfAborted();
        openPrefix(this.api, this.prefix);
        attempted.clear();
        rebuilt = true;
      }
    }
  }
}
