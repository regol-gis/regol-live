# Monaco sample

`monaco-2026-01-01.gol` contains the Geofabrik Monaco extract dated 1 January 2026. The GOL contains 10,645 features in eight spatial tiles and occupies 999,424 bytes. The map data is © OpenStreetMap contributors, distributed under the Open Database License 1.0. [OpenStreetMap attribution](https://www.openstreetmap.org/copyright) · [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) · [Geofabrik extract archive](https://download.geofabrik.de/europe/monaco/index.html)

To rebuild from the dated extract, install the `regol` CLI with `cargo install --locked regol-cli`, then run these commands from a scratch directory.

```sh
curl -fLO https://download.geofabrik.de/europe/monaco/monaco-260101.osm.pbf
echo '2c0debd7676c0d0d80ec534251cb004a6797441d14512cb83d01fe1ad81363bf  monaco-260101.osm.pbf' | sha256sum -c -
regol build --preset vector-tiles --target-tile-kib 64 monaco-260101.osm.pbf monaco-2026-01-01.gol
regol check monaco-2026-01-01.gol
```

The bundled file's SHA-256 is `688c393653335e9979d59d6ac5de9aee242ec35382a680874c74d8b4c60dd156`. Regol assigns a new tileset identifier when building a GOL. To check a rebuild by querying the data, the viewport below contains seven café nodes.

```sh
regol query monaco-2026-01-01.gol 'n[amenity=cafe]' --bbox 7.414,43.733,7.426,43.742 -f count
```
