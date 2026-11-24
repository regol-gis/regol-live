import { CursorReader, cursorImports, rangeModule } from "./range-reader.js";
import {
  RangeFile,
  summarizeReadTimings,
  transferAllowance,
} from "./ranges.js";
import { isPlanetFile, utcDate } from "./planet-files.js";
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

async function newEngine(range, compiled) {
  const module = compiled ?? (wasmModule ??= WebAssembly.compileStreaming(fetch("./regol-live.wasm")).catch((error) => {
    wasmModule = null;
    throw error;
  }));
  const instance = await WebAssembly.instantiate(await module, {
    range: {
      fetch_area_file: () => -1, copy_area_file: () => 0,
      query_stopped: new WebAssembly.Suspending(checkQuery), ...range,
    },
  });
  return instance.exports;
}

async function newGobEngine() {
  const api = await newEngine({ get_page: () => 0, suggestion_stopped: () => 0 });
  return { ...api, gob_query: WebAssembly.promising(api.gob_query) };
}

function checkQuery() {
  const now = performance.now();
  if (now < job.nextYield) return Number(job.signal.aborted);
  // Let the worker receive cancellation even when the whole scan is in memory.
  job.nextYield = now + 16;
  return new Promise(resolve => setTimeout(() => resolve(Number(job.signal.aborted)), 0));
}

function beforeGolNetwork(current, signal = current.signal) {
  signal.throwIfAborted();
  if (!current.warnLiveGol) return;
  if (!current.golDecision) {
    // Parallel prefetches share one decision for this query.
    const paused = performance.now();
    current.golDecision = new Promise(resolve => {
      current.allowGol = resolve;
      signal.addEventListener("abort", resolve, { once: true });
    }).then(() => {
      signal.removeEventListener("abort", current.allowGol);
      current.allowGol = null;
      current.warnLiveGol = false;
      current.pausedBefore = performance.now() - paused;
      current.pausedMs += current.pausedBefore;
      if (current.locateUntil) current.locateUntil += current.pausedBefore;
      signal.throwIfAborted();
    });
    send({ type: "confirm-live-gol" });
  }
  return current.golDecision;
}

// Each allowance is granted once, including when several queued reads reach it together.
function extendTransfer(current, signal) {
  signal.throwIfAborted();
  if (!current.interactive) throw Error(
    "GOL transfer limit reached. Narrow the selector or reference query. Large features can extend beyond the map view.",
  );
  if (!current.transferDecision) {
    const paused = performance.now();
    current.transferDecision = new Promise(resolve => {
      current.resume = resolve;
      signal.addEventListener("abort", resolve, { once: true });
    }).then(() => {
      signal.removeEventListener("abort", current.resume);
      current.resume = current.transferDecision = null;
      signal.throwIfAborted();
      current.pausedBefore = performance.now() - paused;
      current.pausedMs += current.pausedBefore;
      current.limit += current.allowance;
    });
    send({ type: "transfer-limit", ...stats, allowance: current.allowance });
  }
  return current.transferDecision;
}

