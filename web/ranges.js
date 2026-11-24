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
  async open(expectedDate) {
    await this.beforeNetwork?.();
    const start = performance.now();
    let response;
    if (isPlanetFile(this.url, "gol")) {
      response = await fetch(this.url, {
        ...options,
        method: "HEAD",
        signal: readSignal(this.signal),
      });
      if (!response.ok) throw new Error("The planet snapshot is unavailable.");
      this.size = Number(response.headers.get("Content-Length"));
      this.modified = response.headers.get("Last-Modified");
      if (expectedDate && utcDate(this.modified) !== expectedDate)
        throw Error("The planet GOL has changed since the date was selected. Reload to select the current dataset.");
      if (!this.modified)
        throw new Error(
          "The planet snapshot has no visible modification date.",
        );
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
      /^"[^"]*"$/.test(this.etag) &&
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
      await this.persist(start, data);
      return data;
    }
    await this.beforeNetwork?.();
    const began = performance.now();
    const end = start + length - 1;
    const response = await fetchByteRange(this.url, start, end, this.signal);
    const headersAt = performance.now();
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
    const data = await readBody(response, length);
    this.progress(data.length, this.timing(began, headersAt, response));
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
