// GOL demand reads are aligned to at least 16 KiB. A viewport GET can span
// many blocks, and the final block of a file can be short.
export const blockBytes = 16 * 1024;
const maxBlocks = (256 * 1024 * 1024) / blockBytes;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("regol-gol-ranges", 1);
    req.onupgradeneeded = () => {
      const blocks = req.result.createObjectStore("blocks", {
        keyPath: ["snapshot", "start"],
      });
      blocks.createIndex("written", "written");
    };
    req.onerror = () => reject(req.error);
    let blocked = false;
    req.onblocked = () => {
      blocked = true;
      resolve(null);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close();
      else resolve(db);
    };
  });
}

export class RangeCache {
  static async open(snapshot, size) {
    let db;
    try {
      if (!globalThis.indexedDB) return null;
      db = await openDatabase();
      if (!db) return null;
      const keys = await request(
        db
          .transaction("blocks")
          .objectStore("blocks")
          .getAllKeys(IDBKeyRange.bound([snapshot, 0], [snapshot, size])),
      );
      return new RangeCache(
        db,
        snapshot,
        size,
        new Set(keys.map((key) => key[1])),
      );
    } catch {
      db?.close();
      return null;
    }
  }

  constructor(db, snapshot, size, known) {
    Object.assign(this, { db, snapshot, size, known });
  }

  async get(start, length) {
    const end = start + length;
    if (!this.db || start < 0 || length <= 0 || end > this.size) return null;
    const first = Math.floor(start / blockBytes) * blockBytes;
    for (let i = first; i < end; i += blockBytes)
      if (!this.known.has(i)) return null;
    try {
      const rows = await request(
        this.db
          .transaction("blocks")
          .objectStore("blocks")
          .getAll(
            IDBKeyRange.bound(
              [this.snapshot, first],
              [this.snapshot, end],
              false,
              true,
            ),
          ),
      );
      const data = new Uint8Array(length);
      for (let offset = first; offset < end; offset += blockBytes) {
        const row = rows[(offset - first) / blockBytes];
        if (
          row?.start !== offset ||
          row.data.length !== Math.min(blockBytes, this.size - offset)
        ) {
          this.known.delete(offset);
          return null; // Another tab can evict a block.
        }
        const from = Math.max(start, offset);
        data.set(row.data.subarray(from - offset, end - offset), from - start);
      }
      return data;
    } catch {
      this.close();
      return null;
    }
  }

  async put(start, data) {
    if (
      !this.db ||
      start % blockBytes ||
      (data.length % blockBytes && start + data.length !== this.size)
    )
      return;
    try {
      const tx = this.db.transaction("blocks", "readwrite", {
        durability: "relaxed",
      });
      const done = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      const store = tx.objectStore("blocks");
      const written = Date.now();
      for (let i = 0; i < data.length; i += blockBytes) {
        store.put({
          snapshot: this.snapshot,
          start: start + i,
          written,
          data: data.slice(i, i + blockBytes),
        });
      }
      // Every block has one written index entry. Counting the compact index
      // avoids scanning the 16 KiB payload records on each GET in Firefox.
      const byWriteTime = store.index("written");
      const count = byWriteTime.count();
      count.onsuccess = () => {
        if (count.result <= maxBlocks) return;
        // Trim in batches. Counting, inserting and evicting share a single
        // transaction so concurrent tabs respect the same origin-wide ceiling.
        const excess = count.result - Math.floor(maxBlocks * 0.9);
        const oldest = byWriteTime.getAllKeys(null, excess);
        oldest.onsuccess = () => {
          for (const key of oldest.result) {
            store.delete(key);
            if (key[0] === this.snapshot) this.known.delete(key[1]);
          }
        };
      };
      await done;
      for (let i = 0; i < data.length; i += blockBytes)
        this.known.add(start + i);
      // Other tabs may have evicted entries since this worker opened.
      while (this.known.size > maxBlocks)
        this.known.delete(this.known.values().next().value);
    } catch {
      this.close(); // Quota or private browsing must not interrupt a query.
    }
  }

  close() {
    this.db?.close();
    this.db = null;
    this.known.clear();
  }
}
