import assert from "node:assert/strict";
import test from "node:test";
import { CursorReader } from "../web/range-reader.js";
import { blockBytes } from "../web/range-cache.js";

test("index planning shares overlapping tickets, fills 64 slots and drains on cancellation", async () => {
  const full = Promise.withResolvers();
  const release = Promise.withResolvers();
  const reservations = [];
  const starts = [];
  const source = {
    size: 256 * blockBytes,
    cached: async () => null,
    async fetchRange(start, length) {
      starts.push(start);
      if (starts.length === 64) full.resolve();
      await release.promise;
      return new Uint8Array(length);
    },
  };
  const abort = new AbortController();
  const request = { sets: [{ name: "result", source: "w[highway]" }], show: ["result"] };
  const reader = new CursorReader(source, { get: () => null }, abort.signal, request,
    async length => { reservations.push(length); }, () => {});
  const offsets = Array.from({length: 90}, (_, i) => 2 * i * blockBytes);
  const first = reader.warm(offsets, blockBytes);
  const overlapping = reader.warm(offsets.slice(20), blockBytes);
  await full.promise;
  assert.equal(reader.active.size, 64);
  assert.equal(new Set(starts).size, 64);
  assert.deepEqual(reservations, Array(64).fill(blockBytes));
  abort.abort();
  release.resolve();
  assert.deepEqual(await Promise.all([first, overlapping]), [0, 0]);
  await reader.close();
  assert.equal(starts.length, 64);
  assert.equal(reader.active.size, 0);
});
