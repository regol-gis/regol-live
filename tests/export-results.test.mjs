import assert from "node:assert/strict";
import test from "node:test";
import { resultFile } from "../web/export-results.js";

const shell = [
  [0, 0],
  [0, 4],
  [4, 4],
  [4, 0],
  [0, 0],
];
const hole = [
  [1, 1],
  [3, 1],
  [3, 3],
  [1, 3],
  [1, 1],
];
const polygon = { type: "Polygon", coordinates: [shell, hole] };
const name = 'Hall & "library" <館>,\nwest';
const feature = {
  id: "R71",
  tags: { name, osm_id: "local" },
  properties: { group: 1 },
  geometry: polygon,
};
const reference = {
  type: "GeometryCollection",
  geometries: [
    {
      type: "MultiPoint",
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    },
    {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    { type: "MultiPolygon", coordinates: [polygon.coordinates] },
  ],
};
const view = {
  features: [feature],
  show: ["geometry", "libraries"],
  geometry: reference,
  partial: true,
};

test("GeoJSON preserves typed IDs, tags and output sets, and orients rings without changing displayed data", async () => {
  const file = await resultFile("geojson", view);
  assert.equal(file.name, "regol-geometry-libraries-partial.geojson");
  const { features } = JSON.parse(await file.text());
  assert.equal(features.length, 2);
  assert.equal(features[0].id, "R71");
  assert.deepEqual(features[0].properties, {
    osm_id: "R71",
    query_set: "$libraries",
    "tag:name": name,
    "tag:osm_id": "local",
  });
  assert.deepEqual(features[0].geometry.coordinates, [
    [...shell].reverse(),
    [...hole].reverse(),
  ]);
  assert.deepEqual(shell[1], [0, 4]);
  assert.equal(features[1].geometry.type, "GeometryCollection");
  assert.deepEqual(features[1].properties, { query_set: "$geometry" });
});

test("KML uses inner rings, mixed geometries and XML-escaped attributes", async () => {
  const text = await (await resultFile("kml", view)).text();
  assert.equal(text.match(/<Placemark>/g).length, 2);
  assert.match(text, /<innerBoundaryIs><LinearRing>/);
  assert.match(
    text,
    /<MultiGeometry><MultiGeometry><Point><coordinates>1,2<\/coordinates>/,
  );
  assert.match(text, /Hall &amp; &quot;library&quot; &lt;館&gt;,\nwest/);
  assert.match(text, /<Data name="tag:osm_id"><value>local<\/value><\/Data>/);
});

test("CSV has GIS-readable WKT and lossless tags in fixed columns", async () => {
  const text = await (await resultFile("csv", view)).text();
  const [header, first, second] = text.trimEnd().split("\r\n");
  assert.equal(header, "WKT,osm_id,query_set,tags_json");
  assert.match(
    first,
    /^"POLYGON \(\(0 0, 0 4, 4 4, 4 0, 0 0\), \(1 1, 3 1, 3 3, 1 3, 1 1\)\)","R71","\$libraries",/,
  );
  const tags = first.slice(
    first.indexOf(',"$libraries",') + ',"$libraries",'.length,
  );
  assert.deepEqual(
    JSON.parse(tags.slice(1, -1).replaceAll('""', '"')),
    feature.tags,
  );
  assert.match(
    second,
    /^"GEOMETRYCOLLECTION \(MULTIPOINT \(\(1 2\), \(3 4\)\), MULTILINESTRING \(\(0 0, 1 1\)\), MULTIPOLYGON /,
  );
  assert(second.endsWith('","","$geometry","{}"'));
});
