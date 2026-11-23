import test from "node:test";
import assert from "node:assert/strict";
import { DisplayCache } from "../web/display-cache.js";

const west = [[-2, 0, 0, 1]],
  east = [[-1, 0, 1, 1]];
const query = {
  sets: [{ name: "areas", source: "a", filters: [] }],
  show: ["areas"],
};
const spatialQuery = (predicate, reference, meters) => ({
  ...query,
  sets: [
    { name: "parks", source: "a[leisure=park]", filters: [] },
    { ...query.sets[0], filters: [{ predicate, reference, meters }] },
  ],
});
const result = (ids, extra = {}) => ({
  features: ids.map((id) => ({ id })),
  resultBytes: 100,
  snapshot: "v1",
  ...extra,
});

test("pans retain canonical displayed features and restore exact viewport membership", () => {
  const cache = new DisplayCache("uk", query);
  const left = cache.store(
    west,
    result(["R1", "R2"], { skippedGeometries: 3 }),
  );
  const right = cache.store(east, result(["R2", "R3"]));
  assert.deepEqual([...cache.byId.keys()].sort(), ["R1", "R2", "R3"]);
  assert.equal(left.features[1], right.features[0]);
  assert.equal(cache.recall(west), left);
  assert.equal(cache.recall(east), right);
  assert.equal(cache.recall(west).skippedGeometries, 3);
  assert.equal(
    cache.recall([
      [179, 0, 180, 1],
      [-180, 0, -178, 1],
    ]),
    null,
  );
  assert(!cache.matches("planet", query));
  assert(
    !cache.matches("uk", {
      ...query,
      sets: [{ ...query.sets[0], source: "w" }],
    }),
  );
  assert(cache.matches("uk", { ...query, windows: east }));
  cache.store(east, result(["R2"], { snapshot: "v2" }));
  assert.equal(cache.recall(west), null);
  assert.notEqual(cache.byId.get("R2"), left.features[1]);
});

test("viewport-dependent predicates replace prior matches and partial views are never complete hits", () => {
  const spatial = spatialQuery("disjoint", "parks");
  const cache = new DisplayCache("uk", spatial);
  cache.store(west, result(["R1", "R2"]));
  cache.store(east, result(["R2"]));
  assert.deepEqual([...cache.byId.keys()], ["R2"]);
  assert.equal(cache.recall(east), null);
  assert(!cache.matches("uk", spatialQuery("within", "parks")));
  assert(!cache.matches("uk", { ...spatial, show: ["parks", "areas"] }));
  const geometry = { type: "Point", coordinates: [0, 0] };
  const drawn = { ...spatialQuery("within", "geometry"), geometry };
  const fixed = new DisplayCache("uk", drawn);
  assert(!fixed.matches("uk", { ...drawn, geometry: { ...geometry } }));
  fixed.store(west, result(["R1"]));
  fixed.store(east, result(["R2"], { limited: "vertex" }));
  assert.deepEqual([...fixed.byId.keys()], ["R2"]);
  assert.equal(fixed.recall(east), null);
  fixed.store(west, result([]));
  assert.deepEqual(fixed.recall(west).features, []);
});

test("eviction respects recency, the view count and the decoded payload budget", () => {
  const cache = new DisplayCache("uk", query);
  const window = (i) => [[i, 0, i + 1, 1]];
  for (let i = 0; i < 6; i++) cache.store(window(i), result([String(i)]));
  cache.recall(window(0));
  cache.store(window(6), result(["6"]));
  assert.equal(cache.recall(window(1)), null);
  assert(cache.byId.has("0"));
  cache.store(east, result(["R3"], { resultBytes: 64 * 1024 * 1024 }));
  assert.deepEqual([...cache.byId.keys()], ["R3"]);
});

test("Overpass counts belong to a viewport and set operations discard stale map matches", () => {
  const cache = new DisplayCache("uk", query);
  const counts = { nodes: 12, ways: 1, relations: 0, total: 13 };
  cache.store(west, result([], { counts }));
  cache.store(east, result([], { counts: { ...counts, nodes: 0, total: 1 } }));
  assert.deepEqual(cache.recall(west).counts, counts);
  for (const operation of [
    { difference: ["a", "b"] },
    { intersect: ["b"] },
    { membership: { direction: "bn", reference: "a" } },
    { recurse: "a" },
    { overpass: { area: "a" } },
    { overpass: { around: { reference: "a", meters: 150 } } },
  ]) {
    const views = new DisplayCache("uk", { ...query, sets: [operation] });
    views.store(west, result(["N1"]));
    views.store(east, result(["N2"]));
    assert.deepEqual([...views.byId.keys()], ["N2"]);
  }
});

test("repeated output rows keep their own map identity and viewport summaries", () => {
  const outputs = [
    { name: "a", mode: "geom" },
    { name: "a", mode: "count", counts: { nodes: 0, ways: 1, relations: 0, total: 1 } },
    { name: "a", mode: "center" },
  ];
  const features = [0, 2].map((group) => ({
    id: "W10",
    properties: { fid: group + ":W10", group },
  }));
  const cache = new DisplayCache("uk", { ...query, outputs });
  const left = cache.store(west, result([], { features, outputs }));
  const right = cache.store(east, result([], {
    features: features.map((feature) => ({ ...feature })),
    outputs: outputs.map((output) => ({ ...output })),
  }));
  assert.deepEqual([...cache.byId.keys()], ["0:W10", "2:W10"]);
  assert.equal(left.features[0], right.features[0]);
  assert.equal(left.features[1], right.features[1]);
  assert.deepEqual(cache.recall(west).outputs, outputs);
});
