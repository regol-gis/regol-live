import {
  RangeFile,
  planetURL,
  summarizeReadTimings,
  transferAllowance,
} from "./ranges.js";
import { ViewportReadAhead } from "./read-ahead.js";
import { areaIndexFiles, hasNamedAreas } from "./named-areas.js";
import { AreaDownload } from "./area-download.js";
import { insideDownloadedArea } from "./viewport.js";
import { hostedPages, checkParentLookups } from "./site-mode.js";
import { GobArea, GobQueryError, golPlanetSnapshot } from "./gob-area.js";
let api, source, ahead, areaDownload, snapshot, stats, job, timings, transferError, lastProgress;
let gobCatalog, gobActive, wasmModule;
let downloadTransport;
let gobRetryAt = 0;
const utf8 = new TextDecoder();
const encoder = new TextEncoder();

function send(message) {
  postMessage({ ...message, id: job.id });
}

function result(length) {
  const bytes = new Uint8Array(api.memory.buffer, api.output_ptr(), length);
  const value = JSON.parse(utf8.decode(bytes));
  if (value?.error) throw new Error(transferError || value.error);
  return value;
}

// Prefetches overlap. Count the union of the waits for each storage operation.
async function measureStorage(kind, run) {
  const clock = (job.storage[kind] ??= { active: 0, start: 0, ms: 0 });
  if (clock.active++ === 0) clock.start = performance.now();
  try {
    return await run();
  } finally {
    if (--clock.active === 0) clock.ms += performance.now() - clock.start;
  }
}

function queryTimings() {
  return {
    ...summarizeReadTimings(timings),
    prefetchGets: job.prefetchGets,
    storageRead: job.storage.read?.ms ?? 0,
    storageWrite: job.storage.write?.ms ?? 0,
    engine: job.engineMs,
  };
}

function reportRead(transport, length, timing) {
  timings.push({ ...timing, pausedBefore: job.pausedBefore });
  job.pausedBefore = 0;
  if (transport === "gol") ahead.observeRead(length, timing);
  stats.bytes += length;
  stats.gets++;
  const now = performance.now();
  if (stats.gets === 1 || now - lastProgress >= 50) {
    send({ type: "progress", transport, ...stats });
    lastProgress = now;
  }
}

async function newEngine(range) {
  wasmModule ??= WebAssembly.compileStreaming(fetch("./regol-live.wasm")).catch((error) => {
    wasmModule = null;
    throw error;
  });
  const instance = await WebAssembly.instantiate(await wasmModule, {
    range: { fetch_area_file: () => -1, copy_area_file: () => 0, ...range },
  });
  return instance.exports;
}

const newGobEngine = () => newEngine({ get_page: () => 0, suggestion_stopped: () => 0 });

