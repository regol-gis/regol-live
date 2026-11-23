import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
test(
  "planet cutoffs keep protected and large probes and can be changed from the completed scan",
  {
    skip:
      !process.getBuiltinModule?.("node:sqlite") &&
      "Planet index generation needs node:sqlite",
  },
  async (t) => {
    const { completedScan, publishIndex } = await import(
      "../scripts/planet-area-publish.mjs"
    );
    const work = await mkdtemp(join(tmpdir(), "regol-planet-index-"));
    t.after(() => rm(work, { recursive: true, force: true }));
    const snapshot = "v1-abc-def-10000";
    const directory = join(work, "candidates-v1", snapshot);
    const output = join(work, "site");
    const settlement = "Neighbourhood\u2028\u2029Été";
    await mkdir(directory, { recursive: true });
    const batches = [
      [
        [1, "Park", 10, 10, 0.8, false],
        [1, settlement, 2, 2, 0.01, true],
      ],
      [
        [1, "Park", 10, 10, 0.8, false],
        [1, "Park", 20, 20, 0.2, false],
      ],
    ];
    const files = [];
    for (const [i, rows] of batches.entries()) {
      const path = join(directory, i + "-" + (i + 1) + ".jsonl.gz");
      await writeFile(
        path,
        gzipSync(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
      );
      files.push(path);
    }
    await assert.rejects(completedScan(work, snapshot), { code: "ENOENT" });
    const report = await publishIndex({ snapshot, files }, work, output, 0.25);
    const manifest = async () =>
      JSON.parse(await readFile(join(output, "manifest.json")));
    async function rows(generation) {
      return JSON.parse(
        gunzipSync(await readFile(join(output, generation, "01.json.gz"))),
      );
    }
    const first = (await manifest()).storage.directory;
    assert.deepEqual(await rows(first), [
      [settlement, [[2, 2]]],
      ["Park", [[10, 10]]],
    ]);
    assert.equal(report.cutoffs.find((stat) => stat.km2 === 0).probes, 3);
    assert.equal(report.cutoffs.find((stat) => stat.km2 === 1).probes, 1);
    const scan = await completedScan(work, snapshot);
    assert.deepEqual(scan, { snapshot, files });
    await publishIndex(scan, work, output, 0.1);
    const second = (await manifest()).storage.directory;
    assert.notEqual(first, second);
    assert.deepEqual((await rows(second))[1], [
      "Park",
      [
        [10, 10],
        [20, 20],
      ],
    ]);
    assert.equal((await rows(first))[1][1].length, 1);
  },
);
