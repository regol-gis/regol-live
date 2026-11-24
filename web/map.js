import { htmlMap, svgMap } from "./export-map.js";
import { downloadOutline, windows } from "./viewport.js";
import { isBuilding, matchBuildingVolumes } from "./building-volumes.js";

const initialPitch = 0;
const setColors = [
  "#81011c",
  "#01665f",
  "#574196",
  "#945400",
  "#186299",
  "#88436e",
];
export const setColor = (index) => setColors[index % setColors.length];
const groupColor = [
  "at",
  ["%", ["number", ["get", "group"], 0], setColors.length],
  ["literal", setColors],
];
const overlays = [
  {
    source: "matches",
    prefix: "match",
    color: ["to-color", groupColor],
    fill: 0.29,
    radius: 6,
    lineWidth: 3,
    outlineWidth: 1.5,
  },
  {
    source: "selected",
    prefix: "selected",
    color: "#01665f",
    fill: 0.4,
    radius: 8,
    lineWidth: 5,
    outlineWidth: 3,
  },
  {
    source: "reference",
    prefix: "ref",
    color: "#986700",
    fill: 0.22,
    radius: 7,
    lineWidth: 5,
    outlineWidth: 3,
  },
];
const empty = () => ({ type: "FeatureCollection", features: [] });
const layers = ["match-point", "match-line", "match-outline", "match-fill"];
const sourceData = new Map([
  ["downloaded-area", empty()],
  ["reference", empty()],
  ["selected", empty()],
]);
let map;
let matches = new Map();
const buildings = new Map();
let buildingLayer,
  volumesDirty = false,
  volumeTimer;

function mapFeature({ id, properties, geometry }) {
  return { type: "Feature", id, properties, geometry };
}

function refreshVolumes() {
  const source = map.getSource("match-volumes");
  if (!source || !volumesDirty) return;
  volumesDirty = false;
  const tiles =
    buildings.size && map.getZoom() >= buildingLayer.minzoom
      ? map
          .querySourceFeatures(buildingLayer.source, {
            sourceLayer: buildingLayer["source-layer"],
            filter: buildingLayer.filter,
          })
          .filter((feature) => feature.tile.z >= buildingLayer.minzoom)
      : [];
  source.setData(
    tiles.length ? matchBuildingVolumes(buildings, tiles) : empty(),
  );
}

function scheduleVolumes() {
  if (!buildingLayer || !buildings.size) return;
  volumesDirty = true;
  clearTimeout(volumeTimer);
  // Coalesce arriving tiles without waiting for unrelated glyphs or other sources.
  volumeTimer = setTimeout(refreshVolumes, 80);
}

function drawLayers({
  source,
  prefix,
  color,
  fill,
  radius,
  lineWidth,
  outlineWidth,
}) {
  for (const [id, layerType, geometry, paint] of [
    [
      "fill",
      "fill",
      "Polygon",
      {
        "fill-color": color,
        "fill-opacity": fill,
        "fill-outline-color": color,
      },
    ],
    [
      "outline",
      "line",
      "Polygon",
      { "line-color": color, "line-width": outlineWidth },
    ],
    [
      "line",
      "line",
      "LineString",
      { "line-color": color, "line-width": lineWidth },
    ],
    [
      "point",
      "circle",
      "Point",
      {
        "circle-radius": radius,
        "circle-color": color,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
      },
    ],
  ]) {
    map.addLayer({
      id: prefix + "-" + id,
      source,
      type: layerType,
      filter: ["==", ["geometry-type"], geometry],
      paint,
    });
  }
}

function enableMiddleButtonTilt(map, onFinish) {
  const canvas = map.getCanvas();
  canvas.addEventListener("pointerdown", (start) => {
    if (start.pointerType !== "mouse" || start.button !== 1) return;
    start.preventDefault(); // Suppress the browser's middle-button autoscroll.
    canvas.setPointerCapture(start.pointerId);
    const drag = new AbortController();
    const options = { signal: drag.signal };
    let lastY = start.clientY;
    let changed = false;

    function finish() {
      drag.abort();
      if (canvas.hasPointerCapture(start.pointerId))
        canvas.releasePointerCapture(start.pointerId);
      if (changed) onFinish();
    }
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== start.pointerId) return;
        if (!(event.buttons & 4)) return finish();
        // Match MapLibre's vertical pitch sensitivity of half a degree per pixel.
        const pitch = Math.max(
          map.getMinPitch(),
          Math.min(
            map.getMaxPitch(),
            map.getPitch() + (lastY - event.clientY) * 0.5,
          ),
        );
        lastY = event.clientY;
        if (pitch !== map.getPitch()) {
          changed = true;
          map.setPitch(pitch, { middleButtonTilt: true });
        }
      },
      options,
    );
    canvas.addEventListener(
      "lostpointercapture",
      (event) => {
        if (event.pointerId === start.pointerId) finish();
      },
      options,
    );
    window.addEventListener("blur", finish, options);
  });
  canvas.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
}

