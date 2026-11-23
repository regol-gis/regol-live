// OpenFreeMap packs many disjoint buildings of the same height into one MVT
// MultiPolygon. Match its individual polygons, preserving their holes and bases.
function polygons(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "GeometryCollection")
    return geometry.geometries.flatMap(polygons);
  return [];
}

function hasBuildingTag(value) {
  return Boolean(value) && !/^(no|none)$/i.test(value);
}

export function isBuilding({ tags, geometry }) {
  if (
    !["Polygon", "MultiPolygon", "GeometryCollection"].includes(geometry.type)
  )
    return false;
  return (
    tags.location !== "underground" &&
    tags.man_made !== "bridge" &&
    (hasBuildingTag(tags.building) ||
      hasBuildingTag(tags["building:part"]) ||
      (!tags.building &&
        (tags.type === "building" ||
          ["terminal", "hangar"].includes(tags.aeroway))))
  );
}

function bounds(ring) {
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  for (const [x, y] of ring) {
    west = Math.min(west, x);
    south = Math.min(south, y);
    east = Math.max(east, x);
    north = Math.max(north, y);
  }
  return { west, south, east, north };
}

// Crossings of a horizontal scan line alternate between filled spans and gaps,
// including courtyard holes. Sample inside the roof even when it is concave.
function crossings(rings, y) {
  const xs = [];
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [x1, y1] = ring[i - 1],
        [x2, y2] = ring[i];
      if (y1 > y !== y2 > y) xs.push(x1 + (x2 - x1) * ((y - y1) / (y2 - y1)));
    }
  }
  return xs;
}

function roofSamples(rings, box) {
  const points = [];
  for (const fraction of [0.25, 0.5, 0.75]) {
    const y = box.south + (box.north - box.south) * fraction;
    const xs = crossings(rings, y).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i += 2)
      if (xs[i] > xs[i - 1]) points.push([(xs[i - 1] + xs[i]) / 2, y]);
  }
  return points;
}

function osmId(tileId) {
  // Planetiler marks ways with suffix 2 and relations with 3. Merged IDs
  // have suffix 0 and cannot identify an individual building.
  if (!Number.isSafeInteger(tileId)) return;
  const suffix = tileId % 10;
  if (suffix === 2 || suffix === 3)
    return (suffix === 2 ? "W" : "R") + Math.floor(tileId / 10);
}

// For stacked building parts the footprint alone can be identical. Compare
// the tagged elevations to Planetiler's integer roof and base when available.
function partElevation(length, levels, round) {
  if (length) {
    const m = /^(-?\d+(?:\.\d+)?)\s*(m|ft)?$/i.exec(length);
    return m
      ? round(Number(m[1]) * (m[2]?.toLowerCase() === "ft" ? 0.3048 : 1))
      : undefined;
  }
  if (levels && Number.isFinite(Number(levels)))
    return round(Number(levels) * 3.66);
}

function lowerBound(parts, x) {
  let lo = 0,
    hi = parts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (parts[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function matchBuildingVolumes(buildings, tiles) {
  const volumes = [];
  const parts = [];
  const byOsmId = new Map();
  for (const match of buildings.values()) {
    const matches = byOsmId.get(match.id);
    if (matches) matches.push(match);
    else byOsmId.set(match.id, [match]);
  }
  function volume(rings, properties, match) {
    volumes.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: rings },
      properties: {
        ...match.properties,
        render_height: properties.render_height,
        render_min_height: properties.render_min_height,
      },
    });
  }
  for (const tile of tiles) {
    const id = osmId(tile.id);
    const matches = byOsmId.get(id);
    for (const rings of polygons(tile.geometry)) {
      if (matches) {
        for (const match of matches) volume(rings, tile.properties, match);
        continue;
      }
      const box = bounds(rings[0]);
      parts.push({
        id,
        rings,
        properties: tile.properties,
        box,
        x: (box.west + box.east) / 2,
      });
    }
  }
  // Look up only roofs in the longitude range of each result footprint.
  parts.sort((a, b) => a.x - b.x);
  // Two grid units at OpenFreeMap's native building zoom (14, extent 4096).
  const tolerance = (2 * 360) / (2 ** 14 * 4096);
  for (const match of buildings.values()) {
    const tags = match.tags;
    const isPart = hasBuildingTag(tags["building:part"]);
    const height = isPart
      ? partElevation(
          tags.height || tags["building:height"],
          tags.levels || tags["building:levels"],
          Math.ceil,
        )
      : undefined;
    const base = isPart
      ? partElevation(
          tags.min_height || tags["building:min_height"],
          tags.min_level || tags["building:min_level"],
          Math.floor,
        )
      : undefined;
    for (const rings of polygons(match.geometry)) {
      const { west, south, east, north } = bounds(rings[0]);
      const area = (east - west) * (north - south);
      for (let i = lowerBound(parts, west - tolerance); i < parts.length; i++) {
        const part = parts[i],
          box = part.box;
        if (part.x > east + tolerance) break;
        if (
          isPart &&
          (part.id ||
            (height !== undefined &&
              height !== part.properties.render_height) ||
            (base !== undefined && base !== part.properties.render_min_height))
        )
          continue;
        if (
          box.west < west - tolerance ||
          box.east > east + tolerance ||
          box.south < south - tolerance ||
          box.north > north + tolerance ||
          area >= (part.matchArea ?? Infinity)
        )
          continue;
        part.samples ??= roofSamples(part.rings, box);
        if (
          part.samples.length &&
          part.samples.every(
            ([x, y]) =>
              crossings(rings, y).filter((crossing) => crossing > x).length % 2,
          )
        ) {
          // Prefer a matched part over its enclosing matched building.
          part.match = match;
          part.matchArea = area;
        }
      }
    }
  }
  for (const part of parts)
    if (part.match) volume(part.rings, part.properties, part.match);
  return { type: "FeatureCollection", features: volumes };
}
