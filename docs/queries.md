# Query the map

## Query a viewport

In standalone mode, you can pan, choose a dataset or edit a query before the first search. Click **Run query**, press Ctrl/Cmd+Enter in the editor, or choose **Apply and run** in the query builder to start. After that, **Update on pan** evaluates the query in the new viewport and keeps the previous map visible while it loads. The native server runs the initial query when the map opens.

Beside **Results**, choose **GeoJSON**, **KML**, or **CSV (WKT)** and click **Export**. The download contains all matches in the current result list, including rows behind **Show more**, with WGS 84 geometries, typed OSM IDs and query set names. Overpass `out center;` exports points, and `out count;` produces a summary without feature rows. An explicitly shown `$geometry` is included as a separate feature. Partial downloads have `-partial` in the filename. GeoJSON and KML expose OSM attributes as `tag:<key>` fields. CSV stores geometry in `WKT` and all original tags in `tags_json`.

Choose **SVG map** for a static copy of the current viewport. The 2D result, selection and reference geometries are editable SVG shapes. The basemap, labels and 3D buildings are embedded at the screen’s resolution. **HTML map** downloads an interactive map with the current camera, MapLibre runtime and map overlays embedded, including retained matches from recent pans. Pan, zoom or tilt when you open the file. Basemap tiles, glyphs and sprites load from OpenFreeMap over the internet. Both map formats work with an empty result list.

Run a single selector such as `na[amenity=cafe]` directly, or pipe it through filters, for example `n[amenity=bench] | within($geometry)`. Each fresh selector searches the current map viewport, including selectors used as references. To reuse a selection, assign it to a named set. Add spatial filters with a pipe, using an earlier set as the reference. This example finds cafés near benches inside parks and gardens. Only the cafés appear in the results and on the map.

```text
$parks = a[leisure=park,garden]
$benches = n[amenity=bench]
  | within($parks)
$cafes = na[amenity=cafe]
  | within_distance($benches, 150)
show($cafes)
```

Programs with named declarations end with an explicit `show(...)`. Change the last line to `show($benches, $cafes)` to display both sets with a colour key. An OSM object shared by multiple GOQL outputs appears once, coloured for the earliest declared set that displays it. To highlight a subset alongside the rest, show the subset and a second set made with `except($subset)`. You can also start a set from a previous result, for example `$nearby = $cafes | within_distance($parks, 25)`. Multiple pipes on a set apply all its filters. Use `$named = $cafes | where [name]` to test GOQL tag clauses on an earlier result. Each `where` takes one or more brackets. A pipe can start or end a line. A semicolon ends the pipeline. Distances are in metres. Statements can occupy separate lines or be separated by semicolons. Use `//` for comments.

Use `except($set)` to subtract features by OSM type and ID. For example, `$far = $cafes | except($near)` keeps the cafés outside your earlier selection. Distance and membership examples use the features selected in the current map view.

Use `parents_of($set)` for ways or relations containing a selected member, and `members_of($set)` for their immediate children. Both accept an optional double-quoted relation role. Omitting the role matches any link, including way–node links. An explicit `""` matches relation members whose stored role is empty. Expanding a way’s nodes requires the corresponding feature records in the GOL.

```text
$stops = n[public_transport=stop_position]
$routes = r[type=route][route=bus] | parents_of($stops)
$platforms = na[public_transport=platform] | members_of($routes, "platform")
show($routes, $platforms)
```

After a pipe, the editor suggests filters. Inside a filter or `show(...)`, it suggests available set names. Choose a diagnostic’s repair to replace a mistyped name or insert a missing `show(...)`. Run query to select the token that needs attention. Type inside a GOQL tag bracket in the editor or query builder to see key suggestions. After `=` or `!=`, the list suggests values for that key. Use the arrow keys and Enter to choose, click a suggestion, or press Escape to dismiss. Ctrl/Cmd+Enter in the editor runs the query. For example, `na[amenity=cafe][o` suggests keys on cafés in the current viewport.

**Features in view** counts distinct OSM objects carrying each key or value. Counts include the active branch’s feature types and its other tag conditions, before spatial filters. In a `where` stage, counts follow the source selector, named inputs and earlier tag filters. The suggestion heading identifies any spatial or set filters omitted from the tally. A value count after `!=` tells you how many features carry the value being excluded. A number prefixed with **≥** is a lower bound from a limited scan. Common suggestions appear without numbers while counts are unavailable. WASM and the native daemon use the same tag counter. In WASM, a lookup can fetch up to 2 MiB of additional GOL ranges.

