import { executionPlan, emptyReferenceNotes } from "./query-plan.js";
import localDatasets from "./local-datasets.js";
import { discoverPlanetFiles, isPlanetFile, planetURL, utcDate } from "./planet-files.js";
import { hostedPlanetIndexURL } from "./named-areas.js";
import { hostedPages } from "./site-mode.js";
import {
  examples,
  parseDraft,
  runnableProgram,
  queryWarning,
} from "./query-language.js";
import { parseOverpass, selectorDiagnostic, overpassExamples } from "./overpass.js";
import { initBuilder, setsBeforeBuilderFilter } from "./query-builder.js";
import { initTagCompletion } from "./tag-completion.js";
import { RangeQueries, NativeQueries } from "./query-backend.js";
import { resultFile } from "./export-results.js";
import { DisplayCache, featureKey } from "./display-cache.js";
import {
  initMap,
  camera,
  setDatasetView,
  queryWindows,
  mapFile,
  showGeometry,
  showDownloadedArea,
  showResults,
  drawingCursor,
  setColor,
} from "./map.js";

const $ = (id) => document.getElementById(id);
const native = localDatasets.find((item) => item.native);
const backend = native ? new NativeQueries() : new RangeQueries(windows => {
  showDownloadedArea(windows);
  $("downloaded-legend").hidden = !windows?.length;
});
const downloadGatesPan = hostedPages && !native;
if (native) {
  $("about-standalone").hidden = true;
  $("about-native").hidden = false;
  $("dataset").replaceChildren(new Option(native.label, native.id));
  $("dataset").disabled = true;
} else {
  $("download-area").hidden = false;
  for (const item of localDatasets) {
    $("dataset").add(
      new Option(item.label, item.id),
      $("dataset").querySelector('[value="planet"]'),
    );
  }
}

$("open-about").onclick = async () => {
  $("about-dialog").showModal();
  const versionLabel = $("about-version");
  try {
    const response = await fetch("./build.json", { cache: "no-cache" });
    if (!response.ok) throw Error();
    const { version, revision, dirty, planetAreaCutoffKm2 } = await response.json();
    const coverage = $("about-planet-areas");
    coverage.hidden = !(Number.isFinite(planetAreaCutoffKm2) && planetAreaCutoffKm2 > 0);
    if (!coverage.hidden) {
      coverage.textContent = `Planet named-area searches include administrative boundaries and settlement polygons at every size. Other named areas need a bounding rectangle of at least ${planetAreaCutoffKm2} km². The index is refreshed separately from the map. Some new, renamed or moved areas may be missing between refreshes.`;
    }
    const parts = [];
    if (version) parts.push("Regol Live " + version);
    if (revision) parts.push("commit " + revision.slice(0, 8) + (dirty ? " (local changes)" : ""));
    versionLabel.textContent = parts.join(" · ") || "Version unavailable";
  } catch {
    versionLabel.textContent = "Version unavailable";
  }
};

const initialDataset = new URL(location.href).searchParams.get("dataset");
if (
  Array.from($("dataset").options).some(
    (opt) => opt.value === initialDataset && opt.value !== "custom",
  )
)
  $("dataset").value = initialDataset;
const localSource = () =>
  localDatasets.find((item) => item.id === $("dataset").value);
const demo = new URL("./data/monaco-2026-01-01.gol", location.href).href;
let mapReady = false, planetFiles, planetDiscovery;
const observedDates = new Map();
const formatDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function showDatasetDate() {
  const field = $("dataset-date");
  const dataset = $("dataset").value;
  const displayDate = value => formatDate.format(new Date(value));
  if (dataset === "planet") {
    field.title = planetFiles && !planetFiles.gob
      ? "OpenPlanetData publication date (UTC). Downloads and queries use the same GOL."
      : "OpenPlanetData publication date (UTC)";
    if (!planetFiles) {
      field.textContent = "Checking dates…";
      return;
    }
    const { gol, gob } = planetFiles;
    const date = gob || gol.dated ? gol.date : observedDates.get(gol.url) ?? gol.date;
    field.textContent = date ? displayDate(date) : "Date unavailable";
  } else if (dataset === "monaco") {
    field.title = "OpenStreetMap extract date";
    field.textContent = displayDate("2026-01-01");
  } else {
    let date;
    try { date = observedDates.get(datasetURL()) ?? utcDate(localSource()?.modified); } catch {}
    field.title = "File modification date (UTC)";
    field.textContent = date ? "Updated " + displayDate(date) : "";
  }
}

function observeDate(url, data) {
  const date = utcDate(data.modified);
  if (!date) return;
  const file = data.transport === "gob" ? planetFiles?.gob?.url : url;
  if (file && observedDates.get(file) !== date) {
    observedDates.set(file, date);
    showDatasetDate();
  }
}

function planetOptions() {
  if ($("dataset").value !== "planet" || !planetFiles) return {};
  const { gol, gob } = planetFiles;
  return {
    publicPlanet: true, gobURL: gob?.url,
    golDate: gob && !gol.dated ? gol.date : null,
    gobDate: gob?.dated ? null : gob?.date,
  };
}

function prepareDataset() {
  const planet = $("dataset").value === "planet";
  ready = mapReady && (!planet || Boolean(planetFiles));
  $("run").disabled = !ready;
  showDatasetDate();
  if (planet && !planetDiscovery) {
    planetDiscovery = discoverPlanetFiles().then(files => {
      planetFiles = files;
      if ($("dataset").value !== "planet") return;
      prepareDataset();
      scheduleAreaCheck();
      run("auto");
    });
  }
}
let queriesActive = Boolean(native),
  busy = false,
  compiling = false,
  ready = false,
  panTimer,
  generation = 0;
let features = [],
  display = null,
  shown = 0,
  pickedIds = [],
  pickIndex = 0;
let exportView = null,
  exporting = false;
let reference = null,
  displayedGeometry = null,
  sketch = null,
  basemapMessage = "";
