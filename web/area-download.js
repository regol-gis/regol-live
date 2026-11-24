import { blockBytes } from "./range-cache.js";
import { pageBytes } from "./ranges.js";
import { readBlocks, readPages } from "./read-ahead.js";
import { projectedBox, readCatalog, tileEnd, tileStarts, TileCountLimit } from "./tile-catalog.js";

// Keep the complete selected area available even on memory-only origins.
export const maxAreaBytes = 256 * 1024 * 1024;
const maxHeaders = 256;
const align = (offset, width) => Math.floor(offset / width) * width;

export class AreaDownload {
  headers = new Map();
  pages = new Set();

  constructor(source, ahead, wasmBlock, localFile) {
    this.source = source;
    this.ahead = ahead;
    this.wasmBlock = wasmBlock;
    this.width = localFile ? 4 * pageBytes : pageBytes;
  }

  memory = (start) => {
    const length = Math.min(blockBytes, this.source.size - start);
    return this.headers.get(start) ?? this.ahead.get(start, length) ?? this.wasmBlock(start, length);
  };

  stored = (start) => this.source.cache?.known.has(start) === true;

  async catalogBytes(start, length, reader) {
    const end = start + length;
    if (end > this.source.size) throw Error("The GOL tile directory exceeds the file.");
    const offsets = [];
    for (let p = align(start, blockBytes); p < end; p += blockBytes) offsets.push(p);
    const result = new Uint8Array(length);
    await readBlocks(reader, offsets, this.memory, (p, bytes) => {
      const from = Math.max(p, start);
      result.set(bytes.subarray(from - p, end - p), from - start);
      this.keepHeader(p, bytes);
    });
    return result;
  }

  keepHeader(start, bytes) {
    // A later query can grow Wasm memory and detach a borrowed view.
    if (!this.headers.has(start)) this.headers.set(start, bytes.slice());
  }

  async planFromCache(windows) {
    const { source } = this;
    const reader = {
      size: source.size, cache: source.cache, signal: source.signal,
      read: async (start, length) => {
        const bytes = await source.cached(start, length);
        if (!bytes) throw Error("GOL metadata is missing from cache.");
        return bytes;
      },
    };
    try {
      return await this.plan(windows, reader);
    } catch {
      source.signal?.throwIfAborted();
      return null;
    }
  }

  async plan(windows, reader = this.source) {
    const { source, ahead } = this;
    const catalog = ahead.catalog ??= await readCatalog(
      (start, length) => this.catalogBytes(start, length, reader), source.size,
    );
    const starts = new Set();
    for (const window of windows) {
      const box = projectedBox(window.join(","), false);
      if (!box) throw Error("Could not determine the visible area.");
      for (const start of tileStarts(catalog, box, maxHeaders).keys()) {
        if (start < catalog.metadataEnd || start + 4 > source.size)
          throw Error("The GOL tile address is outside the data region.");
        starts.add(start);
      }
    }
    if (starts.size > maxHeaders) throw new TileCountLimit(maxHeaders);
    const headerBlocks = new Set([...starts].map((p) => align(p, blockBytes)));
    for (const p of this.headers.keys()) {
      const inDirectory = p < catalog.directory[1] && p + blockBytes > catalog.directory[0];
      if (!headerBlocks.has(p) && !inDirectory && p >= catalog.metadataEnd) this.headers.delete(p);
    }
    await readBlocks(reader, headerBlocks, this.memory, (p, bytes) => this.keepHeader(p, bytes));
    // A completed download retains its own page set while the next view is sized.
    const spans = [[0, catalog.metadataEnd], catalog.directory];
    for (const start of starts) {
      const block = align(start, blockBytes);
      const header = this.headers.get(block).subarray(start - block);
      spans.push([start, tileEnd(catalog, source.size, start, header)]);
    }
    // Count the union of aligned pages, including the short final page. Large
    // views need only their extents to report a size and decline the download.
    const ranges = [];
    let total = 0;
    for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
      const left = Math.max(align(start, this.width), ranges.at(-1)?.[1] ?? 0);
      const right = Math.min(source.size, Math.ceil(end / this.width) * this.width);
      if (left < right) {
        ranges.push([left, right]);
        total += right - left;
      }
    }
    this.plannedWindows = null;
    this.pages = new Set();
    if (total > maxAreaBytes)
      return { tiles: starts.size, total, missing: null, limitBytes: maxAreaBytes };
    for (const [left, right] of ranges)
      for (let p = left; p < right; p += pageBytes) this.pages.add(p);
    this.plannedWindows = windows;
    let missing = 0;
    for (const page of this.pages) {
      const end = Math.min(source.size, page + pageBytes);
      if (ahead.pages.has(page)) continue;
      for (let p = page; p < end; p += blockBytes)
        if (!this.stored(p) && !this.memory(p)) missing += Math.min(blockBytes, end - p);
    }
    return { tiles: starts.size, missing, total };
  }

  async download() {
    if (!this.plannedWindows) throw Error("Select a smaller area before downloading.");
    const { source, ahead } = this;
    const missing = [...this.pages].filter((start) => !ahead.pages.has(start));
    const buffers = await readPages(source, missing, this.memory, true);
    source.signal?.throwIfAborted();
    // Publish only complete pages. A failed download leaves the previous area
    // usable, and successfully persisted ranges can be reused on retry.
    for (const page of ahead.pinned)
      if (!this.pages.has(page)) ahead.pages.delete(page);
    for (const [page, bytes] of buffers) ahead.pages.set(page, bytes);
    ahead.pinned = this.pages;
    this.downloadedWindows = this.plannedWindows;
  }
}