export function initMap({
  initialView,
  onMoveStart,
  onReady,
  onMove,
  onClick,
  onMapError,
}) {
  map = new maplibregl.Map({
    container: "map",
    // Liberty includes OpenFreeMap's building-height extrusion layer from zoom 14.
    style: "https://tiles.openfreemap.org/styles/liberty",
    pitch: initialPitch,
    ...initialView,
    maxPitch: 60,
    attributionControl: false,
  });
  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    "top-right",
  );
  map.addControl(
    new maplibregl.ScaleControl({ unit: "metric" }),
    "bottom-left",
  );
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
    }),
    "bottom-right",
  );
  map.on("style.load", () => {
    map.addSource("matches", {
      type: "geojson",
      promoteId: "fid",
      data: {
        type: "FeatureCollection",
        features: Array.from(matches.values(), mapFeature),
      },
    });
    for (const [key, data] of sourceData)
      map.addSource(key, { type: "geojson", data, promoteId: "fid" });
    const styleLayers = map.getStyle().layers;
    const index = styleLayers.findIndex((layer) => layer.id === "building-3d");
    buildingLayer = styleLayers[index];
    if (buildingLayer) {
      map.addSource("match-volumes", {
        type: "geojson",
        maxzoom: 14,
        tolerance: 0,
        data: empty(),
      });
      map.addLayer(
        {
          id: "match-volume",
          type: "fill-extrusion",
          source: "match-volumes",
          minzoom: buildingLayer.minzoom,
          paint: {
            "fill-extrusion-height":
              buildingLayer.paint["fill-extrusion-height"],
            "fill-extrusion-base": buildingLayer.paint["fill-extrusion-base"],
            "fill-extrusion-color": ["to-color", groupColor],
          },
        },
        styleLayers[index + 1]?.id,
      );
      volumesDirty = buildings.size > 0;
    }
    for (const [id, paint] of [
      ["downloaded-halo", { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.85 }],
      ["downloaded-outline", { "line-color": "#17637a", "line-width": 3, "line-dasharray": [3, 2] }],
    ]) map.addLayer({ id, source: "downloaded-area", type: "line", paint });
    overlays.forEach(drawLayers);
    onReady();
  });
  map.on("sourcedata", (e) => {
    if (
      e.sourceId === buildingLayer?.source &&
      (e.tile || e.sourceDataType === "content")
    )
      scheduleVolumes();
  });
  map.on("idle", refreshVolumes);
  function finishMove(event) {
    scheduleVolumes();
    onMove(event);
  }
  enableMiddleButtonTilt(map, finishMove);
  map.on("movestart", (event) => {
    if (!event.datasetView) onMoveStart();
  });
  map.on("moveend", (event) => {
    // setPitch emits moveend at each step. Run the viewport query on release.
    if (!event.middleButtonTilt) finishMove(event);
  });
  map.on("click", (e) => {
    const hits = map.getLayer("match-point")
      ? map.queryRenderedFeatures(e.point, {
          layers: buildingLayer ? [...layers, "match-volume"] : layers,
        })
      : [];
    // A feature can appear in multiple layers, tiles or wrapped world copies.
    const ids = [...new Set(hits.map((hit) => hit.properties.fid))];
    onClick([e.lngLat.wrap().lng, e.lngLat.lat], ids);
  });
  let fallback = false;
  map.on("error", () => {
    if (!fallback && !map.getStyle()?.layers) {
      fallback = true;
      onMapError("Basemap unavailable");
      map.setStyle({
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#f8f4f0" },
          },
        ],
      });
    }
  });
}
function set(key, data) {
  sourceData.set(key, data);
  map?.getSource(key)?.setData(data);
}
export function showResults(next) {
  const add = [],
    remove = [];
  for (const [id, f] of next) {
    if (matches.get(id) === f) continue;
    add.push(mapFeature(f));
    if (isBuilding(f)) {
      buildings.set(id, f);
      volumesDirty = true;
    } else if (buildings.delete(id)) volumesDirty = true;
  }
  for (const id of matches.keys()) {
    if (next.has(id)) continue;
    remove.push(id);
    if (buildings.delete(id)) volumesDirty = true;
  }
  matches = next;
  if (add.length || remove.length)
    map?.getSource("matches")?.updateData({ add, remove });
  if (map) refreshVolumes();
}
export function showGeometry(key, geometry) {
  set(key, geometry ? { type: "Feature", properties: {}, geometry } : empty());
}
export function showDownloadedArea(bounds) {
  showGeometry("downloaded-area", downloadOutline(bounds));
}
export function queryWindows() {
  const b = map.getBounds();
  return windows(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
}
export function camera() {
  const p = map.getCenter().wrap();
  return { lng: p.lng, lat: p.lat, zoom: map.getZoom() };
}
export function setDatasetView(view) {
  map.jumpTo({ pitch: initialPitch, bearing: 0, ...view }, { datasetView: true });
}
export function drawingCursor(active) {
  map.getCanvas().style.cursor = active ? "crosshair" : "";
}

export function mapFile(format, name) {
  if (format === "html") {
    const center = map.getCenter().toArray();
    const camera = {
      center,
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
    const style = map.getStyle();
    style.sources.matches.data = {
      type: "FeatureCollection",
      features: Array.from(matches.values(), mapFeature),
    };
    for (const [key, data] of sourceData) style.sources[key].data = data;
    // The download belongs to this tab. Export just the query and reference layers.
    style.layers = style.layers.filter(layer => layer.source !== "downloaded-area");
    delete style.sources["downloaded-area"];
    return htmlMap({ style, camera }, name);
  }
  return svgMap(
    map,
    () => {
      const visible = new Set(
        map.queryRenderedFeatures({ layers }).map((f) => f.properties.fid),
      );
      const features = [...visible]
        .map((id) => matches.get(id))
        .filter(Boolean);
      return overlays.map((layer) => {
        if (layer.source === "matches")
          return {
            ...layer,
            features,
            ink: (f) => setColor(f.properties.group),
          };
        const data = sourceData.get(layer.source);
        return {
          ...layer,
          features: data.type === "Feature" ? [data] : data.features,
          ink: () => layer.color,
        };
      });
    },
    name,
  );
}