const number = new Intl.NumberFormat();
const coord = (n) => n.toFixed(4);
const units = (n) =>
  n >= 1048576
    ? (n / 1048576).toFixed(2) + " MiB"
    : (n / 1024).toFixed(0) + " KiB";

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
let overpassMode = false;
const completion = initTagCompletion({
  builderSets: setsBeforeBuilderFilter,
  enabled: () => !overpassMode,
  backend,
  source: () => ready && !busy ? {
    url: datasetURL(), windows: queryWindows(), localFile: localSource()?.localFile === true,
    ...planetOptions(),
  } : null,
});
let timeoutTimer;
const golWarningKey = "regol-live.skip-live-gol-warning";
let skipGolWarning = false;
try { skipGolWarning = localStorage.getItem(golWarningKey) === "1"; } catch {}
const drafts = { regol: examples.get("Cafés"), overpass: overpassExamples.get("Cafés") };
let areaEstimate = null, areaTimer, checkingArea = false;
let panPreferred = $("auto").checked, pendingPan = false;
const areaBytes = bytes => bytes ? units(bytes) : "0 B";
const areaFormat = estimate => estimate.transport === "gob" ? "GOB" : "GOL";

function showAreaSize(estimate, hint = "Checking size…", retry = false) {
  areaEstimate = estimate;
  if (downloadGatesPan) {
    $("auto").disabled = !estimate?.covered;
    $("auto").checked = Boolean(estimate?.covered && panPreferred);
    $("auto").parentElement.title = estimate?.covered ? "Update results inside the downloaded area" :
      "Download this area to enable updates on pan";
  }
  const button = $("download-area");
  let size = hint;
  let title = hint;
  if (estimate) {
    const format = areaFormat(estimate);
    // The paired archive gives nested views a comparable footprint even when
    // cached GOL pages are the cheaper transfer for one of them.
    const paired = estimate.archiveTotal != null;
    const footprint = areaBytes(paired ? estimate.archiveTotal : estimate.total) + " " + (paired ? "GOB" : format);
    const transfer = areaBytes(estimate.missing) + " to fetch" + (paired ? " via GOL" : "");
    const detail = estimate.limitBytes
      ? (paired ? format + " " : "") + "over " + units(estimate.limitBytes)
      : transfer;
    size = footprint + " · " + detail;
    title = estimate.limitBytes
      ? format + " download needs " + units(estimate.total) + ". Zoom in to fit the " + units(estimate.limitBytes) + " cache."
      : footprint + " for this view. " + areaBytes(estimate.missing) + " to fetch using " + format + ".";
  }
  $("area-size").textContent = size;
  button.title = title;
  button.setAttribute("aria-label", "Download this area. " + title);
  button.disabled = !ready || busy || !(estimate ? !estimate.limitBytes && (estimate.missing > 0 ||
    (downloadGatesPan && estimate.tiles > 0 && !estimate.covered)) : retry);
}

function cancelAreaCheck(reuseSource) {
  clearTimeout(areaTimer);
  if (checkingArea) backend.cancel({ reuseSource });
  checkingArea = false;
}

function scheduleAreaCheck(clear = false) {
  if (native) return;
  cancelAreaCheck();
  showAreaSize(clear ? null : areaEstimate);
  // A query or cancellation may have changed the cache since the last count.
  $("download-area").disabled = true;
  if (!ready || busy) return;
  let url;
  try {
    url = datasetURL();
  } catch {
    showAreaSize(null, "Enter a GOL URL");
    return;
  }
  // Let a pan-triggered query take the worker first. Its reads count towards
  // coverage when we check the settled viewport.
  areaTimer = setTimeout(() => {
    checkingArea = true;
    const fail = (message, tileLimit = false) => {
      checkingArea = false;
      showAreaSize(null, tileLimit ? "Zoom in · too many tiles" : "Size unavailable", !tileLimit);
      $("download-area").title = message;
    };
    backend.run({
      type: "estimate-area", url, localFile: localSource()?.localFile === true,
      ...planetOptions(),
      request: { windows: queryWindows() },
    }, (data) => {
      if (data.type === "error") {
        if (data.invalidated) resetDisplay();
        fail(data.message, data.tileLimit);
      } else if (data.type === "area-estimate") {
        checkingArea = false;
        observeDate(url, data);
        showAreaSize(data);
        if (pendingPan) {
          pendingPan = false;
          if (data.covered && panPreferred && !sketch) run("pan");
        }
      }
    }, fail);
  }, 350);
}

