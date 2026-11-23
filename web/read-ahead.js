import { pageBytes } from "./ranges.js";
import { blockBytes } from "./range-cache.js";

import {
  readCatalog,
  projectedBox,
  tileEnd,
  tileStarts,
  UnsupportedCatalog,
} from "./tile-catalog.js";

const block = 4 * pageBytes; // Align with the largest Wasm cache fill.
const maxBytes = 48 * 1024 * 1024;
const maxGet = 4 * 1024 * 1024;
const maxConcurrentRanges = 8;
const demandWindow = 1024 * 1024;
const demandReserve = 2 * demandWindow;
const peerWindow = demandWindow / 2;
const peerBudget = 8 * demandWindow;

function windowPages(span, position, width, cached) {
  const base = Math.floor(position / width) * width;
  const first = Math.max(base, Math.floor(span.start / pageBytes) * pageBytes);
  const pages = [];
  for (let p = first; p < Math.min(base + width, span.end); p += pageBytes)
    if (!cached.has(p)) pages.push(p);
  return pages;
}

function planPages(hints, size) {
  const pages = new Set();
  function add(first, end) {
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(end) ||
      first < 0 ||
      end <= first ||
      end > size
    )
      return;
    const lo = Math.floor(first / block) * block;
    const hi = Math.min(Math.ceil(end / block) * block, size);
    if (hi - lo > maxBytes) return;
    const extra = [];
    for (let p = lo; p < hi; p += pageBytes) if (!pages.has(p)) extra.push(p);
    if ((pages.size + extra.length) * pageBytes <= maxBytes)
      for (const p of extra) pages.add(p);
  }
  add(0, hints.metadataEnd);
  add(...hints.directory);
  for (const tile of hints.tiles) add(tile.start, tile.start + 24);
  // Small tiles are inexpensive to finish. Larger ones use ordinary demand
  // reads whenever their whole extent would exceed the read-ahead budget.
  for (const tile of hints.tiles.sort(
    (a, b) => a.end - a.start - (b.end - b.start),
  ))
    add(tile.start, tile.end);
  return pages;
}

export class ViewportReadAhead {
  pages = new Map();
  // Explicitly downloaded pages survive speculative prefetches in other views.
  pinned = new Set();

  observeRead(bytes, { start, headersAt, end }) {
    const readMs = end - start;
    if (readMs >= 25 && this.previousReadMs >= 25) this.slowReads = true;
    this.previousReadMs = readMs;
    if (bytes < pageBytes) return;
    const wait = headersAt - start;
    const transfer = (end - headersAt) * demandWindow / bytes;
    // Compare the cost of another round trip with moving a whole window.
    this.headerMs = this.headerMs === undefined ? wait : (3 * this.headerMs + wait) / 4;
    this.windowMs = this.windowMs === undefined ? transfer : (3 * this.windowMs + transfer) / 4;
  }

  shouldExpandLocal(timings, now) {
    if (this.slowReads) return true;
    const previous = timings.at(-2), last = timings.at(-1);
    // Require two distinct idle intervals. One startup stall or a pause at the
    // transfer prompt can otherwise trigger a whole-viewport download.
    return !!previous && last.start - previous.end - last.pausedBefore >= 100 &&
      now - last.end >= 100;
  }

  remember(start, data) {
    for (let i = 0; i < data.length; i += pageBytes)
      this.pages.set(start + i, data.slice(i, i + pageBytes));
    this.trim();
  }

  trim() {
    const limit = this.pinned.size + maxBytes / pageBytes;
    if (this.pages.size > limit) {
      for (const p of this.pages.keys()) {
        if (!this.pinned.has(p)) this.pages.delete(p);
        if (this.pages.size <= limit) break;
      }
    }
  }

  get(start, length) {
    const base = Math.floor(start / pageBytes) * pageBytes;
    const page = this.pages.get(base);
    if (!page) return null;
    const within = start - base;
    if (within + length <= page.length)
      return page.subarray(within, within + length);
    const end = start + length;
    const result = new Uint8Array(length);
    for (let p = base; p < end; p += pageBytes) {
      const part = this.pages.get(p);
      const until = Math.min(end - p, pageBytes);
      if (!part || until > part.length) return null;
      const from = Math.max(p, start);
      result.set(part.subarray(from - p, until), from - start);
    }
    return result;
  }

