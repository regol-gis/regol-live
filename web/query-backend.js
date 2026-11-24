// Each transport reports results in the format consumed by DisplayCache.
export class RangeQueries {
  id = 0;
  suggestionId = 0;

  constructor(onDownloadChange) {
    this.onDownloadChange = onDownloadChange;
  }

  setDownload(windows) {
    this.hasDownload = Boolean(windows?.length);
    if (JSON.stringify(this.downloadedWindows) === JSON.stringify(windows)) return;
    this.downloadedWindows = windows;
    this.onDownloadChange?.(windows);
  }

  openWorker() {
    if (this.worker) return;
    const worker = this.worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return;
      // An abandoned request can still discover that the snapshot changed.
      if (data.invalidated) this.snapshot = null;
      else if (data.snapshot) this.snapshot = data.snapshot;
      if ("downloadedWindows" in data) this.setDownload(data.downloadedWindows);
      if (typeof data.id === "string") {
        if (data.id !== this.suggestion?.id || data.type === "progress") return;
        this.suggestion.finish(data.type === "suggestions" ? data : null);
        return;
      }
      if (data.id !== this.id || !this.foreground) return;
      const { receive, estimateOnly } = this.foreground;
      if (["result", "view", "area-ready", "outside-download", "error"].includes(data.type) ||
          ((estimateOnly || data.limitBytes) && data.type === "area-estimate")) {
        this.foreground = null;
        this.area = false;
      }
      receive(data);
      this.startSuggestion();
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      const fail = this.foreground?.fail;
      this.reset();
      fail?.(event.message || "The query worker could not start.");
    };
  }

  run(message, receive, fail) {
    if (message.type !== "estimate-area") this.suggestion?.cancel();
    this.openWorker();
    const estimateOnly = message.type === "estimate-area";
    this.area = estimateOnly || message.type === "plan-area";
    this.foreground = { receive, fail, estimateOnly };
    this.worker.postMessage({ ...message, id: ++this.id });
  }

  suggest(message, signal) {
    this.suggestion?.cancel();
    if (signal.aborted) return null;
    this.openWorker();
    return new Promise((resolve) => {
      const id = "suggest-" + ++this.suggestionId;
      const finish = (value) => {
        signal.removeEventListener("abort", cancel);
        this.suggestion = null;
        resolve(value);
      };
      const cancel = () => {
        if (this.suggestion.sent) this.worker.postMessage({ type: "cancel-suggestion", id });
        finish(null);
      };
      this.suggestion = { message, id, finish, cancel, sent: false };
      signal.addEventListener("abort", cancel, { once: true });
      this.startSuggestion();
    });
  }

  startSuggestion() {
    const next = this.suggestion;
    if (!next || next.sent || this.foreground) return;
    next.sent = true;
    this.worker.postMessage({ ...next.message, type: "suggest-tags", id: next.id });
  }

  confirmArea() {
    this.worker?.postMessage({ type: "confirm-area", id: this.id });
  }

  allowLiveGol() {
    this.worker?.postMessage({ type: "allow-live-gol", id: this.id });
  }

  resume() {
    this.worker?.postMessage({ type: "continue", id: this.id });
  }

  cancel({ reuseSource, keepDownload = false } = {}) {
    if (this.area || keepDownload) {
      this.suggestion?.cancel();
      this.foreground = null;
      this.worker?.postMessage({ type: this.area ? "cancel-area" : "cancel-query", id: this.id, reuseSource });
      this.id++;
      this.area = false;
      return;
    }
    this.reset();
  }

  reset() {
    this.suggestion?.cancel();
    this.foreground = null;
    this.worker?.terminate();
    this.worker = null;
    this.snapshot = null;
    this.setDownload(null);
    this.area = false;
    this.id++;
  }
}

export class NativeQueries {
  async suggest({ url, request }, signal) {
    const response = await fetch(new URL("suggest-tags", url), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request), signal,
    });
    if (!response.ok) return null;
    const value = await response.json();
    this.snapshot = response.headers.get("x-regol-snapshot");
    return { ...value, snapshot: this.snapshot };
  }

  async run({ url, request }, receive, fail) {
    const controller = new AbortController();
    this.controller = controller;
    const started = performance.now();
    const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (word) =>
      word.toString(16).padStart(8, "0"),
    ).join("");
    let scan = null, polling = false, receiving = false;
    const report = () => receive({
      type: "native-progress", scan, receiving, elapsed: performance.now() - started,
    });
    const timer = setInterval(async () => {
      report();
      if (receiving || polling) return;
      polling = true;
      try {
        const progress = await fetch(url + "/" + id + "/progress", { signal: controller.signal });
        if (progress.ok) {
          scan = await progress.json();
          if (!receiving && !controller.signal.aborted) report();
        }
      } catch {
        // The result request owns errors and cancellation. A missed poll can be retried.
      } finally {
        polling = false;
      }
    }, 1000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Regol-Query-Id": id },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        throw Error(problem?.error || `Query failed (HTTP ${response.status}).`);
      }
      receiving = true;
      report();
      const bytes = await response.arrayBuffer();
      const result = JSON.parse(new TextDecoder().decode(bytes));
      this.snapshot = response.headers.get("x-regol-snapshot");
      receive({
        ...result,
        type: "result",
        snapshot: this.snapshot,
        elapsed: performance.now() - started,
        resultBytes: bytes.byteLength,
      });
    } catch (err) {
      if (!controller.signal.aborted) fail(err.message);
    } finally {
      clearInterval(timer);
      controller.abort();
      if (this.controller === controller) this.controller = null;
    }
  }

  cancel() {
    this.controller?.abort();
  }
}
