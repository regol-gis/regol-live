import { RangeCache } from "./range-cache.js";
import { isPlanetFile, utcDate } from "./planet-files.js";
export { planetURL } from "./planet-files.js";

export const pageBytes = 128 * 1024;
export const transferAllowance = (localFile) =>
  (localFile ? 256 : 128) * 1024 * 1024;
const options = {
  credentials: "omit",
  cache: "no-store",
  referrerPolicy: "no-referrer",
};

async function reject(response, message) {
  await response.body?.cancel();
  throw new Error(message);
}

function readSignal(signal, timeoutMs = 30000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchByteRange(url, start, end, signal, timeoutMs) {
  const response = await fetch(url, {
    ...options,
    headers: { Range: `bytes=${start}-${end}` },
    signal: readSignal(signal, timeoutMs),
  });
  if (response.status !== 206) {
    await reject(
      response,
      `The dataset returned HTTP ${response.status}. It must support byte ranges (206).`,
    );
  }
  const encoding = response.headers.get("Content-Encoding");
  if (encoding && encoding !== "identity")
    await reject(response, "The dataset must be served uncompressed.");
  return response;
}

export async function readBody(response, length) {
  const advertised = response.headers.get("Content-Length");
  if (advertised !== null && Number(advertised) !== length)
    await reject(response, "Incorrect range length.");
  const data = new Uint8Array(length);
  const reader = response.body.getReader();
  let used = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (used + value.length > length) {
        await reader.cancel();
        throw new Error("The range body exceeds the requested size.");
      }
      data.set(value, used);
      used += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (used !== length) throw new Error("The range body ended early.");
  return data;
}

export class RangeFile {
  activeReads = 0;

  constructor(
    url,
    progress,
    cacheHit = () => {},
    measureStorage = (_, run) => run(),
  ) {
    this.url = url;
    this.progress = progress;
    this.cacheHit = cacheHit;
    this.measureStorage = measureStorage;
  }
  async open(expectedDate, prefetchPlanetHeader = false) {
    await this.beforeNetwork?.();
    const start = performance.now();
    let response;
    if (isPlanetFile(this.url, "gol")) {
      const controller = new AbortController();
      const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
      const head = fetch(this.url, { ...options, method: "HEAD", signal: readSignal(signal) }).then(value => {
        if (!value.ok) throw Error("The planet snapshot is unavailable.");
        return value;
      });
      const firstStart = performance.now();
      const first = prefetchPlanetHeader
        ? fetchByteRange(this.url, 0, pageBytes - 1, signal).then(value => ({
            response: value, headersAt: performance.now(),
          }))
        : null;
      let prefix;
      try {
        [response, prefix] = await Promise.all([head, first]);
      } catch (error) {
        controller.abort(error);
        await Promise.allSettled([head, first]);
        throw error;
      }
      this.size = Number(response.headers.get("Content-Length"));
      this.modified = response.headers.get("Last-Modified");
      if (expectedDate && utcDate(this.modified) !== expectedDate) {
        controller.abort();
        throw Error("The planet GOL has changed since the date was selected. Reload to select the current dataset.");
      }
      if (!this.modified) {
        controller.abort();
        throw Error("The planet snapshot has no visible modification date.");
      }
      if (prefix) {
        const length = Math.min(this.size, pageBytes);
        const firstHeaders = prefix.response.headers;
        const range = firstHeaders.get("Content-Range");
        const etag = response.headers.get("ETag");
        if (!Number.isSafeInteger(this.size) || this.size <= 0 ||
            (range !== null && range !== `bytes 0-${length - 1}/${this.size}`) ||
            (etag && firstHeaders.get("ETag") !== etag) ||
            firstHeaders.get("Last-Modified") !== this.modified) {
          this.invalidated = true;
          await reject(prefix.response, "The dataset changed. Run the query again to reopen it.");
        }
        this.first = await readBody(prefix.response, length);
        this.firstTiming = this.timing(firstStart, prefix.headersAt, prefix.response);
        this.firstCanStore = !/\bno-store\b/i.test(firstHeaders.get("Cache-Control") || "");
      }
    } else {
      response = await fetchByteRange(this.url, 0, pageBytes - 1, this.signal);
      const header = response.headers.get("Content-Range") || "";
      const parsed = /^bytes 0-(\d+)\/(\d+)$/.exec(header);
      if (
        !parsed ||
        Number(parsed[1]) !== Math.min(Number(parsed[2]), pageBytes) - 1
      ) {
        await reject(
          response,
          "The GOL host must expose a valid Content-Range header.",
        );
      }
      this.size = Number(parsed[2]);
    }
    if (!Number.isSafeInteger(this.size) || this.size <= 0)
      await reject(response, "Invalid dataset size.");
    this.etag = response.headers.get("ETag");
    this.modified = response.headers.get("Last-Modified");
    if (!isPlanetFile(this.url, "gol")) {
      const headersAt = performance.now();
      this.first = await readBody(response, Math.min(this.size, pageBytes));
      this.firstTiming = this.timing(start, headersAt, response);
    }
    if (
      this.firstCanStore !== false && /^"[^"]*"$/.test(this.etag) &&
      !/\bno-store\b/i.test(response.headers.get("Cache-Control") || "")
    ) {
      this.cache = await this.measureStorage("read", () =>
        RangeCache.open(
          JSON.stringify([this.url, this.size, this.etag, this.modified]),
          this.size,
        ),
      );
    }
  }
  async primePlanetMetadata(ahead, remaining) {
    if (!this.first || this.first.length < 256 || this.cache?.known.size) return;
    const header = new DataView(this.first.buffer, this.first.byteOffset, this.first.byteLength);
    const active = header.getUint8(16);
    if (header.getUint32(0, true) !== 0x1ce50d6e || header.getUint32(4, true) !== 2 ||
        active > 1) return;

    // The header locates the metadata and the active snapshot directory.
    // Bound both prefetches and leave full decoding to the checked reader.
    const unitLimit = 1024 * 1024;
    const index = header.getUint32(128 + active * 64 + 24, true) * 4096;
    const metadataEnd = 4096 + header.getUint32(20, true);
    if (metadataEnd > index || index < 4096 || index > this.size - 4) return;
    const initial = Math.ceil(metadataEnd / pageBytes) * pageBytes;
    const indexStart = Math.floor(index / pageBytes) * pageBytes;
    const words = header.getUint32(108, true);
    const directoryEnd = index + 4 + words * 4;
    const alignedEnd = Math.min(this.size, Math.ceil(directoryEnd / pageBytes) * pageBytes);
    const indexEnd = words && directoryEnd <= this.size && alignedEnd - indexStart <= unitLimit
      ? alignedEnd : Math.min(this.size, indexStart + pageBytes);
    const ranges = [];
    if (initial > pageBytes && initial <= Math.min(unitLimit, indexStart))
      ranges.push([pageBytes, initial]);
    if (indexStart >= pageBytes) ranges.push([indexStart, indexEnd]);
    if (this.first.length + ranges.reduce((bytes, [start, end]) => bytes + end - start, 0) > remaining)
      return;

    const reads = await Promise.allSettled(ranges.map(async ([start, end]) => {
      ahead.remember(start, await this.read(start, end - start));
    }));
    const failed = reads.find(read => read.status === "rejected");
    if (failed && (this.invalidated || this.signal?.aborted)) throw failed.reason;
  }

  async cached(start, length) {
    if (!this.cache || (start === 0 && this.first)) return null;
    const data = await this.measureStorage("read", () =>
      this.cache.get(start, length),
    );
    if (data) this.cacheHit(length);
    return data;
  }
  async persist(start, data) {
    if (this.cache)
      await this.measureStorage("write", () => this.cache.put(start, data));
  }
  timing(start, headersAt, response) {
    const disk = /^gol;dur=([\d.]+)$/.exec(
      response.headers.get("Server-Timing") || "",
    );
    const stamp = response.headers.get("X-GOL-Handler-Start");
    return {
      start,
      headersAt,
      handlerAt: stamp === null ? null : Number(stamp) - performance.timeOrigin,
      end: performance.now(),
      disk: disk ? Number(disk[1]) : null,
    };
  }
  async read(start, length) {
    return (await this.cached(start, length)) ?? this.fetchRange(start, length);
  }
  async fetchRange(start, length) {
    if (start === 0 && this.first) {
      const data = this.first;
      this.first = null;
      if (data.length !== length) throw new Error("Unexpected page size.");
      this.progress(data.length, this.firstTiming);
      if (this.firstCanStore !== false) await this.persist(start, data);
      return data;
    }
    await this.beforeNetwork?.();
    const began = performance.now();
    const end = start + length - 1;
    const concurrentReads = ++this.activeReads;
    let response, headersAt, data;
    try {
      response = await fetchByteRange(this.url, start, end, this.signal);
      headersAt = performance.now();
      const range = response.headers.get("Content-Range");
      if (
        (!isPlanetFile(this.url, "gol") || range !== null) &&
        range !== `bytes ${start}-${end}/${this.size}`
      ) {
        this.invalidated = true;
        await reject(
          response,
          "The server returned a different range or dataset size.",
        );
      }
      if (
        (this.etag && response.headers.get("ETag") !== this.etag) ||
        (this.modified && response.headers.get("Last-Modified") !== this.modified)
      ) {
        this.invalidated = true;
        await reject(
          response,
          "The dataset changed. Run the query again to reopen it.",
        );
      }
      data = await readBody(response, length);
    } finally {
      this.activeReads--;
    }
    const timing = this.timing(began, headersAt, response);
    timing.concurrentReads = concurrentReads;
    this.progress(data.length, timing);
    if (!/\bno-store\b/i.test(response.headers.get("Cache-Control") || ""))
      await this.persist(start, data);
    return data;
  }
}

