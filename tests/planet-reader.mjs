import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planetURL, transferAllowance } from "../web/ranges.js";

export async function checkPlanetReader(browser, base, sample) {
  assert.equal(transferAllowance(false), 128 * 1024 * 1024);
  assert.equal(transferAllowance(true), 256 * 1024 * 1024);
  const file = await readFile("web" + sample);
  const context = await browser.newContext();
  const step = 384 * 1024;
  let issued = 0, allowed = step, requests = 0, prompts = 0, consent = 0;
  try {
    const page = await context.newPage();
    await context.route(base + "/ranges.js", route => route.fulfill({
      contentType: "text/javascript",
      body: 'export * from "./original-ranges.js"; export const transferAllowance = () => ' + step,
    }));
    await context.route(planetURL, async route => {
      requests++;
      assert.equal(consent, 1, "the first read needs consent");
      const headers = { "Last-Modified": "Tue, 24 Nov 2026 00:00:00 GMT",
        "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Range, Last-Modified",
        "Cache-Control": "no-store" };
      if (route.request().method() === "HEAD")
        return route.fulfill({status: 200, headers: {...headers, "Content-Length": String(file.length)}});
      const [, from, until] = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range);
      const body = file.subarray(Number(from), Number(until) + 1);
      issued += body.length;
      assert(issued <= allowed, "outstanding GETs must fit within the granted allowance");
      return route.fulfill({status: 206, headers: {...headers, "Content-Range": `bytes ${from}-${until}/${file.length}`}, body});
    });
    await page.exposeFunction("grant", kind => {
      if (kind === "consent") { assert.equal(requests, 0); consent++; }
      else { prompts++; allowed += step; }
    });
    const modules = new Set();
    context.on("request", req => modules.add(new URL(req.url()).pathname));
    await page.goto(base + "/build.json");
    const run = (url, guarded) => page.evaluate(({url, guarded}) => new Promise((resolve, reject) => {
      const worker = new Worker("./worker.js", {type: "module"});
      worker.onerror = event => { worker.terminate(); reject(Error(event.message)); };
      worker.onmessage = async ({data}) => {
        if (data.type === "progress") return;
        if (data.type === "confirm-live-gol" || data.type === "transfer-limit") {
          if (guarded) await window.grant(data.type === "confirm-live-gol" ? "consent" : "transfer");
          worker.postMessage({type:data.type === "confirm-live-gol" ? "allow-live-gol" : "continue", id:1});
          return;
        }
        worker.terminate();
        if (data.type !== "result" || data.limited) return reject(Error(data.message ?? data.type));
        resolve({features:data.features, setStats:data.setStats, outputs:data.outputs, counts:data.counts});
      };
      worker.postMessage({id:1,type:"query",url,publicPlanet:guarded,warnLiveGol:guarded,pauseAtTransferLimit:true,
        request:{sets:[{name:"roads",source:"w[highway]"}],show:["roads"],windows:[[7.38,43.71,7.46,43.77]]}});
    }), {url, guarded});
    const control = await run(base + sample, false);
    const scheduled = await run(planetURL, true);
    assert(control.features.length > 0);
    assert.deepEqual(scheduled, control);
    assert(modules.has("/regol-live-range.wasm"));
    assert(prompts > 0);
    assert.equal(prompts, Math.ceil(issued / step) - 1);
  } finally { await context.close(); }
}
