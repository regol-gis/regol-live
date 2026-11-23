// The exported document runs this function with only its embedded MapLibre runtime.
function openSavedMap() {
  const scene = JSON.parse(document.getElementById("scene").textContent);
  const map = new maplibregl.Map({
    container: "map",
    style: scene.style,
    ...scene.camera,
    maxPitch: 60,
    attributionControl: false,
  });
  map.addControl(
    new maplibregl.AttributionControl({
      customAttribution:
        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
    }),
  );
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
  map.addControl(
    new maplibregl.ScaleControl({ unit: "metric" }),
    "bottom-left",
  );
  map.on("click", (event) => {
    const layers = [
      "match-point",
      "match-line",
      "match-fill",
      "match-volume",
    ].filter((id) => map.getLayer(id));
    if (!layers.length) return;
    const [hit] = map.queryRenderedFeatures(event.point, { layers });
    if (!hit) return;
    const props = hit.properties;
    const label = document.createElement("strong");
    label.textContent = [props.name, props.fid].filter(Boolean).join(" · ");
    new maplibregl.Popup()
      .setLngLat(event.lngLat)
      .setDOMContent(label)
      .addTo(map);
  });
}

async function asset(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw Error("Could not load the map export asset " + path);
  return response.text();
}

export async function htmlMap(scene, name) {
  const [js, css, license] = await Promise.all(
    [
      "./vendor/maplibre-gl.js",
      "./vendor/maplibre-gl.css",
      "./vendor/LICENSE.txt",
    ].map(asset),
  );
  // Raw-text elements end at an HTML closing tag, even inside JSON strings.
  const data = JSON.stringify(scene).replaceAll("<", "\\u003c");
  return new File(
    [
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Regol Live map</title><style>',
      css,
      '\nhtml,body,#map{margin:0;width:100%;height:100%}</style></head><body><main id="map" aria-label="Interactive query map"></main>',
      '<script type="application/json" id="scene">',
      data,
      "</script>",
      '<script type="text/plain" id="maplibre-license">',
      license,
      "</script>",
      "<script>",
      js.replace(/<\/script/gi, "<\\/script"),
      "\n</script><script>(",
      openSavedMap.toString(),
      ")();</script></body></html>",
    ],
    name,
    { type: "text/html;charset=utf-8" },
  );
}

const escapeXml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// Clip in camera space before dividing by depth. This keeps distant paths
// crossing a pitched viewport from folding back over the camera.
function interpolate(a, b, t) {
  return a.map((v, i) => v + t * (b[i] - v));
}
function clipRing(ring, planes) {
  for (const plane of planes) {
    if (!ring.length) break;
    const next = [];
    let a = ring.at(-1),
      from = plane(a);
    for (const b of ring) {
      const to = plane(b);
      const enters = from < 0 && to >= 0;
      const exits = from >= 0 && to < 0;
      if (enters || exits) next.push(interpolate(a, b, from / (from - to)));
      if (to >= 0) next.push(b);
      a = b;
      from = to;
    }
    ring = next;
  }
  return ring;
}
function clipSegment(a, b, planes) {
  let start = 0,
    end = 1;
  for (const plane of planes) {
    const from = plane(a),
      to = plane(b);
    if (from < 0 && to < 0) return null;
    if (from < 0) start = Math.max(start, from / (from - to));
    if (to < 0) end = Math.min(end, from / (from - to));
    if (start > end) return null;
  }
  return [
    start === 0 ? a : interpolate(a, b, start),
    end === 1 ? b : interpolate(a, b, end),
  ];
}