function setBusy(value, reuseSource) {
  if (!value) clearTimeout(timeoutTimer);
  busy = value;
  completion.refresh();
  $("continue-query").hidden = true;
  $("cancel").hidden = !value;
  $("run").disabled = !ready;
  if (value) {
    cancelAreaCheck(reuseSource);
    $("download-area").disabled = true;
  } else {
    scheduleAreaCheck();
  }
  $("native-progress").hidden = !native || !value;
  if (native && value) $("native-phase").textContent = "Running query…";
}
function stop({ interrupt = busy && !compiling, keepDownload = backend.hasDownload } = {}) {
  compiling = false;
  locatingURL = null;
  clearTimeout(panTimer);
  generation++;
  if (interrupt) {
    if (checkingArea) cancelAreaCheck();
    else backend.cancel({ keepDownload });
    if (!keepDownload) areaEstimate = null;
  }
  if ($("area-dialog").open) $("area-dialog").close();
  if ($("live-gol-dialog").open) $("live-gol-dialog").close();
  setBusy(false);
}
function closeDetail() {
  if (!pickedIds.length) return;
  pickedIds = [];
  pickIndex = 0;
  $("inspector").hidden = true;
  showGeometry("selected", null);
}
function presentResults({
  features: list,
  counts,
  outputs,
  skippedGeometries = 0,
  skippedReferences = 0,
}) {
  const warning = $("geometry-warning");
  warning.hidden = !skippedGeometries;
  warning.textContent = skippedGeometries
    ? "Skipped " +
      number.format(skippedGeometries) +
      (skippedGeometries === 1 ? " invalid geometry" : " invalid geometries") +
      (skippedReferences
        ? " (" + number.format(skippedReferences) + " from the reference query)"
        : "") +
      "."
    : "";
  if (pickedIds.length) {
    const selected = pickedIds[pickIndex];
    const remaining = pickedIds.filter((id) => display?.byId.has(id));
    if (!remaining.includes(selected)) closeDetail();
    else if (remaining.length !== pickedIds.length)
      inspect(remaining, remaining.indexOf(selected));
  }
  $("count").textContent = number.format(
    counts?.total ?? (outputs?.length === 1 ? outputs[0].counts?.total : undefined) ?? list.length,
  );
  const breakdown = $("count-types");
  const summaries = counts ? [countSummary(counts)] : (outputs ?? [])
    .filter((output) => output.counts)
    .map((output) => outputLabel(output) + " · " + countSummary(output.counts));
  breakdown.hidden = !summaries.length;
  breakdown.replaceChildren();
  for (const summary of summaries) {
    if (breakdown.childNodes.length) breakdown.append(document.createElement("br"));
    breakdown.append(summary);
  }
  if (
    features.length === list.length &&
    list.every((f, i) => f === features[i])
  )
    return;
  features = list;
  shown = 0;
  $("list").replaceChildren();
  showMore();
}
function countSummary(counts) {
  return ["nodes", "ways", "relations", "areas"]
    .filter((kind) => counts[kind] !== undefined)
    .map((kind) => number.format(counts[kind]) + " " + (counts[kind] === 1 ? kind.slice(0, -1) : kind))
    .join(" · ");
}
function outputLabel({ name, mode, detail, order }) {
  const modifiers = [detail, detail && mode === "geom" ? undefined : mode, order];
  return (name === "_" ? "" : "." + name + " ") + "out " + modifiers.filter(Boolean).join(" ");
}
const hasResults = (view) => view.features.length || view.counts ||
  view.outputs?.some((group) => group.counts);

function resetDisplay(next = null) {
  $("query-steps").hidden = true;
  $("step-counts").replaceChildren();
  $("reference-note").textContent = "";
  exportView = null;
  updateExportButton();
  display = next;
  closeDetail();
  showResults(new Map());
  presentResults({ features: [] });
  displayedGeometry = null;
  showGeometry("reference", null);
  $("set-legend").replaceChildren();
  $("set-legend").hidden = true;
}
function showMore() {
  const fragment = document.createDocumentFragment();
  for (const f of features.slice(shown, shown + 35)) {
    const li = document.createElement("li"),
      button = document.createElement("button");
    button.className = "result";
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.ariaHidden = "true";
    glyph.textContent = f.geometry.type.includes("Point")
      ? "●"
      : f.geometry.type.includes("Polygon")
        ? "▰"
        : "∿";
    const name = document.createElement("span");
    name.textContent =
      f.tags.name ||
      f.tags.amenity ||
      f.tags.highway ||
      f.tags.building ||
      f.geometry.type;
    const id = document.createElement("small");
    id.textContent = f.id;
    button.append(glyph, name, id);
    button.onclick = () => inspect([featureKey(f)]);
    li.append(button);
    fragment.append(li);
    shown++;
  }
  $("list").append(fragment);
  $("more").hidden = shown >= features.length;
}
function inspect(ids, index = 0) {
  const f = display?.byId.get(ids[index]);
  if (!f) return closeDetail();
  pickedIds = ids;
  pickIndex = index;
  $("hit-carousel").hidden = ids.length < 2;
  $("hit-position").textContent =
    index + 1 + " of " + ids.length + " at this point";
  $("detail-id").textContent = f.id + " · " + f.geometry.type;
  $("detail-name").textContent =
    f.tags.name || f.tags.amenity || f.tags.highway || f.geometry.type;
  const tags = $("tags");
  tags.replaceChildren();
  for (const [key, value] of Object.entries(f.tags)) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = value;
    tags.append(dt, dd);
  }
  $("inspector").hidden = false;
  showGeometry("selected", f.geometry);
}
function stepPick(delta) {
  const count = pickedIds.length;
  if (count > 1) inspect(pickedIds, (pickIndex + delta + count) % count);
}
function datasetURL() {
  const local = localSource();
  if (local) return new URL(local.path, location.href).href;
  if ($("dataset").value === "monaco") return demo;
  if ($("dataset").value === "planet") return planetFiles?.gol.url ?? planetURL;
  const raw = $("url").value.trim();
  if (!raw) throw Error("Enter a GOL URL.");
  const url = new URL(raw, location.href);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Use an HTTP or HTTPS dataset URL without credentials.");
  return url.href;
}
// Configured cameras also let known global sources open without a planet search.
function configuredView() {
  if ($("dataset").value === "monaco") return { center: [7.422, 43.739], zoom: 15 };
  if (["planet", "planet-proxy"].includes($("dataset").value))
    return { center: [-0.128, 51.507], zoom: 15 };
  return localSource()?.view;
}

let positionedURL, locatingURL;
let cameraMoves = 0;

async function makeRequest() {
  if (sketch) throw Error("Finish or cancel the drawing first.");
  const windows = queryWindows();
  const queryText = $("selector").value;
  if (overpassMode) {
    const plan = await parseOverpass(queryText, windows, Boolean(native));
    const search = new Map();
    for (const { overpass } of plan.sets) {
      if (!overpass || (overpass.bbox === false && (overpass.area || overpass.around?.reference))) continue;
      for (const box of overpass.windows) search.set(box.join(","), box);
    }
    return { ...plan, windows, readWindows: [...search.values()], queryText };
  }
  const selectors = [];
  const plan = parseDraft(queryText, selectors);
  const issue = await selectorDiagnostic(selectors, Boolean(native));
  if (issue) throw issue;
  runnableProgram(plan);
  const usesGeometry =
    plan.show.includes("geometry") ||
    plan.sets.some((s) => s.filters.some((f) => f.reference === "geometry"));
  const geometry = usesGeometry ? reference?.geometry : undefined;
  return { ...executionPlan(plan, windows), setStats: true, queryText, geometry, windows };
}