async function open(url, localFile) {
  api = null;
  source?.cache?.close();
  ahead = new ViewportReadAhead();
  areaDownload = null;
  source = new RangeFile(
    url,
    (length, timing) => reportRead("gol", length, timing),
    (length) => {
      stats.cacheBytes += length;
    },
    measureStorage,
  );
  source.signal = job.area?.controller.signal ?? job.suggestion?.controller.signal;
  const remaining = () => job.limit - stats.bytes;
  const getPage = new WebAssembly.Suspending(
    async (offset, destination, length, sparse) => {
      const began = performance.now();
      try {
        if (suggestionStopped()) return 0;
        const start = Number(offset);
        if (job.downloadedOnly) {
          const cached = ahead.get(start, length);
          if (!cached) {
            job.missingPage = true;
            return 0;
          }
          new Uint8Array(api.memory.buffer, destination, length).set(cached);
          return 1;
        }
        let page =
          ahead.get(start, length) ?? (await source.cached(start, length));
        if (!job.suggestion && !job.area && !job.locate && !sparse && !page && start !== 0 && !source.first) {
          const expandLocal =
            localFile &&
            job.hints &&
            !job.planned &&
            ahead.shouldExpandLocal(timings, performance.now());
          const previousGets = stats.gets;
          if (expandLocal) {
            job.planned = true;
            job.headersPlanned = true;
            await ahead.prepare(source, job.hints, job.windows, remaining());
          } else if (!job.headersPlanned) {
            job.headersPlanned = true;
            job.readPlan = await ahead.prepareHeaders(
              source,
              job.windows,
              remaining,
              localFile,
            );
          }
          page = ahead.get(start, length);
          if (!page && job.readPlan) {
            try {
              page = await ahead.readAround(source, start, length, job.readPlan, remaining());
            } catch (error) {
              if (source.invalidated) throw error;
              job.readPlan = null; // The required page can still succeed on its own.
              page = ahead.get(start, length);
            }
          }
          job.prefetchGets += stats.gets - previousGets;
        }
        if (!page) {
          if (job.locate && (stats.bytes + length > job.limit || performance.now() > job.locateUntil)) {
            return 0;
          }
          if (stats.bytes + length > job.limit) {
            if (job.suggestion) {
              job.suggestion.limited = true;
              return 0;
            }
            if (!job.interactive)
              throw new Error(
                "GOL transfer limit reached. Narrow the selector or reference query. Large features can extend beyond the map view.",
              );
            const paused = performance.now();
            await new Promise((resolve) => {
              job.resume = resolve;
              send({
                type: "transfer-limit",
                ...stats,
                allowance: job.allowance,
              });
            });
            job.pausedBefore = performance.now() - paused;
            job.pausedMs += job.pausedBefore;
            job.limit += job.allowance;
          }
          page = await source.fetchRange(start, length);
          if (!sparse && ahead.pages.size < 4) ahead.remember(start, page);
        }
        if (start === 0 && url === planetURL) snapshot = golPlanetSnapshot(page) ?? snapshot;
        new Uint8Array(api.memory.buffer, destination, length).set(page);
        return 1;
      } catch (error) {
        if (!suggestionStopped() || source.invalidated) transferError = error.message;
        return 0;
      } finally {
        job.pageMs += performance.now() - began;
      }
    },
  );
  const areaFiles = areaIndexFiles(() => api.memory, url, () => job.areaIndex);
  [api] = await Promise.all([
    newEngine({
      get_page: getPage,
      suggestion_stopped: new WebAssembly.Suspending(checkSuggestion),
      fetch_area_file: new WebAssembly.Suspending(async (...args) => {
        const start = performance.now();
        try {
          return await areaFiles.fetch_area_file(...args);
        } finally {
          job.pageMs += performance.now() - start;
        }
      }),
      copy_area_file: areaFiles.copy_area_file,
    }),
    source.open(),
  ]);
  // Without a validator, decoded geometry is reusable only within this open.
  snapshot = JSON.stringify([
    source.size,
    source.etag,
    source.modified,
    source.etag || source.modified
      ? null
      : [performance.timeOrigin, performance.now()],
  ]);
  const error = await WebAssembly.promising(api.open_gol)(
    BigInt(source.size),
    localFile,
  );
  if (error) {
    try {
      result(error);
    } finally {
      api = null;
    }
  }
}

function refreshGolForFallback(gob) {
  if (source?.url === planetURL &&
      (source.invalidated || gob.invalidated || snapshot !== gob.snapshot)) api = null;
}

async function confirmArea(data, area, estimate, details) {
  const { signal } = area.controller;
  signal.throwIfAborted();
  let confirmation;
  if (data.type !== "estimate-area") {
    confirmation = new Promise((resolve) => { area.confirm = resolve; });
  }
  send({ type: "area-estimate", ...details, ...estimate, ...stats });
  if (!confirmation) return false;
  await confirmation;
  area.confirm = null;
  signal.throwIfAborted();
  return true;
}

async function gobDownload(data, area) {
  const { signal } = area.controller;
  let confirmed = false;
  try {
    if (!gobCatalog) {
      const fresh = await GobArea.open(newGobEngine, (length, timing) => reportRead("gob", length, timing), signal);
      if (gobActive?.snapshot !== fresh.snapshot) gobActive = null;
      gobCatalog = gobActive?.matchesArchive(fresh) ? gobActive : fresh;
    }
    const entries = gobCatalog.plan(job.windows);
    const estimate = gobCatalog.estimate(entries);
    const covered = downloadTransport === "gol"
      ? source?.url === data.url && !source.invalidated && insideDownloadedArea(areaDownload?.downloadedWindows, job.windows)
      : gobCatalog === gobActive && insideDownloadedArea(gobActive?.downloadedWindows, job.windows);
    const details = { snapshot: gobCatalog.snapshot, transport: "gob", covered };
    confirmed = await confirmArea(data, area, estimate, details);
    if (confirmed) {
      const before = stats.bytes;
      const downloaded = await gobCatalog.download(entries, signal);
      signal.throwIfAborted();
      gobActive = gobCatalog = downloaded;
      gobActive.downloadedWindows = job.windows;
      downloadTransport = "gob";
      send({
        type: "area-ready", ...details, ...estimate, covered: entries.length > 0,
        bytes: stats.bytes - before,
        wasmMemoryBytes: gobActive.api.memory.buffer.byteLength,
      });
    }
    gobRetryAt = 0;
    return true;
  } catch {
    const failed = gobCatalog;
    if (failed?.invalidated) {
      gobActive = null;
      gobCatalog = null;
    }
    signal.throwIfAborted();
    if (confirmed) gobCatalog = null;
    if (failed) refreshGolForFallback(failed);
    if (!gobCatalog) gobRetryAt = performance.now() + 60000;
    if (confirmed) send({ type: "area-fallback", ...stats });
    return false;
  }
}

