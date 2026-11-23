// GOL rings retain their source winding. GeoJSON and KML use counterclockwise
// exteriors and clockwise holes. Unwrap each longitude step at the date line.
function orientPolygon(rings) {
  return rings.map((ring, index) => {
    let area = 0;
    for (let i = 1; i < ring.length; i++) {
      const [x, y] = ring[i];
      const [px, py] = ring[i - 1];
      let dx = x - px;
      if (dx > 180) dx -= 360;
      if (dx < -180) dx += 360;
      area -= dx * (y + py - 2 * ring[0][1]);
    }
    const exterior = index === 0;
    const clockwise = area < 0;
    return area !== 0 && clockwise === exterior ? [...ring].reverse() : ring;
  });
}

function oriented(g) {
  switch (g.type) {
    case "Polygon":
      return { type: g.type, coordinates: orientPolygon(g.coordinates) };
    case "MultiPolygon":
      return { type: g.type, coordinates: g.coordinates.map(orientPolygon) };
    case "GeometryCollection":
      return { type: g.type, geometries: g.geometries.map(oriented) };
    default:
      return g;
  }
}

function attributes(id, set, tags) {
  const values = { query_set: set };
  if (id) values.osm_id = id;
  // Keep OSM keys as separate GIS fields, even when a tag is named osm_id.
  for (const [key, value] of Object.entries(tags)) values["tag:" + key] = value;
  return values;
}

function geojson(id, set, tags, geometry, featureId = id) {
  return JSON.stringify({
    type: "Feature",
    id: featureId ?? undefined,
    properties: attributes(id, set, tags),
    geometry: oriented(geometry),
  });
}

const xmlEscapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function xml(text) {
  return text
    .replace(
      /[^\u{9}\u{a}\u{d}\u{20}-\u{d7ff}\u{e000}-\u{fffd}\u{10000}-\u{10ffff}]/gu,
      "\uFFFD",
    )
    .replace(/[&<>"]/g, (ch) => xmlEscapes[ch]);
}

function kmlGeometry(g) {
  const coords = (line) => line.map((p) => p.join(",")).join(" ");
  const c = g.coordinates;
  switch (g.type) {
    case "Point":
      return `<Point><coordinates>${c.join(",")}</coordinates></Point>`;
    case "LineString":
      return `<LineString><coordinates>${coords(c)}</coordinates></LineString>`;
    case "Polygon": {
      const rings = c.map((ring, i) => {
        const boundary = i ? "innerBoundaryIs" : "outerBoundaryIs";
        return `<${boundary}><LinearRing><coordinates>${coords(ring)}</coordinates></LinearRing></${boundary}>`;
      });
      return `<Polygon>${rings.join("")}</Polygon>`;
    }
    case "GeometryCollection":
      return `<MultiGeometry>${g.geometries.map(kmlGeometry).join("")}</MultiGeometry>`;
    default: {
      const type = g.type.slice(5); // MultiPoint, MultiLineString, MultiPolygon
      const parts = c.map((part) => kmlGeometry({ type, coordinates: part }));
      return `<MultiGeometry>${parts.join("")}</MultiGeometry>`;
    }
  }
}

function kml(id, set, tags, geometry) {
  const data = Object.entries(attributes(id, set, tags))
    .map(
      ([key, value]) =>
        `<Data name="${xml(key)}"><value>${xml(value)}</value></Data>`,
    )
    .join("");
  const name = xml(tags.name || id || set);
  return `<Placemark><name>${name}</name><ExtendedData>${data}</ExtendedData>${kmlGeometry(oriented(geometry))}</Placemark>`;
}

function wkt(g) {
  const type = g.type.toUpperCase();
  const parts = g.type === "GeometryCollection" ? g.geometries : g.coordinates;
  if (!parts.length) return type + " EMPTY";
  function group(items, write) {
    return items.length ? "(" + items.map(write).join(", ") + ")" : "EMPTY";
  }
  const point = (p) => p.join(" ");
  const line = (l) => group(l, point);
  const polygon = (rings) => group(rings, line);
  switch (g.type) {
    case "Point":
      return type + " (" + point(parts) + ")";
    case "MultiPoint":
      return type + " " + group(parts, (p) => "(" + point(p) + ")");
    case "LineString":
      return type + " " + line(parts);
    case "Polygon":
    case "MultiLineString":
      return type + " " + polygon(parts);
    case "MultiPolygon":
      return type + " " + group(parts, polygon);
    case "GeometryCollection":
      return type + " " + group(parts, wkt);
  }
}

function csv(id, set, tags, geometry) {
  return [wkt(geometry), id ?? "", set, JSON.stringify(tags)]
    .map((value) => '"' + value.replaceAll('"', '""') + '"')
    .join(",");
}

const formats = {
  geojson: {
    mime: "application/geo+json",
    header: '{"type":"FeatureCollection","features":[',
    record: geojson,
    separator: ",\n",
    footer: "]}\n",
  },
  kml: {
    mime: "application/vnd.google-earth.kml+xml",
    header:
      '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n',
    record: kml,
    separator: "\n",
    footer: "\n</Document></kml>\n",
  },
  csv: {
    mime: "text/csv;charset=utf-8",
    header: "WKT,osm_id,query_set,tags_json\r\n",
    record: csv,
    separator: "\r\n",
    footer: "\r\n",
  },
};

export async function resultFile(
  format,
  { features, show, geometry, partial, setPrefix = "$" },
) {
  const { mime, header, record, separator, footer } = formats[format];
  const chunks = [];
  let batch = header;
  let nextYield = performance.now() + 30;
  for (const [index, f] of features.entries()) {
    if (index) batch += separator;
    const featureId = show.length > 1 ? f.properties.fid : f.id;
    batch += record(f.id, setPrefix + show[f.properties.group], f.tags, f.geometry, featureId);
    if (batch.length >= 256 * 1024) {
      chunks.push(new Blob([batch]));
      batch = "";
    }
    if (performance.now() >= nextYield) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      nextYield = performance.now() + 30;
    }
  }
  if (geometry) {
    if (features.length) batch += separator;
    batch += record(null, "$geometry", {}, geometry);
  }
  chunks.push(batch, footer);
  const name =
    "regol-" +
    show.join("-").slice(0, 80) +
    (partial ? "-partial" : "") +
    "." +
    format;
  return new File(chunks, name, { type: mime });
}
