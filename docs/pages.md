# Publish the standalone site

The Pages workflow builds the site from the public source revision and the planet index pinned in `datasets/planet-index.sha256`. It fetches the release asset, verifies its checksum and deploys only the contents of `dist/`. Each lookup downloads the manifest and the compressed shards for the requested names. The full planet GOL and GOB stay at OpenPlanetData. [Published site](https://live.regol.org/) · [Index releases](https://github.com/regol-gis/regol-live/releases)

To build the same site locally, download the named tar from its matching GitHub release, then run these commands from the repository root.

```sh
read -r checksum archive < datasets/planet-index.sha256
gh release download "${archive%.tar}" --repo regol-gis/regol-live --pattern "$archive"
sha256sum -c datasets/planet-index.sha256
mkdir -p planet-area-index
tar -xf "$archive" -C planet-area-index
PLANET_AREA_INDEX=planet-area-index npm run build
```

## Refresh the planet index

With Node.js 22.13 or later and the Rust toolchain installed, run the builder locally. It reads the planet GOL in memory in byte ranges pinned to one ETag. The first scan transfers a planet's worth of data. Derived coordinates are checkpointed in `target/planet-areas/`, allowing interrupted scans to resume against the same upstream snapshot.

```sh
cargo build --locked --release --bin regol-area-index
node scripts/build-planet-index.mjs --min-km2 0.25
```

The output in `planet-area-index/` includes an immutable generation, its manifest, and a sizing report. Pass `--snapshot ID` with the manifest’s snapshot identifier to try a different cutoff from completed checkpoints offline. The 23 November 2026 planet measured 347.21 MB gzipped with full coverage and 44.76 MB at 0.25 km². The index consists of geographic hints and can be refreshed independently of the planet.

To prepare a new release asset with GNU tar, choose the date of the indexed planet. The archive contains only the manifest and its 256 selected shards.

```sh
tag=planet-areas-YYYY-MM-DD
generation=$(node -p "require('./planet-area-index/manifest.json').storage.directory")
tar --format=ustar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 \
  --mode='u=rwX,go=rX' -cf "$tag.tar" -C planet-area-index manifest.json "$generation"
sha256sum "$tag.tar" > datasets/planet-index.sha256
```

Upload the archive to a GitHub release with the matching tag. Include the OpenStreetMap attribution, ODbL license and source in the release description. Commit the updated checksum to deploy the new generation. The workflow also supports manual deployment from `main`. The Pages custom domain is `live.regol.org`, with a DNS CNAME targeting `regol-gis.github.io`.
