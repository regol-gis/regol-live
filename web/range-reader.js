import { blockBytes } from "./range-cache.js";

let compiled;
export function rangeModule() {
  return compiled ??= WebAssembly.compileStreaming(fetch("./regol-live-range.wasm"))
    .catch(error => { compiled = undefined; throw error; });
}

export function cursorImports(current, engine) {
  return {
    planning: () => Number(current()?.planning ?? false),
    cursor_count: () => current()?.planning ? 0 : current()?.width ?? 0,
    warm_output_enabled: () => Number(current()?.warmOutput ?? false),
    begin_cursor: id => Number(current().begin(id)),
    cursor_blocked: () => Number(Boolean(current()?.miss)),
    end_cursor: () => current().end(),
    wait_for_cursor: new WebAssembly.Suspending(() => current().wait()),
    warm_pages: new WebAssembly.Suspending((ptr, count, unit) => {
      const offsets = Array.from(new BigUint64Array(engine().memory.buffer, ptr, count), Number);
      return current().warm(offsets, unit);
    }),
  };
}

// One queue for the lifetime of a query. Overlapping requests for 16 KiB
// blocks share a ticket, including when one caller needs a full 128 KiB page.
export class CursorReader {
  blocks = new Map();
  ready = new Set();
  pending = new Set();
  active = new Set();
  lanes = new Map();
  controller = new AbortController();

  constructor(source, ahead, signal, request, reserve, onWait) {
    this.source = source;
    this.ahead = ahead;
    this.reserve = reserve;
    this.onWait = onWait;
    this.width = 128;
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.signal.addEventListener("abort", () => this.rejectPending(this.signal.reason), { once: true });
    const set = request.sets?.[0];
    this.warmOutput = request.sets?.length === 1 && !request.outputs?.length &&
      (!request.output || request.output === "geom") && set && !set.filters?.length &&
      Object.keys(set).every(key => ["name", "source", "filters"].includes(key)) &&
      request.show?.length === 1 && request.show[0] === set.name;
    // Expose known index and tag pages before dependent geometry on wide runs.
    this.planning = this.warmOutput &&
      typeof set.source === "string" && set.source.includes("[");
    this.cap = this.planning ? 64 : 16;
  }

  begin(id) {
    if (this.signal.aborted || this.lanes.has(id)) return false;
    this.lane = id;
    return true;
  }

  end() {
    if (this.miss) {
      const id = this.lane;
      this.lanes.set(id, this.miss.finally(() => this.lanes.delete(id)));
    }
    this.lane = this.miss = undefined;
  }

  async wait() {
    const start = performance.now();
    try {
      if (this.lanes.size) await Promise.race(this.lanes.values());
      return Number(!this.signal.aborted);
    } finally {
      this.onWait(performance.now() - start);
    }
  }

  blocksFor(start, length) {
    const parts = [];
    let missing = false;
    for (let p = start; p < start + length; p += blockBytes) {
      let block = this.blocks.get(p);
      if (!block) {
        const resident = this.ahead.get(p, Math.min(blockBytes, this.source.size - p));
        if (resident) { parts.push(resident); continue; }
        block = Promise.withResolvers();
        this.blocks.set(p, block);
        this.pending.add(p);
      }
      if (!block.bytes) missing = true;
      parts.push(block.bytes ?? block.promise);
    }
    return { parts, missing };
  }

  async warm(pages, unit) {
    const start = performance.now();
    try {
      this.signal.throwIfAborted();
      const tickets = pages.map(p => {
        const length = Math.min(unit, this.source.size - p);
        if (this.ahead.get(p, length)) return;
        return Promise.all(this.blocksFor(p, length).parts);
      });
      this.schedule();
      await Promise.all(tickets);
      return 1;
    } catch {
      return 0;
    } finally {
      this.onWait(performance.now() - start);
    }
  }

  async copy(start, length, memory, destination) {
    if (this.signal.aborted || this.miss) return 0;
    const page = this.ahead.get(start, length);
    if (page) {
      new Uint8Array(memory.buffer, destination, length).set(page);
      return 1;
    }
    let { parts, missing } = this.blocksFor(start, length);
    if (missing) {
      const ticket = Promise.all(parts);
      this.schedule();
      if (this.lane !== undefined) {
        // Rust rewinds this cursor's traversal to the start of the operation.
        this.miss = ticket.catch(() => {}); // fill() records the cause for the query.
        return 0;
      }
      parts = await ticket;
    }
    const bytes = new Uint8Array(memory.buffer, destination, length);
    let pos = 0;
    for (const part of parts) {
      bytes.set(part, pos);
      pos += part.length;
    }
    return 1;
  }

  schedule() {
    if (this.scheduled || this.active.size >= this.cap || !this.pending.size || this.signal.aborted) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const offsets = [...this.pending].sort((a, b) => a - b);
      let i = 0;
      while (i < offsets.length && this.active.size < this.cap && !this.signal.aborted) {
        const first = offsets[i++];
        let end = first + blockBytes;
        const limit = first + 1024 * 1024;
        const stored = p => this.source.cache?.known.has(p);
        while (offsets[i] === end && end < limit && stored(first) === stored(end)) {
          end += blockBytes;
          i++;
        }
        for (let p = first; p < end; p += blockBytes) this.pending.delete(p);
        const task = this.fill(first, Math.min(end, this.source.size)).finally(() => {
          this.active.delete(task);
          this.schedule();
        });
        this.active.add(task);
      }
    });
  }

  async fill(first, end) {
    try {
      const length = end - first;
      let bytes = await this.source.cached(first, length);
      if (!bytes) {
        this.signal.throwIfAborted();
        await this.reserve(length, this.signal);
        this.signal.throwIfAborted();
        bytes = await this.source.fetchRange(first, length);
      }
      this.signal.throwIfAborted();
      for (let p = first; p < end; p += blockBytes) {
        const block = this.blocks.get(p);
        block.bytes = bytes.subarray(p - first, p - first + blockBytes);
        block.resolve(block.bytes);
        this.ready.add(p);
      }
      while (this.ready.size * blockBytes > 16 * 1024 * 1024) {
        const oldest = this.ready.values().next().value;
        this.ready.delete(oldest);
        this.blocks.delete(oldest);
      }
    } catch (error) {
      if (!this.signal.aborted) this.error = error;
      this.controller.abort(error);
      for (let p = first; p < end; p += blockBytes) this.blocks.get(p).reject(error);
    }
  }

  rejectPending(error) {
    for (const p of this.pending) this.blocks.get(p).reject(error);
    this.pending.clear();
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled([...this.active, ...this.lanes.values()]);
  }
}
