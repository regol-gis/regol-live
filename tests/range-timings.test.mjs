import test from "node:test";
import assert from "node:assert/strict";
import { summarizeReadTimings } from "../web/ranges.js";

test("overlapping GETs count once in elapsed time and split the slowest header wait", () => {
  const slow = { start: 10, end: 530, headersAt: 520, handlerAt: 25, disk: 5 };
  const later = {
    start: 600,
    end: 610,
    headersAt: 606,
    handlerAt: 602,
    disk: 4,
  };
  const overlap = { start: 40, end: 80, headersAt: 75, handlerAt: 45, disk: 3 };
  const summary = summarizeReadTimings([overlap, slow, later]);
  assert.deepEqual(summary, {
    busy: 530,
    gap: 70,
    peak: 2,
    longest: 520,
    headerWait: 510,
    split: { before: 15, after: 490 },
    disk: 12,
  });
  assert.equal(
    summarizeReadTimings([slow, { ...later, pausedBefore: 65 }]).gap,
    5,
  );
  for (const handlerAt of [null, -1000, 1000])
    assert.equal(summarizeReadTimings([{ ...slow, handlerAt }]).split, null);
});
