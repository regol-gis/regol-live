import { hostedPages, checkParentLookups } from "./site-mode.js";

export const overpassExamples = new Map([
  ["Cafés", 'nwr["amenity"="cafe"]({{bbox}});\nout geom;'],
  [
    "Count cafés and restaurants",
    'nwr["amenity"~"^(cafe|restaurant)$",i]({{bbox}});\nout count;',
  ],
  [
    "Benches in parks",
    'wr[leisure=park]({{bbox}});\nmap_to_area->.parks;\nnode[amenity=bench](area.parks)({{bbox}});\nout geom;',
  ],
  [
    "Buildings near railway lines",
    'way[railway=rail]({{bbox}})->.tracks;\nway[building](around.tracks:50)({{bbox}});\nout center;',
  ],
  [
    "Isolated groups of five wind turbines (English Midlands)",
    `(
  area[name="East Midlands"][boundary=statistical];
  area[name="West Midlands"][boundary=statistical];
)->.midlands;
node(area.midlands)["generator:source"="wind"]->.turbines;
foreach.turbines->.turbine {
  node.turbines(around.turbine:1000)->.first;
  node.turbines(around.first:1000)->.second;
  if ((first.count(nodes) == 5) && (second.count(nodes) == 5)) {
    (.groups; .first;)->.groups;
  }
}
.groups out body;
.groups out count;`,
  ],
  [
    "Buildings with ten or more levels",
    'wr[building]["building:levels"]({{bbox}})\n  (if:is_number(t["building:levels"]) && number(t["building:levels"]) >= 10);\nout geom;',
  ],
  [
    "Routes serving stops in view",
    'node[public_transport=stop_position]({{bbox}})->.stops;\nrel(bn.stops)[type=route];\nout center;',
  ],
  [
    "Named pedestrian streets",
    'way["highway"="pedestrian"]["name"]({{bbox}});\nout geom;',
  ],
  [
    "Cafés near bus stops",
    'node["highway"="bus_stop"]({{bbox}})->.stops;\nnode["amenity"="cafe"](around.stops:150);\nout geom;',
  ],
  [
    "Libraries and bookshops",
    '(\n  nwr["amenity"="library"]({{bbox}});\n  nwr["shop"="books"]({{bbox}});\n);\nout geom;',
  ],
]);
if (hostedPages) overpassExamples.delete("Routes serving stops in view");

let worker;
let nextID = 0;
const pending = new Map();

function parserWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./overpass-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(Error(data.error));
    else request.resolve(data.plan);
  };
  worker.onerror = (event) => {
    for (const { reject } of pending.values()) reject(Error(event.message));
    pending.clear();
    worker.terminate();
    worker = undefined;
  };
  return worker;
}

export async function parseOverpass(text, viewport, native = false) {
  const plan = await compile({ text, viewport }, native, "overpass/compile");
  if (hostedPages && !native) checkParentLookups(plan.sets);
  return plan;
}

let lastValidation;
export async function validateSelectors(locations, native) {
  return (await selectorDiagnostic(locations, native))?.message ?? "";
}

export async function selectorDiagnostic(locations, native) {
  if (!locations.length) return null;
  const selectors = locations.map(loc => loc.text);
  const key = JSON.stringify(selectors);
  if (lastValidation?.key !== key) {
    const pending = compile({ selectors }, native, "goql/validate");
    lastValidation = { key, pending };
    pending.catch(() => { if (lastValidation?.pending === pending) lastValidation = undefined; });
  }
  const issue = await lastValidation.pending;
  if (!issue) return null;
  const { text, line, column, offset } = locations[issue.index];
  // Regol reports UTF-8 byte offsets. Editor columns count UTF-16 code units.
  const prefix = new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, issue.offset));
  const lines = prefix.split("\n");
  const col = lines.at(-1).length + (lines.length === 1 ? column : 1);
  const error = new SyntaxError(`Line ${line + lines.length - 1}, column ${col}: ${issue.message}.`);
  if (offset !== undefined) {
    error.start = offset + prefix.length;
    const char = text.slice(prefix.length)[Symbol.iterator]().next().value ?? "";
    error.end = error.start + char.length;
    if (char === "]" && issue.message === "expected key or value") {
      // The caret just before ] is an editable argument in a completion snippet.
      error.unfinished = true;
      error.unfinishedFrom = error.start;
      error.unfinishedUntil = error.start;
    }
  }
  return error;
}

async function compile(input, native, path) {
  if (native) {
    const response = await fetch("./api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw Error(problem?.error || `Query validation failed (HTTP ${response.status}).`);
    }
    return response.json();
  }
  // Parsing stays available while the dataset worker is waiting for ranges.
  const parser = parserWorker();
  const id = ++nextID;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parser.postMessage({ id, input });
  });
}
