import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const dist = process.argv[2] || "dist";
function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
const revision = git("rev-parse", "--show-prefix") === ""
  ? git("rev-parse", "--verify", "HEAD")
  : null;
const status = revision && git("status", "--porcelain");
const { stdout } = await promisify(execFile)("cargo", [
  "metadata", "--locked", "--no-deps", "--format-version", "1",
]);
const { version } = JSON.parse(stdout).packages.find((pkg) => pkg.name === "regol-live");
const build = { version, revision, dirty: status === null ? null : status !== "" };

await mkdir(dist, { recursive: true });
await cp("web", dist, { recursive: true });
for (const [file, features] of [
  ["regol-live.wasm", []],
  ["regol-live-range.wasm", ["--features", "range-reader"]],
]) {
  execFileSync("cargo", [
    "build", "--locked", "--lib", "--profile", "wasm", "--target", "wasm32-unknown-unknown",
    "--target-dir", "target", ...features,
  ], { stdio: "inherit" });
  await cp("target/wasm32-unknown-unknown/wasm/regol_live.wasm", join(dist, file));
}
function buildAreaIndex(gol, output) {
  execFileSync(
    "cargo",
    ["run", "--locked", "--release", "--bin", "regol-area-index", "--", gol, output],
    { stdio: "inherit" },
  );
}
buildAreaIndex(
  "web/data/monaco-2026-01-01.gol",
  join(dist, "data", "monaco-2026-01-01.gol.areas"),
);
if (process.env.UK_GOL)
  buildAreaIndex(process.env.UK_GOL, join(dist, "datasets", "uk.gol.areas"));
const planetIndex = join(dist, "datasets", "planet.gol.areas");
if (process.env.PLANET_AREA_INDEX) {
  const source = process.env.PLANET_AREA_INDEX;
  const manifest = await readFile(join(source, "manifest.json"));
  const { snapshot, shards, storage, coverage } = JSON.parse(manifest);
  if (shards !== 256 || storage?.format !== "gzip" ||
      !/^v1-[0-9a-f]+-[0-9a-f]+-\d+-[0-9a-f]{16}$/.test(storage.directory) ||
      !storage.directory.startsWith(snapshot + "-")) throw Error("Invalid compressed planet index");
  const generation = storage.directory;
  build.planetAreaCutoffKm2 = coverage?.minBoundingBoxKm2;
  await mkdir(join(planetIndex, generation), { recursive: true });
  for (let shard = 0; shard < shards; shard++) {
    const name = shard.toString(16).padStart(2, "0") + ".json.gz";
    await cp(join(source, generation, name), join(planetIndex, generation, name));
  }
  await writeFile(join(planetIndex, "manifest.json"), manifest);
} else if (process.env.PLANET_GOL) {
  buildAreaIndex(process.env.PLANET_GOL, planetIndex);
}
await writeFile(join(dist, "build.json"), JSON.stringify(build) + "\n");
if (process.env.PLANET_AREA_INDEX) {
  let bytes = 0;
  for (const file of await readdir(dist, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) bytes += (await stat(join(file.parentPath, file.name))).size;
  }
  if (bytes > 1_000_000_000) throw Error(`The ${bytes}-byte site exceeds the GitHub Pages size limit`);
  console.log(`Static site: ${bytes} bytes including the compressed planet index`);
}