let warningTimer;
let warningVersion = 0;

const editor = $("selector");
let editorIssue, submittedIssue = false;
function displayIssue(issue, submitted = false) {
  editorIssue = issue;
  submittedIssue = submitted;
  const caret = editor.selectionStart;
  const editing = !submitted && issue?.unfinished && editor === document.activeElement &&
    caret === editor.selectionEnd && caret >= (issue.unfinishedFrom ?? Math.min(issue.start + 1, issue.end)) &&
    caret <= (issue.unfinishedUntil ?? Infinity) &&
    !editor.value.slice(issue.start, caret).includes("\n");
  $("query-warning").textContent = editing ? "" : issue?.message ?? "";
  $("locate-issue").hidden = editing || issue?.start === undefined || issue.start === issue.end;
  $("repair-issue").hidden = editing || !issue?.repair;
  if (issue?.repair) $("repair-issue").textContent = issue.repair.label;
}
function locateIssue() {
  if (editorIssue?.start === undefined) return;
  const { start, end } = editorIssue;
  editor.focus();
  editor.setSelectionRange(start, end);
}
$("locate-issue").onclick = locateIssue;
$("repair-issue").onclick = () => {
  if (!editorIssue?.repair) return;
  const { start, end, repair } = editorIssue;
  editor.focus();
  editor.setRangeText(repair.text, start, end, "end");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
};
// A warning appearing on blur can move the button between pointerdown and
// click. Finish the pointer action before changing the editor layout.
let pointerLeavingEditor = false;
document.addEventListener("pointerdown", event => {
  pointerLeavingEditor = editor === document.activeElement && event.target !== editor;
}, true);
function finishPointer() {
  if (!pointerLeavingEditor) return;
  setTimeout(() => {
    pointerLeavingEditor = false;
    refreshUnfinished();
  }, 0);
}
document.addEventListener("pointerup", finishPointer, true);
document.addEventListener("pointercancel", finishPointer, true);
function refreshUnfinished() {
  if (!pointerLeavingEditor && editorIssue?.unfinished && !submittedIssue) displayIssue(editorIssue);
}
editor.addEventListener("selectionchange", refreshUnfinished);
editor.addEventListener("focus", refreshUnfinished);
editor.addEventListener("blur", () => {
  // activeElement changes after blur in some browsers.
  queueMicrotask(refreshUnfinished);
});

function updateQueryWarning() {
  clearTimeout(warningTimer);
  const current = ++warningVersion;
  const text = editor.value;
  displayIssue(null);
  if (overpassMode) {
    if (text.trim()) warningTimer = setTimeout(async () => {
      try { await parseOverpass(text, [[-180, -85, 180, 85]], Boolean(native)); }
      catch (error) { if (current === warningVersion) displayIssue(error); }
    }, 120);
    return;
  }
  try {
    const selectors = [];
    const draft = parseDraft(text, selectors);
    const message = queryWarning(draft);
    const hint = message ? { message } : null;
    if (hint && !draft.show.length && !draft.emptyShow) {
      const output = `show($${draft.sets.at(-1).name})`;
      Object.assign(hint, { start: text.length, end: text.length,
        repair: { label: "Insert " + output, text: (text.endsWith("\n") ? "" : "\n") + output } });
    }
    if (draft.show.length || !selectors.length) displayIssue(hint);
    warningTimer = setTimeout(async () => {
      try {
        const issue = await selectorDiagnostic(selectors, Boolean(native));
        if (current === warningVersion) displayIssue(issue || hint);
      } catch { /* Run reports transport errors. */ }
    }, 150);
  } catch (error) { displayIssue(error); }
}

function presentView(view, request) {
  presentResults(view);
  $("reference-note").textContent = !overpassMode && view.complete && view.setStats?.length
    ? emptyReferenceNotes(parseDraft(request.queryText), request.sets, view).join("\n") : "";
  const rows = $("step-counts");
  rows.replaceChildren();
  $("query-steps").hidden = !view.setStats?.length;
  for (const stats of view.setStats ?? []) {
    const step = request.sets[stats.setIndex];
    const row = rows.insertRow();
    const [owner, internal] = step.name.split(":");
    const operation = step.membership ? "membership" : step.difference ? "difference" : step.union ? "union" : "input";
    row.insertCell().textContent = internal === undefined ? "$" + owner : `$${owner} (${operation})`;
    for (const value of [stats.candidatesRead, stats.matchesKept, stats.retained])
      row.insertCell().textContent = number.format(value);
  }
  displayedGeometry = request.show.includes("geometry")
    ? request.geometry
    : null;
  const groups = view.outputs;
  const entries = groups
    ? groups.flatMap((group, index) => group.counts ? [] : [[outputLabel(group), index]])
    : request.show.map((name, index) => ["$" + name, index]);
  exportView = {
    features: view.features,
    show: groups?.map((group) => group.name) ?? (request.outputName ? [request.outputName] : request.show),
    setPrefix: groups || request.outputName ? "." : "$",
    geometry: displayedGeometry,
    partial: !view.complete,
  };
  updateExportButton();
  if (!sketch) showGeometry("reference", displayedGeometry);
  const legend = $("set-legend");
  legend.hidden = groups ? groups.length < 2 || !entries.length : entries.length < 2;
  const items = document.createDocumentFragment();
  for (const [label, index] of entries) {
    const item = document.createElement("span");
    item.style.setProperty(
      "--set-color",
      label === "$geometry" ? "#986700" : setColor(index),
    );
    item.textContent = label;
    items.append(item);
  }
  legend.replaceChildren(items);
}

