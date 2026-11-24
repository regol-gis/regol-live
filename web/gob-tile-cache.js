// Optional on-disk storage for sealed tiles. The live archive is validated
// before its identity is used to find cached bodies.
const maxBytes = 128 * 1024 * 1024;
const maxEntries = 2048;
const database = "regol-gob-tiles-v1";
let updates;
let hintVersion = 0;

function watchUpdates() {
  if (updates !== undefined) return;
  try {
    updates = new BroadcastChannel(database);
    updates.onmessage = () => { hintVersion++; };
    updates.unref?.();
  } catch {
    updates = null;
  }
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function response(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
}

export class GobTileCache {
  static async open(identity, budget = maxBytes) {
    try {
      if (!globalThis.indexedDB) return;
      const request = indexedDB.open(database, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("entries", { keyPath: "id" });
        db.createObjectStore("bodies");
      };
      const db = await Promise.race([response(request), new Promise(resolve => {
        request.onblocked = () => { blocked = true; resolve(null); };
        request.addEventListener("success", () => { if (blocked) request.result.close(); });
      })]);
      if (db) {
        const cache = new GobTileCache(db, identity, Math.min(maxBytes, budget));
        db.onclose = () => { cache.hints = undefined; };
        db.onversionchange = () => { cache.hints = undefined; db.close(); };
        watchUpdates();
        await cache.loadHints();
        return cache;
      }
    } catch {
      // Browsing modes and storage errors may make IndexedDB unavailable.
    }
  }

  constructor(db, identity, budget) {
    Object.assign(this, { db, identity, budget });
  }

  async loadHints() {
    const version = hintVersion;
    try {
      const bounds = IDBKeyRange.bound([this.identity, 0], [this.identity, Number.MAX_SAFE_INTEGER]);
      const entries = await response(this.db.transaction("entries").objectStore("entries").getAll(bounds, maxEntries));
      this.hints = new Map(entries.map(({ id, length }) => [id[1], length]));
      this.hintVersion = version;
    } catch {
      // The estimator falls back to its transfer size without storage.
      this.hints = undefined;
    }
  }

  hasHint(tip, length) {
    return this.hintVersion === hintVersion && this.hints?.get(tip) === length;
  }

  forgetHint(tip) {
    this.hints?.delete(tip);
  }

  async read(entries, signal) {
    const chunks = new Map();
    try {
      const tx = this.db.transaction(["entries", "bodies"]);
      const index = tx.objectStore("entries"), bodies = tx.objectStore("bodies");
      await Promise.allSettled(entries.map(async ({ tip, length }) => {
        const id = [this.identity, tip];
        const [entry, blob] = await Promise.all([response(index.get(id)), response(bodies.get(id))]);
        if (signal.aborted || entry?.length !== length || blob?.size !== length) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (await sha256(bytes) === entry.digest && !signal.aborted) chunks.set(tip, bytes);
      }));
    } catch {
      chunks.clear();
    }
    signal.throwIfAborted();
    for (const { tip } of entries) if (!chunks.has(tip)) this.forgetHint(tip);
    return chunks;
  }

  async put(chunks, signal) {
    const bytes = chunks.reduce((sum, [, data]) => sum + data.length, 0);
    if (!bytes || bytes > this.budget) return;
    let tx, abort;
    try {
      const stamp = Date.now();
      const fresh = await Promise.all(chunks.map(async ([tip, data]) => ({
        id: [this.identity, tip], digest: await sha256(data),
        length: data.length, stamp, blob: new Blob([data]),
      })));
      signal.throwIfAborted();
      tx = this.db.transaction(["entries", "bodies"], "readwrite", { durability: "relaxed" });
      abort = () => tx.abort();
      signal.addEventListener("abort", abort, { once: true });
      const barrier = done(tx);
      const index = tx.objectStore("entries"), bodies = tx.objectStore("bodies");
      const read = index.getAll();
      const version = hintVersion;
      let retained;
      let evicted = false;
      read.onsuccess = () => {
        const replacing = new Set(chunks.map(([tip]) => tip));
        const prior = read.result.filter(({ id }) => id[0] !== this.identity || !replacing.has(id[1]));
        prior.sort((a, b) => a.stamp - b.stamp);
        let total = bytes + prior.reduce((sum, entry) => sum + entry.length, 0);
        let count = fresh.length + prior.length;
        retained = new Map(fresh.map(({ id, length }) => [id[1], length]));
        for (const entry of prior) {
          if (total > this.budget || count > maxEntries) {
            evicted = true;
            total -= entry.length;
            count--;
            index.delete(entry.id);
            bodies.delete(entry.id);
          } else if (entry.id[0] === this.identity) {
            retained.set(entry.id[1], entry.length);
          }
        }
        for (const { blob, ...entry } of fresh) {
          index.put(entry);
          bodies.put(blob, entry.id);
        }
      };
      await barrier;
      this.hints = retained;
      this.hintVersion = evicted ? ++hintVersion : version;
      if (evicted) {
        try { updates?.postMessage(null); } catch { /* Hints remain advisory. */ }
      }
      return bytes;
    } catch {
      // A complete area may still be used in this worker after a quota error.
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
}