function sendResult(value, resultBytes, currentSnapshot, start, transport) {
  send({
    type: "result",
    ...value,
    ...stats,
    snapshot: currentSnapshot,
    resultBytes,
    transport,
    elapsed: performance.now() - start - job.pausedMs,
    timings: queryTimings(),
  });
}

async function gobQuery(start, request) {
  if (job.downloadedOnly && !insideDownloadedArea(gobActive.downloadedWindows, job.windows)) return false;
  try {
    const entries = gobActive.plan(job.windows);
    if (entries.length && entries.every(({ loaded }) => loaded)) {
      const { value, resultBytes, engineMs } = await gobActive.query(request, () => job.downloadedOnly ? 0 : job.limit - stats.bytes);
      job.engineMs = engineMs;
      sendResult(value, resultBytes, gobActive.snapshot, start, "gob");
      return true;
    }
  } catch (error) {
    if (error instanceof GobQueryError) throw error;
    refreshGolForFallback(gobActive);
    if (gobActive.invalidated || error instanceof WebAssembly.RuntimeError) {
      if (gobCatalog === gobActive) gobCatalog = null;
      gobActive = null;
    }
    return false;
  }
  refreshGolForFallback(gobActive);
  return false;
}

function suggestionStopped() {
  const s = job.suggestion;
  return Boolean(s && (s.limited || s.controller.signal.aborted || performance.now() >= s.until));
}

async function checkSuggestion() {
  // Yield periodically even on warm CPU-only scans so a query can preempt them.
  if (performance.now() >= job.suggestion.nextYield) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    job.suggestion.nextYield = performance.now() + 12;
  }
  return Number(suggestionStopped());
}

