import assert from "node:assert/strict";

export async function checkRangeStorage(page, base) {
  const size = 2 * 128 * 1024 + 31;
  const url = base + "/storage-fixture.gol";
  const requests = [];
  let version = 1,
    etag = '"v1"',
    cacheControl = "no-cache";
  await page.route(url, async (route) => {
    const range = route.request().headers().range;
    requests.push(range);
    const [start, requestedEnd] = range.slice(6).split("-").map(Number);
    const end = Math.min(size - 1, requestedEnd);
    const body = Buffer.alloc(end - start + 1);
    for (let i = 0; i < body.length; i++)
      body[i] = version + Math.floor((start + i) / 16384);
    await route.fulfill({
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Cache-Control": cacheControl,
        ETag: etag,
      },
      body,
    });
  });
  // Every pass reopens the source, as a new worker/tab would.
  async function run(start, length) {
    requests.length = 0;
    return page.evaluate(
      async ({ url, start, length }) => {
        const { RangeFile } = await import("/ranges.js");
        let reused = 0;
        const file = new RangeFile(
          url,
          () => {},
          (n) => {
            reused += n;
          },
        );
        await file.open();
        const data = await file.read(start, length);
        file.cache?.close();
        return [data[0], data.at(-1), reused];
      },
      { url, start, length },
    );
  }
  assert.deepEqual(await run(131072, 131072 + 31), [9, 17, 0]);
  assert.equal(requests.length, 2);
  assert.deepEqual(await run(147456, 16384), [10, 10, 16384]);
  assert.deepEqual(requests, ["bytes=0-131071"]);
  assert.deepEqual(await run(147455, 3), [9, 10, 3]);
  assert.deepEqual(await run(262144, 31), [17, 17, 31]);
  version++;
  etag = '"v2"';
  assert.deepEqual(await run(147456, 16384), [11, 11, 0]);
  assert.equal(requests.length, 2);
  cacheControl = "no-store";
  assert.deepEqual(await run(147456, 16384), [11, 11, 0]);
  etag = 'W/"v2"';
  cacheControl = "no-cache";
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await run(147456, 16384), [11, 11, 0]);
  await page.unroute(url);
}

// Exercise the real v1 schema at its origin-wide block ceiling. The padding
// snapshot needs only index keys, so this fixture uses very little disk space.
export async function checkRangeEviction(page) {
  const result = await page.evaluate(async () => {
    const { RangeCache } = await import("/range-cache.js");
    const block = 16 * 1024;
    const capacity = 16384;
    const size = capacity * block;
    const old = await RangeCache.open("eviction-old", size);
    const fresh = await RangeCache.open("eviction-new", size);
    const bytes = new Uint8Array(block).fill(42);
    try {
      await old.put(0, bytes);
      await new Promise((resolve, reject) => {
        const tx = old.db.transaction("blocks", "readwrite");
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        const store = tx.objectStore("blocks");
        const count = store.count();
        count.onsuccess = () => {
          store.put({
            snapshot: old.snapshot, start: 0, written: 0, data: bytes,
          });
          for (let i = 1; i <= capacity - count.result; i++)
            store.put({
              snapshot: "eviction-padding", start: i * block, written: 1,
            });
        };
      });
      // The two connections serialize their evictions across snapshots.
      await Promise.all([fresh.put(0, bytes), old.put(size - block, bytes)]);
      const count = await new Promise((resolve, reject) => {
        const req = fresh.db.transaction("blocks").objectStore("blocks").count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return {
        count,
        old: await old.get(0, 1),
        fresh: (await fresh.get(0, 1))?.[0],
        last: (await old.get(size - block, 1))?.[0],
      };
    } finally {
      old.close();
      fresh.close();
    }
  });
  assert.deepEqual(result, {
    count: Math.floor(16384 * 0.9) + 1,
    old: null,
    fresh: 42,
    last: 42,
  });
}
