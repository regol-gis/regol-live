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

test("a broad query grows its small cache on repeated evictions when memory is unknown", async () => {
  const MiB = 1024 * 1024;
  const source = {
    size: 32 * MiB, cached: async () => null,
    fetchRange: async (_, length) => new Uint8Array(length),
  };
  const request = { sets: [{ name: "roads", source: "w[highway]" }], show: ["roads"], windows: [[0,0,1,1]] };
  const reader = new CursorReader(source, { get: () => null }, new AbortController().signal,
    request, async () => {}, () => {});
  const offsets = Array.from({ length: 16 * MiB / blockBytes + 64 }, (_, i) => i * blockBytes);
  assert.equal(await reader.warm(offsets, blockBytes), 1);
  assert.equal(reader.ready.size * blockBytes, 16 * MiB);
  assert.equal(await reader.warm(offsets.slice(0, 64), blockBytes), 1);
  assert.equal(reader.readyLimit, 32 * MiB);
  await reader.close();
  assert.equal(reader.blocks.size, 0);
  assert.equal(reader.ready.size, 0);
});