async function svgOverlays({
  matrix,
  width,
  height,
  bounds,
  center,
  overlays,
}) {
  // Clip a stroke width outside the view so clipped rings don't acquire a
  // visible outline along the page edge.
  const padX = 1 + 24 / width,
    padY = 1 + 24 / height;
  const planes = [
    ([x, , w]) => padX * w + x,
    ([x, , w]) => padX * w - x,
    ([, y, w]) => padY * w + y,
    ([, y, w]) => padY * w - y,
  ];
  const round = (n) => Number(n.toFixed(2));
  const screenX = ([x, , w]) => round(((1 + x / w) * width) / 2);
  const screenY = ([, y, w]) => round(((1 - y / w) * height) / 2);
  const xy = (p) => screenX(p) + " " + screenY(p);
  const firstWorld = Math.floor((bounds.getWest() + 180) / 360);
  const lastWorld = Math.floor((bounds.getEast() + 180) / 360);
  const m = matrix;
  function project([lng, lat], world) {
    const { x, y } = maplibregl.MercatorCoordinate.fromLngLat([
      lng,
      Math.max(-85.051129, Math.min(85.051129, lat)),
    ]);
    return [
      m[0] * (x + world) + m[4] * y + m[12],
      m[1] * (x + world) + m[5] * y + m[13],
      m[3] * (x + world) + m[7] * y + m[15],
    ];
  }
  const centerDepth = project(center, 0)[2];
  const groups = [];
  let nextYield = performance.now() + 30;
  for (const {
    source,
    features,
    ink,
    fill,
    radius,
    lineWidth,
    outlineWidth,
  } of overlays) {
    const polygons = [],
      lines = [],
      points = [];
    for (const f of features) {
      const color = ink(f);
      const attr = f.id ? ' data-osm-id="' + escapeXml(f.id) + '"' : "";
      function draw(g, world) {
        const c = g.coordinates;
        if (g.type === "GeometryCollection") {
          for (const child of g.geometries) draw(child, world);
        } else if (g.type.startsWith("Multi")) {
          const type = g.type.slice(5);
          for (const coordinates of c) draw({ type, coordinates }, world);
        } else if (g.type === "Point") {
          const p = project(c, world);
          if (planes.every((plane) => plane(p) >= 0)) {
            const scale = centerDepth / p[2];
            points.push(
              `<circle${attr} cx="${screenX(p)}" cy="${screenY(p)}" r="${round((radius + 1) * scale)}" fill="${color}" stroke="white" stroke-width="${round(2 * scale)}"/>`,
            );
          }
        } else if (g.type === "LineString") {
          const path = [];
          let a, last;
          for (const coord of c) {
            const b = project(coord, world);
            const segment = a && clipSegment(a, b, planes);
            if (segment) {
              const from = xy(segment[0]);
              if (from !== last) path.push("M" + from);
              last = xy(segment[1]);
              path.push("L" + last);
            } else last = null;
            a = b;
          }
          if (path.length)
            lines.push(
              `<path${attr} d="${path.join("")}" fill="none" stroke="${color}" stroke-width="${lineWidth}"/>`,
            );
        } else if (g.type === "Polygon") {
          const rings = [];
          for (const ring of c) {
            const clipped = clipRing(
              ring.map((p) => project(p, world)),
              planes,
            );
            if (clipped.length >= 3)
              rings.push("M" + clipped.map(xy).join("L") + "Z");
          }
          if (rings.length)
            polygons.push(
              `<path${attr} d="${rings.join("")}" fill="${color}" fill-opacity="${fill}" fill-rule="evenodd" stroke="${color}" stroke-width="${outlineWidth}"/>`,
            );
        }
      }
      for (let world = firstWorld; world <= lastWorld; world++)
        draw(f.geometry, world);
      if (performance.now() >= nextYield) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        nextYield = performance.now() + 30;
      }
    }
    groups.push(
      `<g id="${source}">${polygons.join("")}${lines.join("")}${points.join("")}</g>`,
    );
  }
  return groups.join("\n");
}

function scaleBar(map) {
  const scale = map.getContainer().querySelector(".maplibregl-ctrl-scale");
  if (!scale?.offsetWidth) return "";
  const box = scale.getBoundingClientRect(),
    canvas = map.getCanvas().getBoundingClientRect();
  const x = box.left - canvas.left,
    y = box.bottom - canvas.top - 1;
  const w = scale.offsetWidth;
  return `<g id="scale" transform="translate(${x} ${y})"><rect y="-14" width="${w}" height="14" fill="white" opacity=".75"/><path d="M1 -5V0H${w - 1}V-5" stroke="#333" stroke-width="2" fill="none"/><text x="4" y="-3" font-family="sans-serif" font-size="10">${escapeXml(scale.textContent)}</text></g>`;
}

async function captureFrame(map, getOverlays) {
  // Capture between the basemap and the flat query layers, inside the render
  // pass while WebGL's default (non-preserved) framebuffer is still valid.
  const id = "regol-svg-capture";
  let timeout, failed;
  try {
    return await new Promise((resolve, reject) => {
      failed = () =>
        reject(
          Error(
            "The map could not render the SVG. Try again once the map is visible.",
          ),
        );
      timeout = setTimeout(failed, 12000);
      map.once("webglcontextlost", failed);
      map.addLayer(
        {
          id,
          type: "custom",
          renderingMode: "2d",
          render(gl, args) {
            try {
              const canvas = map.getCanvas();
              const { clientWidth: width, clientHeight: height } = canvas;
              if (!width || !height || gl.isContextLost())
                throw Error("The map canvas is unavailable.");
              resolve({
                width,
                height,
                png: canvas.toDataURL("image/png"),
                scale: scaleBar(map),
                bounds: map.getBounds(),
                center: map.getCenter().toArray(),
                matrix: Array.from(args.defaultProjectionData.mainMatrix),
                overlays: getOverlays(),
              });
            } catch (error) {
              reject(error);
            }
          },
        },
        "match-fill",
      );
      map.triggerRepaint();
    });
  } finally {
    clearTimeout(timeout);
    map.off("webglcontextlost", failed);
    if (map.getLayer(id)) map.removeLayer(id);
  }
}

export async function svgMap(map, getOverlays, name) {
  const frame = await captureFrame(map, getOverlays);
  const { width, height, png, scale } = frame;
  const vectors = await svgOverlays(frame);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<title>Regol Live map</title>
<image id="basemap" width="${width}" height="${height}" xlink:href="${png}"/>
${vectors}
${scale}
<g id="attribution" font-family="sans-serif" font-size="10" text-anchor="end"><text x="${width - 4}" y="${height - 5}" fill="#222" stroke="white" stroke-width="3" paint-order="stroke"><a xlink:href="https://openfreemap.org/">OpenFreeMap</a> · <a xlink:href="https://openmaptiles.org/">OpenMapTiles</a> · <a xlink:href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a></text></g>
</svg>`;
  return new File([svg], name, { type: "image/svg+xml" });
}
