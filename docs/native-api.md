# Native query API

Send the editor’s structured query as JSON to `POST /api/query`. The endpoint always uses the file supplied at startup. Viewport windows contain west, south, east and north in degrees. Supply two windows for a viewport crossing the antimeridian.

```sh
curl http://127.0.0.1:4173/api/query -H 'Content-Type: application/json' \
  -d '{"windows":[[7.414,43.733,7.426,43.742]],"sets":[{"name":"cafes","source":"n[amenity=cafe]"}],"show":["cafes"]}'
```

A successful response contains `features`, `limited`, `skippedGeometries` and `skippedReferences`. Send `"setStats": true` to include `setStats` rows with `setIndex`, `candidatesRead`, `matchesKept` and `retained` for the steps actually executed. A structured set’s `filters` accepts GOQL tests such as `{"selector":"*[name]"}` alongside spatial filters. Features include their OSM ID, geometry, tags and output group. `limited` is null for complete results. The `Server-Timing` header reports evaluation time in milliseconds, and `X-Regol-Snapshot` identifies the open dataset session. Requests accept up to 8 MiB of JSON. The native server admits up to four queries at once, or fewer when fewer CPUs are available. Those queries share one pool sized to the available CPUs. A single query can use the whole pool to test spatial filters and prepare map features in parallel. Invalid programs return HTTP 422, and a full set of query slots returns HTTP 503.

To track a request, send a unique 32-digit hexadecimal ID in the `X-Regol-Query-Id` header. While the POST is pending, `GET /api/query/{id}/progress` returns the zero-based `setIndex` and sampled `candidatesRead` count, or `null` before evaluation reaches the first set. Inactive IDs return HTTP 404.

`POST /api/suggest-tags` accepts the same viewport `windows`, a GOQL `selector` with the active bracket removed, and the typed `prefix`. Supply `key` for value suggestions or omit it for keys. The response includes `items` with text, numeric encoding and counts, the prefix covered by the tally, and a `complete` flag. A complete tally can be filtered locally for any longer prefix within its coverage. The daemon gives foreground queries priority and returns HTTP 503 when a lookup cannot start.

To compile Overpass QL directly, send a JSON object with `text` and an optional `viewport` to `POST /api/overpass/compile`. The response is the same ordered plan the editor submits to `/api/query`. Supply viewport windows in west/south/east/north order when the text uses `{{bbox}}`. A syntax error returns HTTP 422 with a line diagnostic.

```sh
curl -s http://127.0.0.1:4173/api/overpass/compile \
  -H 'Content-Type: application/json' \
  -d '{"text":"node[amenity=cafe]({{bbox}}); out count;","viewport":[[7.414,43.733,7.426,43.742]]}'
```