function isMapFormat(format) {
  return format === "svg" || format === "html";
}

function updateExportButton() {
  $("export-results").disabled =
    exporting ||
    (isMapFormat($("export-format").value)
      ? !ready
      : !(exportView?.features.length || exportView?.geometry));
}

async function downloadResults() {
  const format = $("export-format").value;
  if ($("export-results").disabled) return;
  exporting = true;
  const button = $("export-results");
  button.disabled = true;
  button.textContent = "Exporting…";
  try {
    const file = isMapFormat(format)
      ? await mapFile(
          format,
          "regol-map" + (exportView?.partial ? "-partial" : "") + "." + format,
        )
      : await resultFile(format, exportView);
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    // Allow the browser to start the download before releasing its bytes.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    status("Export failed. " + error.message, true);
  } finally {
    exporting = false;
    button.textContent = "Export";
    updateExportButton();
  }
}

function confirmLiveGol(allow) {
  const dialog = $("live-gol-dialog");
  const download = $("download-before-query");
  download.hidden = Boolean(areaEstimate?.covered);
  $("live-gol-copy").textContent = download.hidden
    ? "This view is already downloaded. This query still needs data from the remote GOL. Run anyway to fetch it."
    : "This query needs data from the remote GOL and may transfer many megabytes. Download this area to reuse its tiles across queries, then run your query again.";
  const skip = $("skip-live-gol-warning");
  skip.checked = false;
  function rememberChoice() {
    if (!skip.checked) return;
    skipGolWarning = true;
    try { localStorage.setItem(golWarningKey, "1"); } catch {}
  }
  $("allow-live-gol").onclick = () => {
    rememberChoice();
    dialog.close();
    allow();
  };
  download.onclick = () => {
    rememberChoice();
    stop({ keepDownload: true });
    downloadArea();
  };
  $("cancel-live-gol").onclick = () => {
    stop({ keepDownload: true });
    status("Query cancelled.");
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    $("cancel-live-gol").click();
  };
  dialog.showModal();
  (download.hidden ? $("cancel-live-gol") : download).focus();
}

