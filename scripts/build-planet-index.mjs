import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { planetURL } from "../web/ranges.js";
import { scanPlanet } from "./planet-area-scan.mjs";
import { completedScan, publishIndex } from "./planet-area-publish.mjs";

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    source: { type: "string", default: planetURL },
    work: { type: "string", default: "target/planet-areas" },
    output: { type: "string", default: "planet-area-index" },
    "min-km2": { type: "string", default: "0.25" },
    jobs: { type: "string", default: "4" },
    scanner: { type: "string", default: "target/release/regol-area-index" },
    snapshot: { type: "string" },
  },
});
if (values.help) {
  console.log(`Usage: node scripts/build-planet-index.mjs [--source GOL_PATH_OR_URL | --snapshot ID]
       [--min-km2 NUMBER] [--work DIRECTORY] [--output DIRECTORY] [--jobs COUNT]

Defaults to the OpenPlanetData planet, a 0.25 km² bounding rectangle cutoff,
four simultaneous ranges, and gzip shards in planet-area-index/. Use --snapshot
to rebuild offline from the completed candidate scan in the work directory.`);
  process.exit(0);
}
const jobs = Number(values.jobs);
const minimum = Number(values["min-km2"]);
if (
  !Number.isInteger(jobs) ||
  jobs < 1 ||
  jobs > 16 ||
  !Number.isFinite(minimum) ||
  minimum < 0
)
  throw Error(
    "Use 1–16 concurrent jobs and a non-negative finite cutoff in km²",
  );
const scan = values.snapshot
  ? await completedScan(values.work, values.snapshot)
  : await scanPlanet(values.source, values.work, resolve(values.scanner), jobs);
await publishIndex(scan, values.work, values.output, minimum);