async function run(data, area, suggestion) {
  const start = performance.now();
  stats = { gets: 0, bytes: 0, cacheBytes: 0 };
  const allowance = transferAllowance(data.localFile === true);
  job = {
    id: data.id,
    area,
    areaIndex: data.areaIndex,
    downloadedOnly: data.downloadedOnly === true,
    suggestion,
    allowance,
    locate: data.locate,
    limit: suggestion ? 2 * 1024 * 1024 : data.locate ? 8 * 1024 * 1024 : allowance,
    interactive: !data.locate && data.pauseAtTransferLimit === true,
    pausedMs: 0,
    pausedBefore: 0,
    hints: data.hints,
    windows: data.request.readWindows ?? data.request.windows,
    planned: false,
    headersPlanned: false,
    prefetchGets: 0,
    storage: {},
    pageMs: 0,
    engineMs: null,
  };
  timings = [];
  transferError = null;
  lastProgress = 0;
  let timer;
  let usingGol = false;
  try {
    if (
      typeof WebAssembly.Suspending !== "function" ||
      typeof WebAssembly.promising !== "function"
    ) {
      throw new Error(
        "This browser needs WebAssembly JS Promise Integration. Use a current Chrome, Firefox or Safari release.",
      );
    }
    area?.controller.signal.throwIfAborted();
    if (hostedPages) checkParentLookups(data.request.sets);
    if (suggestion) {
      suggestion.controller.signal.throwIfAborted();
      suggestion.until = start + 1200;
      suggestion.nextYield = start + 12;
      timer = setTimeout(() => suggestion.controller.abort(), 1200);
    }
    const publicPlanet = data.publicPlanet === true && data.url === planetURL;
    const indexedAreas = !area && !data.locate && !suggestion &&
      hasNamedAreas(data.request);
    const request = area || data.locate ? null : encoder.encode(JSON.stringify(data.request));
    if (job.downloadedOnly && (data.locate || indexedAreas || !job.windows.length))
      return send({ type: "outside-download" });
    if (job.downloadedOnly && data.request.readWindows)
      job.windows = [...data.request.windows, ...job.windows];
    if (publicPlanet && !suggestion) {
      if (area && (data.type === "plan-area" || performance.now() >= gobRetryAt)) {
        if (await gobDownload(data, area)) return;
      }
      if (request && gobActive && (!job.downloadedOnly || downloadTransport === "gob")) {
        // A named area can be outside every tile in the downloaded GOB view.
        if (indexedAreas) refreshGolForFallback(gobActive);
        else if (await gobQuery(start, request)) return;
        else if (job.downloadedOnly) return send({ type: "outside-download" });
      }
    }
    if (job.downloadedOnly && (downloadTransport !== "gol" || !api || source.url !== data.url || source.invalidated ||
        !insideDownloadedArea(areaDownload?.downloadedWindows, job.windows))) return send({ type: "outside-download" });
    usingGol = true;
    if (!api || source.url !== data.url || source.invalidated) {
      if (area) area.opening = true;
      try {
        await open(data.url, data.localFile === true);
      } finally {
        if (area) area.opening = false;
      }
    }
    if (suggestion) source.signal = suggestion.controller.signal;
    if (area) {
      if (area.stopAfterOpen) return;
      const { signal } = area.controller;
      signal.throwIfAborted();
      source.signal = signal;
      areaDownload ??= new AreaDownload(source, ahead, (start, length) => {
        const ptr = api.cached_block(BigInt(start)) >>> 0;
        return ptr ? new Uint8Array(api.memory.buffer, ptr, length) : null;
      }, data.localFile === true);
      const estimate = await areaDownload.plan(job.windows);
      const covered = downloadTransport === "gol" && insideDownloadedArea(areaDownload.downloadedWindows, job.windows);
      if (!await confirmArea(data, area, estimate, { snapshot, covered })) return;
      const before = stats.bytes;
      await areaDownload.download();
      downloadTransport = "gol";
      signal.throwIfAborted();
      send({ type: "area-ready", snapshot, ...estimate, covered: estimate.tiles > 0, bytes: stats.bytes - before });
      return;
    }
    if (data.locate) {
      job.locateUntil = performance.now() + 3000;
      const view = result(await WebAssembly.promising(api.start_view)());
      if (transferError) throw Error(transferError);
      send({ type: "view", view });
      return;
    }
    const ptr = api.input_buffer(request.length);
    if (!ptr) throw new Error("Reference geometry is too large.");
    new Uint8Array(api.memory.buffer, ptr, request.length).set(request);
    if (suggestion) {
      const value = result(await WebAssembly.promising(api.suggest_tags)());
      if (transferError) throw Error(transferError);
      send({ type: "suggestions", ...value, snapshot });
      return;
    }
    job.pageMs = 0;
    const queryStart = performance.now();
    let resultBytes;
    try {
      resultBytes = await WebAssembly.promising(api.query)();
    } finally {
      job.engineMs = Math.max(0, performance.now() - queryStart - job.pageMs);
    }
    if (job.missingPage) return send({ type: "outside-download" });
    sendResult(result(resultBytes), resultBytes, snapshot, start);
  } catch (error) {
    if (job.missingPage) return send({ type: "outside-download" });
    // On an interrupted transfer or failed open the next job gets a fresh source.
    if (usingGol && (transferError || source?.invalidated || error instanceof WebAssembly.RuntimeError))
      api = null;
    send({
      type: "error",
      message: error.message,
      invalidated: usingGol && source?.invalidated === true,
      ...stats,
      timings: queryTimings(),
    });
  } finally {
    clearTimeout(timer);
    if (pendingSuggestion === suggestion) pendingSuggestion = null;
    if (source) source.signal = undefined;
    if (pendingArea === area) pendingArea = null;
  }
}

let pendingArea, pendingSuggestion, queue = Promise.resolve();
onmessage = ({ data }) => {
  if (data.type === "cancel-suggestion") {
    if (pendingSuggestion?.id === data.id) pendingSuggestion.controller.abort();
    return;
  }
  if (data.type === "continue") {
    job?.resume?.();
    if (job) job.resume = null;
    return;
  }
  if (data.type === "confirm-area" || data.type === "cancel-area") {
    if (pendingArea && pendingArea.id === data.id) {
      if (data.type === "cancel-area") {
        // A foreground request for this GOL can use the metadata already in flight.
        if (pendingArea.opening && pendingArea.estimateOnly && pendingArea.url === data.reuseSource)
          pendingArea.stopAfterOpen = true;
        else pendingArea.controller.abort();
      }
      pendingArea.confirm?.();
    }
    return;
  }
  // A cancelled download drains its in-flight reads before the next query
  // enters Wasm. Keep the open snapshot and its previously downloaded area.
  const isArea = data.type === "plan-area" || data.type === "estimate-area";
  const area = isArea ? {
    id: data.id, url: data.url, estimateOnly: data.type === "estimate-area",
    controller: new AbortController(),
  } : null;
  if (area) pendingArea = area;
  const suggestion = data.type === "suggest-tags" ? { id: data.id, controller: new AbortController() } : null;
  if (suggestion) pendingSuggestion = suggestion;
  queue = queue.then(() => run(data, area, suggestion));
  return queue;
};