async function run(reason = "manual", approvedGol = false) {
  if (reason === "pan" && downloadGatesPan && !areaEstimate?.covered) return;
  pendingPan = false;
  const submittedCamera = cameraMoves;
  // An automatic camera update can arrive while someone is composing a new
  // query (including just after the initial native view loads).
  if (reason === "pan" && document.activeElement === editor && editor.value !== display?.program) return;
  if (!ready) return;
  if (!queriesActive && reason !== "manual") {
    status("Choose Run query to search this area.");
    return;
  }
  completion.close();
  clearTimeout(panTimer);
  if (busy) stop();
  const current = ++generation;
  const submittedText = editor.value;
  let url, request;
  try {
    url = datasetURL();
    compiling = true;
    setBusy(true, url);
    $("timings").hidden = true;
    status(overpassMode ? "Compiling Overpass query…" : "Preparing query…");
    request = await makeRequest();
    if (current !== generation) return;
    compiling = false;
    if (reason === "pan" && downloadGatesPan && submittedCamera !== cameraMoves) {
      setBusy(false);
      return;
    }
  } catch (error) {
    if (current !== generation) return;
    compiling = false;
    setBusy(false);
    resetDisplay();
    if (reason === "manual" && error.start !== undefined && editor.value === submittedText) {
      ++warningVersion;
      displayIssue(error, true);
      locateIssue();
    }
    status(error.message, true);
    return;
  }
  queriesActive = true;
  const locate = positionedURL !== url && !configuredView();
  const originalCamera = cameraMoves;
  if (!display?.matches(url, request))
    resetDisplay(new DisplayCache(url, request));
  // Explicit Overpass extents may leave the viewport. Let the worker verify their tiles.
  const cached = reason === "pan" && !(downloadGatesPan && overpassMode) ? display.recall(request.windows) : null;
  locatingURL = locate ? url : null;
  const emptyMessage = request.show.includes("geometry")
    ? "Map geometry shown. "
    : "No matches in this view. ";
  if (cached) {
    setBusy(false);
    presentView(cached, request);
    status(
      (hasResults(cached) ? "" : emptyMessage) +
        (native ? "Cached view" : "Cached view · 0 ranges"),
    );
    return;
  }
  status(locate ? "Finding a starting location…" : "Running query…");
  let remainingMs = locate ? 0 : (request.timeout ?? 0) * 1000;
  let deadline;
  function startTimeout() {
    if (locate || !request.timeout) return;
    deadline = performance.now() + remainingMs;
    timeoutTimer = setTimeout(() => {
      if (generation !== current) return;
      stop();
      status(`Query timed out after ${request.timeout} seconds.`, true);
    }, remainingMs);
  }
  const receive = (data) => {
    if (current !== generation) return;
    observeDate(url, data);
    if (data.type === "confirm-live-gol") {
      if (deadline !== undefined) {
        clearTimeout(timeoutTimer);
        remainingMs = Math.max(0, deadline - performance.now());
      }
      status("Waiting for your choice before reading the remote GOL.");
      confirmLiveGol(() => {
        if (current !== generation) return;
        approvedGol = true;
        status(locate ? "Finding a starting location…" : "Running query…");
        startTimeout();
        backend.allowLiveGol();
      });
      return;
    }
    if (data.type === "native-progress") {
      const parts = [data.receiving ? "Receiving results" : "Running query"];
      if (!data.receiving && data.scan) {
        parts[0] = "Evaluating $" + request.sets[data.scan.setIndex].name.split(":")[0];
        const count = data.scan.candidatesRead;
        if (count) parts.push(number.format(count) + (count === 1 ? " candidate read" : " candidates read"));
      }
      parts.push(Math.floor(data.elapsed / 1000) + " s");
      $("native-phase").textContent = parts.join(" · ");
      return;
    }
    if (data.type === "view") {
      positionedURL = url;
      locatingURL = null;
      setBusy(false);
      if (cameraMoves === originalCamera) {
        if (!data.view) {
          status("No starting location found. Zoom to an area and run the query.");
          return;
        }
        setDatasetView(data.view);
      }
      run(reason, approvedGol);
      return;
    }
    if (data.type === "progress" && locate) return;
    if (data.type === "transfer-limit") {
      $("continue-query").textContent =
        "Continue (+" + units(data.allowance) + ")";
      $("continue-query").hidden = false;
      status(
        "Paused at the transfer limit after " +
          units(data.bytes) +
          ". Large features can extend beyond the view.",
      );
      return;
    }
    if (data.type === "progress")
      return status(
        (data.transport === "gob" ? "Reading planet tiles · " : "Reading GOL · ") +
          data.gets +
          (data.gets === 1 ? " range · " : " ranges · ") +
          units(data.bytes),
      );
    setBusy(false);
    if (data.type === "outside-download") {
      status("This query needs data outside the download. Choose Run query to search manually.");
      return;
    }
    if (data.timings) {
      const t = data.timings;
      const ms = (value) => Math.round(value).toLocaleString() + " ms";
      const parts = [
        ms(t.storageRead) + " in browser storage reads",
        ms(t.storageWrite) + " in browser storage writes",
      ];
      if (t.engine !== null)
        parts.push(ms(t.engine) + " in the query engine outside range waits");
      parts.push(ms(t.busy) + " with HTTP reads in flight");
      if (data.gets) {
        if (t.disk !== null)
          parts.push(ms(t.disk) + " total in the local file handler");
        parts.push(
          ms(t.longest) +
            " longest GET (" +
            ms(t.headerWait) +
            " to response headers)",
          ms(t.gap) + " longest gap between GETs",
        );
        parts.push(
          "Peak of " +
            t.peak +
            (t.peak === 1 ? " GET" : " GETs") +
            " in flight",
        );
        if (t.prefetchGets)
          parts.push(number.format(t.prefetchGets) + " prefetched GETs");
        if (t.split)
          parts.push(
            "For the longest GET, the local clock puts " +
              ms(t.split.before) +
              " before the file handler, " +
              ms(t.split.after) +
              " between header write and browser delivery",
          );
      }
      $("timing-values").textContent = parts.join(" · ");
      $("timings").hidden = false;
    }
    if (data.type === "error") {
      locatingURL = null;
      if (data.invalidated) resetDisplay();
      status(
        data.message +
          (display?.byId.size ? " Previous results retained." : ""),
        true,
      );
      return;
    }
    if (display.snapshot !== data.snapshot) closeDetail();
    const view = display.store(request.windows, data);
    showResults(display.byId);
    presentView(view, request);
    const took =
      data.elapsed >= 1000
        ? (data.elapsed / 1000).toFixed(2) + " s"
        : Math.round(data.elapsed) + " ms";
    const io = native
      ? "Native query · " + units(data.resultBytes)
      : data.gets
        ? data.gets + (data.gets === 1 ? " range · " : " ranges · ") + units(data.bytes)
        : "Cached · 0 ranges";
    const text =
      (hasResults(data) ? "" : emptyMessage) +
      took +
      " · " +
      io +
      (data.cacheBytes
        ? " · " + units(data.cacheBytes) + " from browser storage"
        : "");
    status(
      data.limited
        ? "Partial results (" + data.limited + " limit). " + text
        : text,
    );
  };
  const fail = (message) => {
    if (current === generation) {
      locatingURL = null;
      stop();
      status(
        message +
          (display?.byId.size ? " Previous results retained." : ""),
        true,
      );
    }
  };
  startTimeout();
  const areaIndex = localSource()?.areaIndex ?? (isPlanetFile(url, "gol") ? hostedPlanetIndexURL : null);
  backend.run(
    {
      locate,
      url,
      request,
      downloadedOnly: downloadGatesPan && reason === "pan",
      warnLiveGol: !native && !approvedGol && !skipGolWarning && !localSource()?.localFile &&
        (new URL(url).origin !== location.origin || (hostedPages && $("dataset").value === "custom")),
      pauseAtTransferLimit: true,
      areaIndex: areaIndex && new URL(areaIndex, location.href).href,
      localFile: localSource()?.localFile === true,
      hints: localSource()?.hints && new URL(localSource().hints, location.href).href,
      ...planetOptions(),
    },
    receive,
    fail,
  );
}

