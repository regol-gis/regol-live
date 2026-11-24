# Regol Live

Regol Live explores OpenStreetMap data in GeoDesk GOL files. Write GOQL or Overpass QL, inspect matching features on the map, and export the results as GeoJSON, KML or CSV.

## Explore the planet

Open **[live.regol.org](https://live.regol.org/)**, move the map to an area of interest and choose **Download this area** to review the size and cache the visible tiles. Select **Run query** to search. **Update on pan** can refresh results within the download. Outside it you can still run a query manually. The standalone site runs Regol in your browser using the OpenPlanetData planet GOL and GOB. A small Monaco dataset is also available in the dataset picker.

The dataset picker shows the publication date used for area downloads and live queries. Live chooses the newest same-date GOL and GOB available within the last seven UTC dates. If no pair is available, the GOL supplies both. Before a query reads the remote GOL, the site offers to download the visible area or **Run anyway**. Queries served from cache run immediately.

The download button shows the full size of the view and the bytes still to fetch. With a matched pair, the GOB size is the reference as you zoom. Live can use GOL pages already in the browser to reduce the transfer. A dashed blue outline marks the last completed download. Each tab can hold a selected area of up to 256 MiB. The browser can keep up to 128 MiB of verified compressed GOB tiles across reloads and use up to 320 MiB for decoded query data. On a later visit, the download estimate shows how much is likely to be reused. Confirmation checks the saved tiles against the archive. If a query reaches that limit, zoom in and run it again using the same download.

Choose **Overpass QL** and run this query to count attractions inside Disneyland, from any map viewport.

```overpass
area[name="Disneyland"][tourism=theme_park]->.park;
nwr[tourism=attraction](area.park);
out count;
```

The global name index covers named administrative boundaries and settlement polygons at any size. Other named areas qualify when their geographic bounding rectangle is at least 0.25 km². A lookup reads the shard for the name, then checks names, tags and geometry against the current GOL. A new name or a boundary that has moved past the saved search point can be missed until the next index refresh. [Query guide](docs/queries.md)

## Serve a local GOL

Install the main CLI and the Live server separately with Rust 1.90 or later. The main CLI supports the Live command from version 0.4.0.

```sh
cargo install --locked regol-cli
cargo install --locked regol-live
regol live region.gol
```

Open the URL printed in the terminal. The default is `http://127.0.0.1:4173`. The native server queries the local file and serves the map assets to the browser. Keep the GOL immutable while it is open. Use `--view LON,LAT,ZOOM` to set the initial camera, `--port` to select a port, or `--bind` to choose an address. The executable `regol-live` accepts the same arguments directly.

For a persistent local service on Linux, save this as `~/.config/systemd/user/regol-live.service`. Adjust the binary and GOL paths for your installation.

```ini
[Unit]
Description=Regol Live map

[Service]
ExecStart=%h/.cargo/bin/regol live %h/maps/region.gol
Restart=on-failure

[Install]
WantedBy=default.target
```

Run `systemctl --user daemon-reload` and `systemctl --user enable --now regol-live`. The service accepts local connections on port 4173. Local named-area queries can scan the file or use a matching index supplied with `--area-index DIRECTORY`. [Native query API](docs/native-api.md)

## Develop locally

Install a current Rust toolchain, Node.js 22.13 or later, and Chromium for the browser tests.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm test
npm run build
npm start
```

Open `http://127.0.0.1:4173/?dataset=monaco` for the bundled sample. Run `CHROME_BIN=/usr/bin/chromium npm run test:browser` against the build. To run the native server from source, use `cargo run --locked --release -- region.gol`. [Pages deployment and planet index](docs/pages.md)

## Data and licenses

Application code is licensed under Apache-2.0. OpenStreetMap data, including the planet name index and Monaco sample, is © OpenStreetMap contributors and distributed under ODbL 1.0. The map uses OpenFreeMap and MapLibre GL JS. [Code license](LICENSE) · [OpenPlanetData](https://openplanetdata.com/datasets/openstreetmap/planet/) · [OSM attribution](https://www.openstreetmap.org/copyright) · [Monaco provenance](web/data/README.md) · [MapLibre license](web/vendor/LICENSE.txt)