async function open(url, localFile, expectedDate) {
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
  source.signal = job.signal;
  source.beforeNetwork = () => beforeGolNetwork(job, source.signal);
  const remaining = () => job.limit - stats.bytes;
  const getPage = new WebAssembly.Suspending(
    async (offset, destination, length, sparse) => {
      const began = performance.now();
      try {
        if (job.signal.aborted || suggestionStopped()) return 0;
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
        if (job.cursors) return await job.cursors.copy(start, length, api.memory, destination);
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
          job.signal.throwIfAborted();
          if (job.locate && (stats.bytes + length > job.limit || performance.now() > job.locateUntil)) {
            return 0;
          }
          if (stats.bytes + length > job.limit) {
            if (job.suggestion) {
              job.suggestion.limited = true;
              return 0;
            }
            await extendTransfer(job, job.signal);
          }
          page = await source.fetchRange(start, length);
          if (!sparse && ahead.pages.size < 4) ahead.remember(start, page);
        }
        if (start === 0 && isPlanetFile(url, "gol")) snapshot = golPlanetSnapshot(page) ?? snapshot;
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
  // Complete the consent-gated open before starting the engine. Either failure
  // can then finish this job without leaving an orphaned read or dialog.
  await source.open(expectedDate);
  const scheduled = isPlanetFile(url, "gol");
  api = await newEngine({
    ...(scheduled && cursorImports(() => job.cursors, () => api)),
    get_page: getPage,
    suggestion_stopped: new WebAssembly.Suspending(checkSuggestion),
    fetch_area_file: new WebAssembly.Suspending(async (...args) => {
      const start = performance.now();
      try {
        return await areaFiles.fetch_area_file(...args, job.signal);
      } finally {
        job.pageMs += performance.now() - start;
      }
    }),
    copy_area_file: areaFiles.copy_area_file,
  }, scheduled ? rangeModule() : undefined);
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

function golDownload(localFile) {
  return areaDownload ??= new AreaDownload(source, ahead, (start, length) => {
    const ptr = api.cached_block(BigInt(start)) >>> 0;
    return ptr ? new Uint8Array(api.memory.buffer, ptr, length) : null;
  }, localFile);
}

async function gobDownload(data, area) {
  const { signal } = area.controller;
  let confirmed = false;
  try {
    if (!gobCatalog) {
      const fresh = await GobArea.open(newGobEngine, (length, timing) => reportRead("gob", length, timing), signal, data.gobURL, data.gobDate);
      if (gobActive?.snapshot !== fresh.snapshot) gobActive = null;
      gobCatalog = gobActive?.matchesArchive(fresh) ? gobActive : fresh;
    }
    const entries = gobCatalog.plan(job.windows);
    const estimate = gobCatalog.estimate(entries);
    if (estimate.missing && api && source.url === data.url && !source.invalidated) {
      source.signal = signal;
      const warm = await golDownload(false).planFromCache(job.windows);
      if (warm?.tiles && warm.missing < estimate.missing) return false;
    }
    const covered = downloadTransport === "gol"
      ? source?.url === data.url && !source.invalidated && insideDownloadedArea(areaDownload?.downloadedWindows, job.windows)
      : gobCatalog === gobActive && insideDownloadedArea(gobActive?.downloadedWindows, job.windows);
    const details = { snapshot: gobCatalog.snapshot, modified: gobCatalog.validator?.modified, transport: "gob", covered };
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
    modified: transport === "gob" ? gobActive.validator?.modified : source.modified,
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
      const remaining = () => job.downloadedOnly ? 0 : job.limit - stats.bytes;
      const { value, resultBytes, engineMs } = await gobActive.query(request, remaining, job.signal);
      job.engineMs = engineMs;
      sendResult(value, resultBytes, gobActive.snapshot, start, "gob");
      return true;
    }
  } catch (error) {
    if (error instanceof GobQueryError) throw error;
    if (gobActive.invalidated || error instanceof WebAssembly.RuntimeError) {
      if (gobCatalog === gobActive) gobCatalog = null;
      gobActive = null;
    }
    job.signal.throwIfAborted();
    return false;
  }
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

async function run(data, area, suggestion, signal) {
  const start = performance.now();
  stats = { gets: 0, bytes: 0, cacheBytes: 0 };
  const allowance = transferAllowance(data.localFile === true);
  job = {
    id: data.id,
    signal,
    nextYield: start + 16,
    area,
    areaIndex: data.areaIndex,
    downloadedOnly: data.downloadedOnly === true,
    warnLiveGol: !area && !suggestion && !data.downloadedOnly && data.warnLiveGol === true,
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
    signal.throwIfAborted();
    if (hostedPages) checkParentLookups(data.request.sets);
    if (suggestion) {
      suggestion.until = start + 1200;
      suggestion.nextYield = start + 12;
      timer = setTimeout(() => suggestion.controller.abort(), 1200);
    }
    const publicPlanet = data.publicPlanet === true && isPlanetFile(data.url, "gol");
    if (publicPlanet) {
      if (data.gobURL && !isPlanetFile(data.gobURL, "gob")) throw Error("Invalid planet archive URL.");
      const outdated = archive => archive?.url && (archive.url !== data.gobURL ||
        (data.gobDate && utcDate(archive.validator?.modified) !== data.gobDate));
      if (outdated(gobCatalog) || outdated(gobActive)) {
        gobCatalog = gobActive = null;
        gobRetryAt = 0;
      }
      if (api && source.url === data.url && data.golDate && utcDate(source.modified) !== data.golDate)
        api = null;
    }
    const indexedAreas = !area && !data.locate && !suggestion &&
      hasNamedAreas(data.request);
    const request = area || data.locate ? null : encoder.encode(JSON.stringify(data.request));
    if (job.downloadedOnly && (data.locate || indexedAreas || !job.windows.length))
      return send({ type: "outside-download" });
    if (job.downloadedOnly && data.request.readWindows)
      job.windows = [...data.request.windows, ...job.windows];
    const coveredByGol = downloadTransport === "gol" && api && source.url === data.url &&
      !source.invalidated && insideDownloadedArea(areaDownload?.downloadedWindows, job.windows);
    if (publicPlanet && data.gobURL && !suggestion && !coveredByGol) {
      if (area && (data.type === "plan-area" || performance.now() >= gobRetryAt)) {
        if (await gobDownload(data, area)) return;
      }
      if (request && gobActive && !indexedAreas && (!job.downloadedOnly || downloadTransport === "gob")) {
        if (await gobQuery(start, request)) return;
        if (job.downloadedOnly) return send({ type: "outside-download" });
      }
    }
    if (job.downloadedOnly && !coveredByGol) return send({ type: "outside-download" });
    usingGol = true;
    if (!api || source.url !== data.url || source.invalidated) {
      if (area) area.opening = true;
      try {
        await open(data.url, data.localFile === true, data.golDate);
      } finally {
        if (area) area.opening = false;
      }
    }
    source.signal = signal;
    if (area) {
      if (area.stopAfterOpen) return;
      signal.throwIfAborted();
      const estimate = await golDownload(data.localFile === true).plan(job.windows);
      const covered = downloadTransport === "gol" && insideDownloadedArea(areaDownload.downloadedWindows, job.windows);
      if (!await confirmArea(data, area, estimate, { snapshot, modified: source.modified, covered })) return;
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
      signal.throwIfAborted();
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
    if (isPlanetFile(data.url, "gol") && !job.downloadedOnly) {
      let committed = stats.bytes;
      job.cursors = new CursorReader(source, ahead, signal, data.request, async (length, readSignal) => {
        await beforeGolNetwork(job, readSignal);
        // Concurrent reads reserve their bytes before issuing a GET.
        while (committed + length > job.limit) await extendTransfer(job, readSignal);
        committed += length;
      }, ms => { job.pageMs += ms; });
      source.signal = job.cursors.signal;
    }
    const queryStart = performance.now();
    let resultBytes;
    try {
      const query = WebAssembly.promising(api.query);
      if (job.cursors?.planning) {
        // This pass visits checked spatial indexes and skips payload emission.
        const planBytes = await query();
        signal.throwIfAborted();
        if (job.cursors.error) throw job.cursors.error;
        result(planBytes);
        job.cursors.planning = false;
      }
      resultBytes = await query();
    } finally {
      if (job.cursors) {
        await job.cursors.close();
        source.signal = signal;
      }
      job.engineMs = Math.max(0, performance.now() - queryStart - job.pageMs);
    }
    signal.throwIfAborted();
    if (job.cursors?.error) throw job.cursors.error;
    if (source.invalidated) throw Error(transferError || "The dataset changed. Run the query again to reopen it.");
    if (job.missingPage) return send({ type: "outside-download" });
    sendResult(result(resultBytes), resultBytes, snapshot, start);
  } catch (error) {
    // An interrupted read does not invalidate the open dataset or its pinned tiles.
    if (!area && !suggestion && signal.aborted && !source?.invalidated && !(error instanceof WebAssembly.RuntimeError)) return;
    if (job.missingPage) return send({ type: "outside-download" });
    // On an interrupted transfer or failed open the next job gets a fresh source.
    if (usingGol && ((transferError && !job.cursors) || source?.invalidated || error instanceof WebAssembly.RuntimeError))
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
    job.cursors = undefined;
    if (pendingSuggestion === suggestion) pendingSuggestion = null;
    if (source) source.signal = undefined;
    if (pendingArea === area) pendingArea = null;
  }
}

let pendingArea, pendingSuggestion, queue = Promise.resolve();
const queries = new Map();
onmessage = ({ data }) => {
  if (data.type === "allow-live-gol") {
    if (job?.id === data.id) job.allowGol?.();
    return;
  }
  if (data.type === "cancel-query") {
    queries.get(data.id)?.abort();
    return;
  }
  if (data.type === "cancel-suggestion") {
    if (pendingSuggestion?.id === data.id) pendingSuggestion.controller.abort();
    return;
  }
  if (data.type === "continue") {
    if (job?.id === data.id || data.id === undefined) job?.resume?.();
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
  const controller = new AbortController();
  const area = isArea ? {
    id: data.id, url: data.url, estimateOnly: data.type === "estimate-area",
    controller,
  } : null;
  if (area) pendingArea = area;
  const suggestion = data.type === "suggest-tags" ? { id: data.id, controller } : null;
  if (suggestion) pendingSuggestion = suggestion;
  if (!area && !suggestion) queries.set(data.id, controller);
  queue = queue.then(() => run(data, area, suggestion, controller.signal)).finally(() => queries.delete(data.id));
  return queue;
};