  async prepareHeaders(source, windows, remaining, localFile) {
    if (
      windows.length !== 1 ||
      source.size < 2 * 1024 * 1024 ||
      remaining() < 2 * 1024 * 1024
    )
      return;
    const box = projectedBox(windows[0].join(","));
    if (!box || this.catalog === null) return;
    // The directory is typically much smaller than one viewport's GOL data.
    // Read its aligned pages once, then use it to find nonadjacent tile heads.
    const slice = async (start, length) => {
      const end = start + length;
      if (end > source.size) throw new UnsupportedCatalog();
      const pages = new Set();
      for (
        let p = Math.floor(start / pageBytes) * pageBytes;
        p < end;
        p += pageBytes
      )
        pages.add(p);
      await this.fill(source, pages, remaining());
      const data = this.get(start, length);
      if (!data) throw new UnsupportedCatalog();
      return data;
    };
    let starts;
    try {
      this.catalog ??= await readCatalog(slice, source.size);
      starts = tileStarts(this.catalog, box);
    } catch (error) {
      if (!(error instanceof UnsupportedCatalog || error instanceof RangeError))
        throw error;
      if (!this.catalog) this.catalog = null;
      return;
    }
    const pages = new Set();
    for (const start of starts.keys()) {
      if (
        start < this.catalog.metadataEnd ||
        start + 24 > source.size ||
        (start < this.catalog.directory[1] &&
          start + 24 > this.catalog.directory[0])
      )
        return;
      const width = localFile ? block : pageBytes;
      const first = Math.floor(start / width) * width;
      const end = Math.min(
        source.size,
        Math.ceil((start + 24) / width) * width,
      );
      for (let p = first; p < end; p += pageBytes) pages.add(p);
    }
    await this.fill(source, pages, remaining(), localFile);
    if (localFile) return;
    const spans = [];
    for (const [start, zoom] of starts) {
      const header = this.get(start, 4);
      if (!header) return;
      try {
        spans.push({ start, end: tileEnd(this.catalog, source.size, start, header), zoom });
      } catch (error) {
        if (error instanceof UnsupportedCatalog) return;
        throw error;
      }
    }
    spans.push({ start: 0, end: this.catalog.metadataEnd },
      { start: this.catalog.directory[0], end: this.catalog.directory[1] });
    return { spans, visited: new Set(), peerBytes: 0 };
  }

  async readAround(source, start, length, plan, remaining) {
    const budget = remaining - demandReserve;
    if (!(this.headerMs >= 50 && this.headerMs > this.windowMs) || budget < pageBytes) return;
    const span = plan.spans.find((s) => start < s.end && start + length > s.start);
    if (!span) return;
    const pages = new Set(windowPages(span, start, demandWindow, this.pages));
    if (pages.size * pageBytes > budget) return;
    plan.visited.add(span);
    // GOL tiles at the same zoom often lay out their indexes and feature
    // records in similar order. Probe a small window in neighbouring tiles
    // at the same relative position while fetching the required window.
    if (plan.peerBytes < peerBudget && span.zoom !== undefined && span.end - span.start > demandWindow) {
      const fraction = Math.max(0, (start - span.start) / (span.end - span.start));
      let peers = 0;
      for (const peer of plan.spans) {
        if (peer.zoom !== span.zoom || plan.visited.has(peer) || peer.end - peer.start <= demandWindow)
          continue;
        const position = peer.start + fraction * (peer.end - peer.start);
        const extra = windowPages(peer, position, peerWindow, this.pages).filter((p) => !pages.has(p));
        const bytes = extra.length * pageBytes;
        if (!bytes || plan.peerBytes + bytes > peerBudget || pages.size * pageBytes + bytes > budget) continue;
        for (const p of extra) pages.add(p);
        plan.peerBytes += bytes;
        if (++peers === 4) break;
      }
    }
    await this.fill(source, pages, budget);
    return this.get(start, length);
  }