function downloadArea() {
  if (!ready || busy || native) return;
  let url;
  try {
    url = datasetURL();
  } catch (error) {
    status(error.message, true);
    return;
  }
  clearTimeout(panTimer);
  const current = ++generation;
  const dialog = $("area-dialog");
  const message = $("area-status");
  const confirm = $("confirm-area");
  let fetching = false;
  let discoveryBytes = 0;
  let planned;
  let fallbackReason;
  const windows = areaEstimate?.windows ?? queryWindows();
  setBusy(true, url);
  confirm.hidden = true;
  message.textContent = "Reading the tile directory and headers…";
  dialog.showModal();
  const fail = (error) => {
    if (current !== generation) return;
    stop();
    status(error, true);
  };
  confirm.onclick = () => {
    fetching = true;
    confirm.hidden = true;
    message.textContent = "Preparing tiles…";
    backend.confirmArea();
  };
  backend.run({
    type: "plan-area", url, localFile: localSource()?.localFile === true,
    ...planetOptions(),
    request: { windows },
  }, (data) => {
    if (current !== generation) return;
    observeDate(url, data);
    if (data.type === "error") {
      if (data.invalidated) resetDisplay();
      dialog.close();
      setBusy(false);
      status("Area download failed. " + data.message, true);
    } else if (data.type === "area-fallback") {
      fallbackReason = data.reason;
      fetching = false;
      message.textContent = "Checking the size of the GOL download…";
    } else if (data.type === "area-estimate") {
      discoveryBytes = data.bytes;
      planned = data;
      showAreaSize(data);
      const tiles = data.tiles === 1 ? "1 tile" : data.tiles + " tiles";
      const format = areaFormat(data);
      const fallback = fallbackReason ? "The GOB could not be used. " + fallbackReason + " " : "";
      if (data.limitBytes) {
        message.textContent = fallback + tiles + " need " + units(data.total) + " of " + format +
          " data. Zoom in to fit the " + units(data.limitBytes) + " download cache.";
        confirm.hidden = true;
        return;
      }
      message.textContent = fallback + tiles + " cover this view (" + units(data.total) + " " + format + "). " +
        (data.missing ? areaBytes(data.missing) + " to fetch." : "All required bytes are cached.") +
        " Queries may fetch more data for features that extend outside the area.";
      confirm.textContent = data.missing ? "Download " + units(data.missing) : "Use cached tiles";
      confirm.hidden = false;
      confirm.focus();
    } else if (data.type === "progress" && fetching) {
      const received = data.bytes - discoveryBytes;
      showAreaSize({ ...planned, missing: Math.max(0, planned.missing - received) });
      message.textContent = "Downloading tiles · " + units(received) + " received";
    } else if (data.type === "area-ready") {
      if (display?.snapshot && (display.url !== url || display.snapshot !== data.snapshot))
        resetDisplay();
      dialog.close();
      showAreaSize({ ...data, missing: 0 });
      setBusy(false);
      status("Area ready for queries · " + (data.tiles === 1 ? "1 tile" : data.tiles + " tiles") +
        " · " + units(data.bytes + discoveryBytes) + " transferred");
    }
  }, fail);
}

$("download-area").onclick = downloadArea;
$("cancel-area").onclick = () => {
  stop();
  status("Area download cancelled.");
};
$("area-dialog").oncancel = (event) => {
  event.preventDefault();
  $("cancel-area").click();
};

function updateReference() {
  $("clear-reference").hidden = !reference;
  $("reference-status").textContent =
    reference?.label ||
    "Draw, paste or pick a feature to use as a spatial reference.";
  if (!sketch) showGeometry("reference", displayedGeometry);
}
function endSketch() {
  sketch = null;
  drawingCursor(false);
  $("drawing").hidden = true;
  document
    .querySelectorAll("[data-draw]")
    .forEach((b) => b.setAttribute("aria-pressed", "false"));
  updateReference();
}
function useReference(geometry, label) {
  reference = { geometry, label };
  $("pasting").hidden = true;
  endSketch();
  status("Map geometry saved. Use $geometry in a spatial filter or in show().");
}
function updateSketch() {
  const { type, points } = sketch;
  const min = type === "Polygon" ? 3 : type === "LineString" ? 2 : 1;
  $("finish").disabled = points.length < min;
  $("draw-help").textContent =
    type === "Point"
      ? "Click the reference point on the map."
      : "Click " +
        (type === "Polygon" ? "polygon" : "line") +
        " vertices on the map. " +
        points.length +
        " placed.";
  const geometry =
    points.length >= 3 && type === "Polygon"
      ? { type, coordinates: [[...points, points[0]]] }
      : points.length >= 2
        ? { type: "LineString", coordinates: points }
        : points.length
          ? { type: "Point", coordinates: points[0] }
          : null;
  showGeometry("reference", geometry);
}
function startSketch(type) {
  clearTimeout(panTimer);
  sketch = { type, points: [] };
  $("drawing").hidden = false;
  $("pasting").hidden = true;
  document
    .querySelectorAll("[data-draw]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.draw === type)),
    );
  drawingCursor(true);
  updateSketch();
}
function mapClick(point, ids) {
  if (!sketch) {
    inspect(ids.filter((id) => display?.byId.has(id)));
    if (pickedIds.length > 1) $("next-hit").focus({ preventScroll: true });
    return;
  }
  if (sketch.type === "Point") {
    useReference({ type: "Point", coordinates: point }, "Point drawn on map");
    return;
  }
  if (sketch.points.length >= 4096) {
    status("Drawing limit reached. Finish this geometry.", true);
    return;
  }
  sketch.points.push(point);
  updateSketch();
}
function applyGeoJSON() {
  try {
    const parsed = JSON.parse($("geometry").value);
    const geometry = parsed.type === "Feature" ? parsed.geometry : parsed;
    if (
      ![
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
        "GeometryCollection",
      ].includes(geometry?.type)
    )
      throw Error("Choose a GeoJSON geometry or Feature.");
    // Regol queries use horizontal coordinates. Strip any optional altitude.
    const normalize = (g) => {
      if (g.type === "GeometryCollection")
        return { type: g.type, geometries: g.geometries.map(normalize) };
      const positions = (coords) => {
        if (!Array.isArray(coords)) throw Error("Invalid coordinates.");
        if (typeof coords[0] !== "number") return coords.map(positions);
        const [lng, lat] = coords;
        if (
          !Number.isFinite(lng) ||
          !Number.isFinite(lat) ||
          Math.abs(lng) > 180 ||
          Math.abs(lat) > 90
        )
          throw Error("Invalid longitude or latitude.");
        return [lng, lat];
      };
      return { type: g.type, coordinates: positions(g.coordinates) };
    };
    useReference(normalize(geometry), "Pasted " + geometry.type);
  } catch (error) {
    status("GeoJSON: " + error.message, true);
  }
}
function showCamera() {
  const { lat, lng, zoom } = camera();
  $("coords").textContent =
    (basemapMessage ? basemapMessage + " · " : "") +
    coord(lat) +
    "°, " +
    coord(lng) +
    "°";
  $("zoom").textContent = "Zoom " + zoom.toFixed(1);
}
function changedSource() {
  pendingPan = false;
  completion.close();
  positionedURL = null;
  prepareDataset();
  stop({ interrupt: true, keepDownload: false });
  backend.reset?.();
  resetDisplay();
  reference = null;
  $("pasting").hidden = true;
  endSketch();
  $("custom-source").hidden = $("dataset").value !== "custom";
  if ($("dataset").value === "custom") {
    status("Enter a GOL URL and run a query.");
    $("url").focus();
    return;
  }
  const view = configuredView();
  if (view) setDatasetView(view);
  updateReference();
  run("auto");
}
$("dataset").onchange = changedSource;
$("url").oninput = () => {
  completion.close();
  showDatasetDate();
  if (busy) {
    stop({ keepDownload: false });
    status("Run the query to open this URL.");
  }
  backend.reset?.();
  scheduleAreaCheck(true);
};
$("run").onclick = () => run();
$("continue-query").onclick = () => {
  $("continue-query").hidden = true;
  status("Resuming query…");
  backend.resume();
};
$("cancel").onclick = () => {
  stop();
  status("Query cancelled.");
};
$("more").onclick = showMore;
$("export-results").onclick = downloadResults;
$("export-format").onchange = updateExportButton;
$("auto").onchange = () => {
  panPreferred = $("auto").checked;
  pendingPan = false;
  clearTimeout(panTimer);
};
$("close-detail").onclick = closeDetail;
$("prev-hit").onclick = () => stepPick(-1);
$("next-hit").onclick = () => stepPick(1);
$("inspector").onkeydown = (event) => {
  if (pickedIds.length > 1 && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    stepPick(event.key === "ArrowLeft" ? -1 : 1);
  }
};
function loadExamples() {
  $("example").length = 1;
  for (const [label] of overpassMode ? overpassExamples : examples)
    $("example").add(new Option(label, label));
}
$("query-language").onchange = () => {
  completion.close();
  pendingPan = false;
  stop({ keepDownload: true });
  if (sketch) endSketch();
  resetDisplay();
  drafts[overpassMode ? "overpass" : "regol"] = $("selector").value;
  overpassMode = $("overpass-mode").checked;
  if (overpassMode) $("overpass-mode").setAttribute("aria-describedby", "experimental");
  else $("overpass-mode").removeAttribute("aria-describedby");
  $("experimental").hidden = $("overpass-syntax").hidden = !overpassMode;
  for (const id of ["regol-syntax", "regol-geometry", "open-builder", "use-feature"])
    $(id).hidden = overpassMode;
  $("selector").value = drafts[overpassMode ? "overpass" : "regol"];
  $("timings").hidden = true;
  loadExamples();
  updateQueryWarning();
  status("Ready to run.");
};
loadExamples();
$("selector").oninput = updateQueryWarning;
$("selector").value = examples.get("Cafés");
$("example").onchange = () => {
  const text = (overpassMode ? overpassExamples : examples).get($("example").value);
  if (!text) return;
  $("selector").value = text;
  updateQueryWarning();
  $("example").selectedIndex = 0;
  $("pasting").hidden = true;
  endSketch();
  run("auto");
};
initBuilder($("selector"), () => {
  updateQueryWarning();
  run();
});
$("selector").onkeydown = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    run();
  }
};
document
  .querySelectorAll("[data-draw]")
  .forEach((b) => (b.onclick = () => startSketch(b.dataset.draw)));