export function summarizeReadTimings(timings) {
  let busy = 0,
    gap = 0,
    disk = 0,
    measured = 0,
    peak = 0;
  let lastEnd = null,
    longestRead = null,
    activeEnds = [];
  for (const read of [...timings].sort((a, b) => a.start - b.start)) {
    activeEnds = activeEnds.filter((end) => end > read.start);
    activeEnds.push(read.end);
    peak = Math.max(peak, activeEnds.length);
    if (lastEnd !== null)
      gap = Math.max(gap, read.start - lastEnd - (read.pausedBefore || 0));
    busy += Math.max(0, read.end - Math.max(read.start, lastEnd ?? read.start));
    lastEnd = Math.max(lastEnd ?? 0, read.end);
    if (
      !longestRead ||
      read.end - read.start > longestRead.end - longestRead.start
    )
      longestRead = read;
    if (read.disk !== null) {
      disk += read.disk;
      measured++;
    }
  }
  const headerWait = longestRead
    ? longestRead.headersAt - longestRead.start
    : 0;
  let split = null;
  if (longestRead?.handlerAt != null && longestRead.disk !== null) {
    // Both ends of the local launcher use the same machine clock. Omit
    // inconsistent estimates (e.g. a remote server or reduced timer precision).
    const before = longestRead.handlerAt - longestRead.start;
    const after = headerWait - before - longestRead.disk;
    if (before >= -2 && after >= -2)
      split = { before: Math.max(0, before), after: Math.max(0, after) };
  }
  return {
    busy,
    gap,
    peak,
    split,
    longest: longestRead ? longestRead.end - longestRead.start : 0,
    headerWait,
    disk: measured ? disk : null,
  };
}
