import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGunzip, gzipSync } from "node:zlib";

export async function completedScan(work, snapshot) {
  if (!/^v1-[0-9a-f]+-[0-9a-f]+-\d+$/.test(snapshot))
    throw Error("Invalid GOL snapshot identifier");
  const directory = join(work, "candidates-v1", snapshot);
  const batches = JSON.parse(
    await readFile(join(directory, "complete.json"), "utf8"),
  );
  if (
    !Array.isArray(batches) ||
    !batches.length ||
    batches.some((name) => !/^\d+-\d+\.jsonl\.gz$/.test(name)) ||
    new Set(batches).size !== batches.length
  )
    throw Error("Invalid completed scan");
  return { snapshot, files: batches.map((name) => join(directory, name)) };
}

async function collectProbes(db, files) {
  db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-196608;
    CREATE TABLE probes (shard INTEGER, name TEXT, x INTEGER, y INTEGER,
      km2 REAL, protected INTEGER, PRIMARY KEY(shard,name,x,y)) WITHOUT ROWID;`);
  const insert = db.prepare(`INSERT INTO probes VALUES (?,?,?,?,?,?)
    ON CONFLICT(shard,name,x,y) DO UPDATE SET km2=max(km2,excluded.km2),
    protected=max(protected,excluded.protected)`);
  for (const [i, file] of files.entries()) {
    const stream = createReadStream(file);
    const contents = stream.pipe(createGunzip());
    stream.on("error", (error) => contents.destroy(error));
    contents.setEncoding("utf8");
    db.exec("BEGIN");
    try {
      // JSON Lines uses LF. U+2028 and U+2029 are valid characters in OSM names.
      let remainder = "";
      for await (const chunk of contents) {
        const lines = (remainder + chunk).split("\n");
        remainder = lines.pop();
        for (const line of lines) {
          const [shard, name, x, y, km2, keep] = JSON.parse(line);
          insert.run(shard, name, x, y, km2, Number(keep));
        }
      }
      if (remainder) throw Error(`Incomplete candidate record in ${file}`);
      db.exec("COMMIT");
    } finally {
      contents.destroy();
      stream.destroy();
    }
    if ((i + 1) % 500 === 0)
      console.error(`Merged ${i + 1}/${files.length} candidate batches`);
  }
}

function shardBytes(rows, minimum) {
  const entries = [];
  let entry;
  let probes = 0;
  for (const { name, x, y, km2, protected: keep } of rows) {
    if (!keep && km2 < minimum) continue;
    if (name !== entry?.[0]) {
      entry = [name, []];
      entries.push(entry);
    }
    entry[1].push([x, y]);
    probes++;
  }
  const json = Buffer.from(JSON.stringify(entries) + "\n");
  if (json.length > 64 * 1024 ** 2)
    throw Error("Shard exceeds the reader’s 64 MiB uncompressed limit");
  return {
    bytes: gzipSync(json, { level: 9 }),
    raw: json.length,
    names: entries.length,
    probes,
  };
}

export async function publishIndex(scan, work, output, minimum) {
  // Record completeness only after the last pinned range has been checked.
  // This allows retuning an older snapshot after the upstream URL advances.
  const receipt = join(dirname(scan.files[0]), "complete.json");
  const tempReceipt = receipt + "." + randomUUID();
  await writeFile(
    tempReceipt,
    JSON.stringify(scan.files.map((file) => basename(file))) + "\n",
  );
  await rename(tempReceipt, receipt);
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(work, "merge-"));
  const stage = await mkdtemp(join(output, ".generation-"));
  const db = new DatabaseSync(join(temporary, "probes.sqlite"));
  try {
    await collectProbes(db, scan.files);
    const cutoffs = [...new Set([0, 0.1, 0.25, 0.5, 1, minimum])].sort(
      (a, b) => a - b,
    );
    const sizes = cutoffs.map((km2) => ({
      km2,
      names: 0,
      probes: 0,
      jsonBytes: 0,
      gzipBytes: 0,
    }));
    const select = db.prepare(
      "SELECT name,x,y,km2,protected FROM probes WHERE shard=? ORDER BY name,x,y",
    );
    const digest = createHash("sha256");
    for (let id = 0; id < 256; id++) {
      const rows = select.all(id);
      for (const stat of sizes) {
        const shard = shardBytes(rows, stat.km2);
        stat.names += shard.names;
        stat.probes += shard.probes;
        stat.jsonBytes += shard.raw;
        stat.gzipBytes += shard.bytes.length;
        if (stat.km2 === minimum) {
          const name = id.toString(16).padStart(2, "0") + ".json.gz";
          await writeFile(join(stage, name), shard.bytes);
          digest.update(shard.bytes);
        }
      }
    }
    const generation = scan.snapshot + "-" + digest.digest("hex").slice(0, 16);
    const manifest = {
      version: 1,
      snapshot: scan.snapshot,
      shards: 256,
      storage: { format: "gzip", directory: generation },
      coverage: {
        minBoundingBoxKm2: minimum,
        alwaysInclude:
          "Named administrative boundaries and settlement polygons, including neighbourhoods",
      },
      attribution: {
        credit: "© OpenStreetMap contributors",
        license: "https://opendatacommons.org/licenses/odbl/1-0/",
        source: "https://openplanetdata.com/datasets/openstreetmap/planet/",
      },
    };
    // Install immutable generation first. The previous manifest stays usable until the atomic rename.
    try {
      await rename(stage, join(output, generation));
    } catch (error) {
      if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      for (let i = 0; i < 256; i++) {
        const filename = i.toString(16).padStart(2, "0") + ".json.gz";
        if (
          !(await readFile(join(stage, filename))).equals(
            await readFile(join(output, generation, filename)),
          )
        )
          throw Error("Conflicting existing generation");
      }
    }
    const report = { snapshot: scan.snapshot, cutoffs: sizes };
    await writeFile(
      join(output, "sizing-" + generation + ".json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    const tempManifest = join(output, ".manifest-" + randomUUID());
    await writeFile(tempManifest, JSON.stringify(manifest) + "\n");
    await rename(tempManifest, join(output, "manifest.json"));
    console.table(sizes);
    console.log(`Published local index ${join(output, "manifest.json")}`);
    return report;
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