**Query builder** opens the current program. Add a set, enter a selector, add filters, and tick **Show this set** for the outputs you want. **Apply and run** writes the program back to the editor. **Cancel** or Escape discards the draft.

Inside **Map geometry**, draw a point, line or polygon, or paste a GeoJSON geometry or Feature. A map or list result also has **Use as reference geometry** in its inspector. Use the attached geometry as `$geometry`, for example `| within($geometry)`. To keep the attachment visible on the map after drawing, include it in `show(...)`. When map features overlap, use the inspector arrows to cycle through the selectable objects.

Each positive spatial filter matches a candidate against any feature in its reference set. `disjoint` requires separation from every reference feature. An empty reference set therefore gives zero positive matches and keeps all candidates for `disjoint` or `except`. Complete results explain when a filter used an empty reference. An unshown selector or tag-only alias used as the source of just one live set runs inside that consumer. Shared sets and spatial references keep their members. Open **Query steps** in the results to see actual candidate reads, matches kept for output or reuse, and features retained per executed step. The figures include work up to any display limit. Each stored intermediate set can hold up to 250,000 features. If it exceeds its feature or vertex budget, narrow the selector or zoom in.

Spatial filters use an R-tree to narrow the search through a named reference set. For example, each café in `within_distance($stops, 100)` is tested against nearby stops until one is within 100 metres. The distance index uses three-dimensional bounds on the unit sphere so searches also work across the antimeridian. Regol computes the exact spherical distance for shortlisted pairs.

If a feature’s geometry cannot be assembled or tested against the chosen relationship, the explorer skips it and keeps the valid results. The results panel counts each skipped OSM object once and shows how many came from the reference query. Only usable references contribute to the spatial match.

Regol evaluates the relationship **candidate relative to reference**. **Contains** finds candidates containing the reference. **Within** finds candidates inside the reference with intersecting interiors. **Covered by** includes candidates lying wholly on its boundary. The other choices are **Intersects**, **Touches**, **Overlaps**, **Crosses**, **Disjoint from**, and **Within distance of** (inclusive, metres). All nine use regol’s Rust spatial filters. Pasted GeoJSON supports points, lines, polygons with holes, multi-geometries, and geometry collections in longitude/latitude degrees.

The viewport selects candidates by their stored bounding boxes. A street-sized view can therefore match administrative boundaries for an entire country. Add a GOQL filter such as `[admin_level=8]` when you want one administrative level. Antimeridian-crossing viewports use two windows and deduplicate OSM IDs. The Rust library evaluates topological relations in its projected plane and distance with its spherical model. The map shows complete matching geometries and retains a drawn, pasted or picked reference when you pan.

## Experimental Overpass QL

The CLI, native server and standalone explorer use the Rust compiler and executor from `regol-overpass`. Live consumes its ordered output stream and applies the map’s feature, vertex and byte limits as it renders each result. To run a query saved from the editor in the CLI, pass the GOL and query file. For example, `regol overpass uk.gol --file turbines.ql -f ids` emits one JSON object per output statement. Add `--bbox WEST,SOUTH,EAST,NORTH` for queries using `{{bbox}}`.

Choose **Overpass QL** beside **Query workspace** to run a bounded query against the selected GOL. The editor keeps a draft and examples for each language. WASM and native mode use the same query engine.

```overpass
wr[leisure=park]({{bbox}});
map_to_area->.parks;
node[amenity=bench](area.parks)({{bbox}});
out count;
```

This counts benches inside the selected parks and the current viewport. Removing the last `({{bbox}})` searches the full extent of those parks.