  async prepare(source, url, windows, remaining) {
    if (!source.etag || source.etag.startsWith("W/") || windows.length !== 1)
      return;
    const endpoint = new URL(url);
    endpoint.searchParams.set("bbox", windows[0].join(","));
    let hints;
    try {
      const response = await fetch(endpoint, {
        signal: source.signal ? AbortSignal.any([source.signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000),
        cache: "no-store",
      });
      if (response.status !== 200) return;
      hints = await response.json();
    } catch {
      return; // A local server can serve a GOL without a read plan.
    }
    if (
      hints?.etag !== source.etag ||
      !Array.isArray(hints.directory) ||
      hints.directory.length !== 2 ||
      !Array.isArray(hints.tiles) ||
      hints.tiles.length > 32 ||
      hints.tiles.some(
        (t) =>
          !t || !Number.isSafeInteger(t.start) || !Number.isSafeInteger(t.end),
      )
    )
      return;
    const pages = planPages(hints, source.size);
    await this.fill(source, pages, remaining, true);
  }

  async fill(source, pages, remaining, prune = false) {
    const missing = [...pages]
      .filter((p) => !this.pages.has(p))
      .sort((a, b) => a - b);
    if (missing.length * pageBytes > remaining) return;
    // Keep defensive range and snapshot validation in RangeFile for every GET.
    // Drop the previous viewport before allocating new payloads.
    if (prune)
      for (const p of this.pages.keys())
        if (!pages.has(p) && !this.pinned.has(p)) this.pages.delete(p);
    if (source.cache?.known.size) {
      const buffers = await readPages(source, missing);
      for (const [p, bytes] of buffers) this.pages.set(p, bytes);
      this.trim();
      return;
    }
    await readRanges(missing, pageBytes, source.size, async (start, length) => {
      this.remember(start, await source.read(start, length));
    });
  }
}

// Assemble full pages from memory, IndexedDB and HTTP. Keep partial pages
// private until every read succeeds, including the short page at EOF.
export async function readPages(source, pages, memory) {
  const buffers = new Map();
  const offsets = [];
  for (const page of pages) {
    const length = Math.min(pageBytes, source.size - page);
    buffers.set(page, new Uint8Array(length));
    for (let i = 0; i < length; i += blockBytes) offsets.push(page + i);
  }
  await readBlocks(source, offsets, memory, (start, bytes) => {
    const page = Math.floor(start / pageBytes) * pageBytes;
    buffers.get(page).set(bytes, start - page);
  });
  return buffers;
}

export async function readBlocks(source, offsets, memory, accept) {
  const missing = [];
  for (const start of offsets) {
    const bytes = memory?.(start);
    if (bytes) accept(start, bytes);
    else missing.push(start);
  }
  await readRanges(missing.sort((a, b) => a - b), blockBytes, source.size, async (start, length) => {
    source.signal?.throwIfAborted();
    const data = await source.read(start, length);
    for (let i = 0; i < length; i += blockBytes)
      accept(start + i, data.subarray(i, i + blockBytes));
  }, (p) => source.cache?.known.has(p) === true);
}

// Callers supply sorted, unique offsets. Keep cached and missing spans apart so
// one absent block does not force an entire IndexedDB hit back onto the network.
export async function readRanges(offsets, width, size, read, isStored = () => false) {
  const ranges = [];
  for (const start of offsets) {
    const end = Math.min(start + width, size);
    const stored = isStored(start);
    const last = ranges.at(-1);
    if (last && last.end === start && end - last.start <= maxGet && last.stored === stored)
      last.end = end;
    else ranges.push({ start, end, stored });
  }
  let index = 0;
  const run = async () => {
    try {
      while (index < ranges.length) {
        const { start, end } = ranges[index++];
        await read(start, end - start);
      }
    } catch (error) {
      index = ranges.length;
      throw error;
    }
  };
  // Drain active reads before handing the worker to the next job.
  const work = await Promise.allSettled(
    Array.from({ length: Math.min(maxConcurrentRanges, ranges.length) }, run),
  );
  const failed = work.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}