$("discard").onclick = endSketch;
$("finish").onclick = () => {
  const { type, points } = sketch;
  useReference(
    {
      type,
      coordinates: type === "Polygon" ? [[...points, points[0]]] : points,
    },
    type + " drawn on map",
  );
};
$("clear-reference").onclick = () => {
  reference = null;
  endSketch();
};
$("paste").onclick = () => {
  endSketch();
  $("pasting").hidden = !$("pasting").hidden;
  if (!$("pasting").hidden) $("geometry").focus();
};
$("use-json").onclick = applyGeoJSON;
$("use-feature").onclick = () => {
  const selected = display?.byId.get(pickedIds[pickIndex]);
  if (selected)
    useReference(
      selected.geometry,
      (selected.tags.name || "Feature") + " · " + selected.id,
    );
  closeDetail();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (sketch) endSketch();
    else closeDetail();
  }
});
prepareDataset();
setBusy(false);
if (downloadGatesPan) {
  for (const item of document.querySelectorAll("[data-parent-filter]")) item.hidden = true;
  $("about-pan").textContent = "Update on pan works inside your downloaded area. Choose Run query to search elsewhere.";
  const intro = $("intro-dialog");
  const key = "regol-live.intro-seen";
  let seen = false;
  try { seen = localStorage.getItem(key) === "1"; } catch {}
  if (!seen) {
    intro.addEventListener("close", () => {
      if (!$("download-area").disabled) $("download-area").focus();
    }, { once: true });
    intro.showModal();
    try { localStorage.setItem(key, "1"); } catch {}
  }
}
try {
  initMap({
    initialView: configuredView() ?? { center: [0, 0], zoom: 1 },
    onMoveStart() {
      if (document.activeElement !== editor) completion.close();
      cameraMoves++;
      pendingPan = false;
      clearTimeout(panTimer);
      if (locatingURL) positionedURL = locatingURL;
      if (!native && !$("area-dialog").open) {
        cancelAreaCheck();
        showAreaSize(null);
      }
    },
    onReady() {
      mapReady = true;
      prepareDataset();
      scheduleAreaCheck();
      updateExportButton();
      showCamera();
      run("auto");
    },
    onMove(event) {
      showCamera();
      if (document.activeElement === editor) completion.refresh();
      if ($("area-dialog").open) return;
      pendingPan = downloadGatesPan && !event?.datasetView && queriesActive && panPreferred && !sketch;
      scheduleAreaCheck(true);
      if (event?.datasetView) return;
      clearTimeout(panTimer);
      if (!downloadGatesPan && queriesActive && ready && $("auto").checked && !sketch)
        panTimer = setTimeout(() => run("pan"), 200);
    },
    onClick: mapClick,
    onMapError(message) {
      basemapMessage = message;
    },
  });
} catch (error) {
  status("Could not initialize the map. " + error.message, true);
}
