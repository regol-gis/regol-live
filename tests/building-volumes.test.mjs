import assert from "node:assert/strict";
import test from "node:test";
import { isBuilding, matchBuildingVolumes } from "../web/building-volumes.js";

function ring(x, y, size) {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}
function building(id, rings, group = 0, tags = { building: "yes" }) {
  return {
    id,
    geometry: { type: "Polygon", coordinates: rings },
    properties: { fid: id, group },
    tags,
  };
}
function tile(id, polygons, height, base = 0) {
  return {
    id,
    geometry: { type: "MultiPolygon", coordinates: polygons },
    properties: { render_height: height, render_min_height: base },
  };
}
function highlight(matches, tiles) {
  return matchBuildingVolumes(new Map(matches.map((f) => [f.id, f])), tiles)
    .features;
}

test("a merged tile colours only the roofs of matched buildings, including their separate parts", () => {
  const outer = ring(0, 0, 10),
    courtyard = ring(2, 2, 6);
  const parent = building("W30", [outer, courtyard]);
  const eastWing = [ring(8, 2, 2)],
    westWing = [ring(0, 2, 2)];
  const part = building("W31", eastWing, 2, { "building:part": "yes" });
  const unmatched = [ring(10, 0, 10)],
    inCourtyard = [ring(4, 4, 1)];
  const features = highlight(
    [parent, part],
    [
      tile(300, [westWing, eastWing, unmatched, inCourtyard], 22, 3),
      tile(400, [[outer, courtyard], unmatched], 8),
    ],
  );
  assert.deepEqual(
    features.map((f) => [
      f.geometry.coordinates,
      f.properties.fid,
      f.properties.group,
      f.properties.render_min_height,
      f.properties.render_height,
    ]),
    [
      [westWing, "W30", 0, 3, 22],
      [[outer, courtyard], "W30", 0, 0, 8],
      [eastWing, "W31", 2, 3, 22],
    ],
  );
});

test("typed tile IDs distinguish ways and relations even when a footprint has moved", () => {
  const same = [ring(0, 0, 1)],
    moved = [ring(3, 3, 1)];
  const volumes = highlight(
    [building("W80", moved), building("R80", moved, 1)],
    [tile(803, [same], 17), tile(802, [same], 5)],
  );
  assert.deepEqual(
    volumes.map((f) => f.properties.fid),
    ["R80", "W80"],
  );
});

test("stacked parts of a merged tile keep their own roof and base", () => {
  const roof = [ring(2, 2, 1)];
  const part = building("W10", roof, 0, {
    "building:part": "yes",
    height: "12.5 m",
    "building:min_level": "2",
  });
  const volumes = highlight(
    [part],
    [
      tile(990, [roof], 13, 7),
      tile(880, [roof], 20, 7),
      tile(770, [roof], 13, 0),
      tile(662, [roof], 13, 7),
    ],
  );
  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].properties.render_min_height, 7);
});

test("building:part=no marks a whole building whose rendered parts can have separate IDs and heights", () => {
  // Two Fifty One (W511760789) carries these tags on its outline.
  const tower = building("W511760789", [ring(0, 0, 3)], 0, {
    building: "apartments",
    "building:part": "no",
    height: "125",
  });
  assert(isBuilding(tower));
  const roofs = highlight(
    [tower],
    [
      tile(102, [[ring(0, 0, 1)]], 125),
      tile(200, [[ring(1, 1, 1)], [ring(4, 0, 1)]], 80),
    ],
  );
  assert.deepEqual(
    roofs.map((f) => [f.properties.fid, f.properties.render_height]),
    [
      [tower.id, 125],
      [tower.id, 80],
    ],
  );
  assert(
    isBuilding({ ...tower, tags: { building: "no", "building:part": "roof" } }),
  );
  assert(!isBuilding({ ...tower, tags: { "building:part": "no" } }));
});

test("only above-ground building areas are candidates for volume highlighting", () => {
  const polygon = building("W10", [ring(0, 0, 1)]);
  assert(isBuilding(polygon));
  assert(isBuilding({ ...polygon, tags: { "building:part": "roof" } }));
  assert(isBuilding({ ...polygon, tags: { aeroway: "hangar" } }));
  assert(
    !isBuilding({
      ...polygon,
      geometry: { type: "Point", coordinates: [0, 0] },
    }),
  );
  assert(!isBuilding({ ...polygon, tags: { leisure: "park" } }));
  assert(!isBuilding({ ...polygon, tags: { building: "no" } }));
  assert(
    !isBuilding({
      ...polygon,
      tags: { building: "yes", location: "underground" },
    }),
  );
});

test("a building relation can contain polygonal parts alongside other member geometry", () => {
  const wing = [ring(0, 0, 3)];
  const relation = building("R123", [], 1, { type: "building" });
  relation.geometry = {
    type: "GeometryCollection",
    geometries: [
      { type: "MultiPolygon", coordinates: [wing] },
      { type: "Point", coordinates: [0, 0] },
    ],
  };
  assert(isBuilding(relation));
  const volumes = highlight(
    [relation],
    [tile(550, [wing, [ring(4, 0, 1)]], 14)],
  );
  assert.deepEqual(
    volumes.map((f) => f.properties.fid),
    ["R123"],
  );
});