| Operation | Supported syntax |
| --- | --- |
| Elements and tags | `node`, `way`, `rel` / `relation`, `nw`, `nr`, `wr`, `nwr`. Chain `[key]`, `[!key]`, `[key=value]`, `[key!=value]`, or value regexes such as `[name~"station",i]` and `[name!~"^Old"]`. |
| Search extent | `({{bbox}})`, `(south,west,north,east)`, `(poly:"lat lon lat lon lat lon")`, or a bounded input set. Settings include `[bbox:s,w,n,e]`, `[out:json]` and `[timeout:seconds]`. |
| Areas and distance | Look up an exact name with `area[name="England"]->.country;`. Convert a bounded selection with `map_to_area->.parks;` and filter with `(area.parks)`. For proximity, supply a point, a line through two or more latitude/longitude pairs, or a selected set such as `(around.tracks:150)`. Distances are in metres. |
| Set operations | Name a selection with `->.a`. Use `(.a; .b;);` for union, `(.a; - .b;);` for difference, and `nwr.a.b;` for element intersection. Union and difference can also combine area sets. Difference removes matching area objects. To exclude features inside a smaller area, subtract the feature selections. |
| Direct membership | `node(w.roads);` selects the nodes of ways. `way(bn.crossings);` selects ways containing those nodes. `way(r.routes);` selects way members of relations, and `node(r.routes:"stop");` filters by role. `rel(bn.stops);`, `rel(bw.roads);` and `rel(br.routes);` select parent relations. Omit the set name to use the default set. |
| Per-element filters | `(if:is_number(t["height"]) && number(t["height"]) >= 30)` filters candidates by their tags. Expressions accept quoted strings, numeric literals, comparisons, boolean operators and parentheses. |
| Loop over nodes | `foreach.stops->.stop { … }` binds a single node per iteration. Query named node sets with `node.stops(around.stop:100)->.near;`. Test `near.count(nodes)` against a nonnegative integer using `==`, `!=`, `<`, `<=`, `>` or `>=`. Join tests with `&&`. |
| Downward recursion | `>;` expands the current set. Use `.routes > ->.members;` for named input and output. Way inputs contribute their nodes. Relation inputs contribute direct nodes, direct ways and those ways’ nodes. |
| Output | `out geom;` emits shapes, `out center;` emits bounding-box centres and `out count;` gives totals by type. Emit at several points in a query or name a set with `.stops out count;`. `body` includes tags, `skel` omits them, `asc` orders by ID within type, and `qt` orders spatially within type. |

Mapped sets can supply an area filter or be counted directly. A mapped polygon relation counts as an area and a closed way counts as a way.

`node(w.roads)` needs a node record for every requested vertex. If the GOL stores a vertex only as coordinates, the query reports the affected way. In the reverse direction, `way(bn.crossings)` tests OSM node identity, so a different node at the same coordinates does not make a way match.

A missing tag evaluates to an empty string. Comparisons use numeric order when both values are recognised as numbers and text order otherwise. `number(t["height"])` reads a leading number such as `12` in `12 m`. `is_number(...)` checks whether conversion succeeds. Combine comparisons with `&&`, `||` or `!`.

Polygons can cross the antimeridian. For example, `node(poly:"-1 179 -1 -179 1 -179 1 179"); out;` searches a two-degree strip around 180° longitude. Holes in mapped areas follow the same wrapping rule. A ring encircling a pole selects the smaller side regardless of vertex order. Split it into smaller polygons if both sides cover exactly half the globe.

A single indexed window can count past the display limit without keeping a list of matched IDs. Counts that must merge overlapping streams support up to 750,000 distinct elements and report an error if that budget is exceeded.

For `around`, a closed way contributes its outline. The engine measures the distance to the shortest great-circle arc between consecutive vertices. A way or a direct way member of a relation can match with both endpoints outside the radius. Finding these ways can require extra index reads. An explicit bounding box also applies its own outline test.

For example, this selects drinking-water fountains within four metres of a line in Monaco. Coordinates are latitude, longitude, in the order the line visits them.

```overpass
node[amenity](around:4,43.7270832,7.41827,43.7270832,7.41849)
  (if:t["amenity"] == "drinking_water");
out;
```

Value regexes use Rust's regex engine and match substrings unless anchored with `^` or `$`. Unsupported constructs include regex backreferences, Turbo geocoding macros, transitive graph recursion and OSM edit history.

### Named areas

A named area searches the entire selected GOL. Its exact `name` can match several closed ways or polygon relations. Add filters such as `[boundary=administrative]` to refine the set, use it with `(area.country)`, or inspect its size with `.country out count;`. The GOL supplies the polygon geometry and tags.

The display cache keeps full features from up to six recent views of the active query, with a history budget of 100,000 result entries and 64 MiB of serialized results. Returning to an exact cached viewport can restore its list directly from the display cache. A different dataset, selector, spatial predicate or reference starts a fresh display cache. For a query with viewport-dependent spatial references, the new viewport replaces the previous displayed outputs together. Partial results are never used as complete cached views.

A result can contain up to 100,000 distinct features across all shown sets, 1,500,000 vertices and approximately 64 MiB of serialized features. Partial results show which limit was reached. Individual geometry and traversal limits surface as query errors. In static mode the explorer pauses before exceeding 256 MiB from the local UK file or 48 MiB from other sources. Choose **Continue** to allow another increment and resume the same query with its cached data, or **Cancel query** to stop. Reported query time excludes time spent waiting for this choice.
