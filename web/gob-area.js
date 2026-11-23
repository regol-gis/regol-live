import { fetchByteRange, readBody } from "./ranges.js";

export const planetGobURL =
  "https://download.openplanetdata.com/osm/planet/gob/v1/planet-latest.osm.gob";
const headerLength = 64;
const maxPrefixBytes = 4 * 1024 * 1024;
const maxAreaBytes = 128 * 1024 * 1024;
const maxTiles = 256;
const maxRangeBytes = 4 * 1024 * 1024;
const maxConcurrentRanges = 8;
const maxQueryDependencies = 64;
const utf8 = new TextDecoder();

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

function readOutput(api, length, ErrorType = Error) {
  const bytes = new Uint8Array(api.memory.buffer, api.output_ptr(), length);
  const value = JSON.parse(utf8.decode(bytes));
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

function coalesce(entries) {
  const ranges = [];
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    const tail = ranges.at(-1);
    if (tail && tail.offset + tail.length === entry.offset &&
        tail.length + entry.length <= maxRangeBytes) {
      tail.length += entry.length;
      tail.entries.push(entry);
    } else {
      ranges.push({ offset: entry.offset, length: entry.length, entries: [entry] });
    }
  }
  return ranges;
}

export class GobArea {
  chunks = new Map();
  chunkBytes = 0;

  static async open(engine, progress, signal) {
    const area = new GobArea(engine, progress);
    const header = await area.read(0, headerLength, signal, 10000);
    const view = new DataView(header.buffer);
    const prefixLength = 68 + 8 * view.getUint32(28, true) + view.getUint32(48, true);
    if (view.getUint32(0, true) !== 0xe0f6b060 || view.getUint32(4, true) !== 2 ||
        prefixLength > maxPrefixBytes)
      throw Error("The planet GOB catalog is unavailable or unsupported.");
    const prefix = new Uint8Array(prefixLength);
    prefix.set(header);
    const [rest, engineResult] = await Promise.allSettled([
      area.read(headerLength, prefixLength - headerLength, signal, 10000),
      engine(),
    ]);
    signal.throwIfAborted();
    if (rest.status === "rejected") throw rest.reason;
    if (engineResult.status === "rejected") throw engineResult.reason;
    const api = engineResult.value;
    prefix.set(rest.value, headerLength);
    const { tileset, revision, size } = openPrefix(api, prefix);
    if (!Number.isSafeInteger(size) || size < prefixLength ||
        (area.size !== undefined && area.size !== size))
      throw Error("The planet GOB catalog has an invalid file size.");
    area.size = size;
    area.prefix = prefix;
    area.api = api;
    area.snapshot = planetSnapshot(tileset, revision);
    return area;
  }

  constructor(engine, progress) {
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
    const response = await fetchByteRange(planetGobURL, offset, end, signal, timeout);
    const headersAt = performance.now();
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
      const { tiles } = readOutput(this.api, this.api.gob_plan(...window));
      for (const tile of tiles) entries.set(tile.tip, tile);
      if (entries.size > maxTiles) throw Error("Zoom in to download fewer tiles.");
    }
    return [...entries.values()];
  }

  estimate(entries) {
    let missing = 0;
    let total = 0;
    for (const { tip, length } of entries) {
      total += length;
      if (!this.chunks.has(tip)) missing += length;
    }
    if (total > maxAreaBytes)
      throw Error("This area exceeds the 128 MiB download cache. Zoom in to select fewer tiles.");
    return { tiles: entries.length, missing, total };
  }

  async download(entries, signal) {
    if (this.active && entries.every(({ loaded }) => loaded)) return this;
    const chunks = new Map();
    const missing = [];
    for (const entry of entries) {
      const previous = this.chunks.get(entry.tip);
      if (previous) chunks.set(entry.tip, previous);
      else missing.push(entry);
    }
    // Stage both the network reads and imports. Cancellation and failed
    // transfers leave the engine used by the last completed download intact.
    const reads = new AbortController();
    const readSignal = AbortSignal.any([signal, reads.signal]);
    const ranges = coalesce(missing);
    let next = 0;
    let failure;
    const fetchRanges = async () => {
      while (!readSignal.aborted && next < ranges.length) {
        const range = ranges[next++];
        try {
          const bytes = await this.read(range.offset, range.length, readSignal);
          for (const entry of range.entries) {
            const start = entry.offset - range.offset;
            chunks.set(entry.tip, range.entries.length === 1
              ? bytes
              : bytes.slice(start, start + entry.length));
          }
        } catch (error) {
          failure ??= error;
          reads.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ranges.length, maxConcurrentRanges) }, fetchRanges));
    signal.throwIfAborted();
    if (failure) throw failure;
    const candidate = new GobArea(this.engine, this.progress);
    const api = await this.engine();
    signal.throwIfAborted();
    openPrefix(api, this.prefix);
    for (const { tip } of entries) {
      signal.throwIfAborted();
      importTile(api, tip, chunks.get(tip));
      // Let the worker process cancel-area while importing a large viewport.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    Object.assign(candidate, {
      api, prefix: this.prefix, size: this.size, snapshot: this.snapshot, validator: this.validator,
      chunks, chunkBytes: entries.reduce((sum, { length }) => sum + length, 0), active: true,
    });
    return candidate;
  }

  async query(request, remaining, signal) {
    const attempted = new Set();
    let engineMs = 0;
    for (;;) {
      writeInput(this.api, this.api.input_buffer, request);
      const start = performance.now();
      const resultBytes = await this.api.gob_query();
      engineMs += performance.now() - start;
      signal?.throwIfAborted();
      const value = readOutput(this.api, resultBytes, GobQueryError);
      if (value.missingTile === undefined) return { value, resultBytes, engineMs };
      const tip = value.missingTile;
      if (attempted.has(tip) || attempted.size >= maxQueryDependencies)
        throw Error("The query needs too many additional planet tiles.");
      attempted.add(tip);
      const { loaded, offset, length } = readOutput(this.api, this.api.gob_entry(tip));
      if (loaded || length > remaining() || this.chunkBytes + length > maxAreaBytes)
        throw Error("The query needs more planet tiles than the browser can load.");
      const bytes = await this.read(offset, length, signal);
      importTile(this.api, tip, bytes);
      this.chunks.set(tip, bytes);
      this.chunkBytes += length;
    }
  }
}
