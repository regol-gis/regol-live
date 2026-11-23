import assert from "node:assert/strict";

export async function checkTagEditor(page) {
  const editor = page.locator("#selector");
  const original = await editor.inputValue();
  const list = page.getByRole("listbox", { name: "Features matching selector in view" });
  await editor.fill("$x = na[amenity=ca");
  const cafe = list.getByRole("option").filter({ hasText: /^cafe[1-9]/ });
  await cafe.waitFor();
  await editor.press("f");
  assert(await cafe.isVisible(), "the cached tally filters immediately");
  await editor.press("ArrowDown");
  await editor.press("Enter");
  assert.equal(await editor.inputValue(), "$x = na[amenity=cafe");
  assert(await list.isHidden());

  await editor.fill("$x = na[amenity=cafe]\nshow($x)");
  await page.click("#open-builder");
  const source = page.locator("#builder [data-source]").first();
  await source.fill("na[amenity=cafe][o");
  const outdoor = list.getByRole("option").filter({ hasText: /^outdoor_seating\d/ });
  await outdoor.click();
  assert.equal(await source.inputValue(), "na[amenity=cafe][outdoor_seating");
  await source.fill("na[amenity=cafe][na");
  await source.press("Escape");
  assert(await list.isHidden());
  assert(await page.locator("#builder").isVisible());
  await page.click("#cancel-builder");

  const warning = page.locator("#query-warning");
  const outdoorCount = async (field, text) => {
    await field.fill(text);
    const row = list.getByRole("option").filter({hasText: /^outdoor_seating[1-9]/});
    await row.waitFor();
    return row.innerText();
  };
  const count = await outdoorCount(editor, "na[amenity=cafe][outd");
  assert(await warning.isHidden());
  assert.equal(await outdoorCount(editor, "$cafes=na[amenity=cafe]; $x=$cafes | where [outd"), count);
  await editor.blur();
  await warning.waitFor();
  assert.match(await warning.innerText(), /Close the/);
  await editor.fill("$cafes=na[amenity=cafe]; $x=$cafes | where [name]; show($x)");
  await page.click("#open-builder");
  assert.equal(await outdoorCount(page.locator("#builder [data-where]"), "[outd"), count);
  await page.click("#cancel-builder");

  await editor.fill("$parks=a; $x=n | wit");
  await page.getByRole("option", {name:"within($set)", exact:true}).click();
  assert(await warning.isHidden(), "a filter snippet is ready for its reference");
  await page.getByRole("option", {name:"$parks", exact:true}).click();
  assert.equal(await editor.inputValue(), "$parks=a; $x=n | within($parks)");
  await page.getByRole("button", {name:"Insert show($x)", exact:true}).click();
  assert.equal(await editor.inputValue(), "$parks=a; $x=n | within($parks)\nshow($x)");
  await editor.fill("$parks=a; $x=n | within($praks); show($x)");
  await editor.press("Control+Enter");
  await page.waitForFunction(() => {
    const field = document.querySelector("#selector");
    return field.value.slice(field.selectionStart, field.selectionEnd) === "$praks";
  });
  await page.getByRole("button", {name:"Replace with $parks", exact:true}).click();
  assert.equal(await editor.inputValue(), "$parks=a; $x=n | within($parks); show($x)");
  await editor.fill("$x=n; | where [name]; show($x)");
  await page.getByRole("button", {name:"Remove semicolon", exact:true}).click();
  assert.equal(await editor.inputValue(), "$x=n | where [name]; show($x)");

  await editor.fill(original);
  await editor.blur();
}

export async function checkSuggestionCounts(staticPage, nativeBase) {
  const window = [7.407, 43.72, 7.44, 43.75];
  const request = { windows: [window, window], selector: "na", key: "amenity", prefix: "ca" };
  const response = await fetch(new URL("api/suggest-tags", nativeBase), {
    method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  assert(response.headers.get("x-regol-snapshot"));
  const native = await response.json();
  assert(native.complete);
  assert.equal(native.items.find((s) => s.text === "cafe").count, 27);
  const wasm = await staticPage.evaluate(async (request) => {
    const { RangeQueries } = await import("./query-backend.js");
    const backend = new RangeQueries();
    const url = new URL("./data/monaco-2026-01-01.gol", location.href).href;
    try {
      const scanned = await backend.suggest({ url, request }, new AbortController().signal);
      const worker = backend.worker;
      const superseded = backend.suggest({ url, request }, new AbortController().signal);
      const result = await new Promise((resolve, reject) => backend.run({ url, request: {
        windows: request.windows, sets: [{ name: "cafes", source: "na[amenity=cafe]" }],
        show: ["cafes"], output: "count",
      } }, (data) => {
        if (data.type === "result") resolve(data);
        if (data.type === "error") reject(Error(data.message));
      }, reject));
      return { scanned, superseded: await superseded, count: result.counts.total,
        warm: backend.worker === worker, gets: result.gets };
    } finally {
      backend.cancel();
    }
  }, request);
  assert.deepEqual(wasm.scanned.items, native.items);
  assert(wasm.scanned.complete && wasm.warm && wasm.superseded === null);
  assert.equal(wasm.count, 27);
  assert.equal(wasm.gets, 0, "the foreground query reuses the worker's warm pages");
}
