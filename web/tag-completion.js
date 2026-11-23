import { languageContext, tagContext, tagLiteral } from "./tag-context.js";

const vocabulary = {
  access: "yes no private permissive", amenity: "cafe restaurant bench parking school hospital toilets drinking_water",
  barrier: "gate bollard fence wall", bicycle: "yes no designated", bridge: "yes no",
  building: "yes residential apartments house commercial", "building:levels": "",
  crossing: "", cycleway: "", foot: "yes no designated", height: "",
  highway: "residential footway service path primary secondary tertiary bus_stop pedestrian",
  historic: "", landuse: "residential commercial forest grass",
  leisure: "park garden playground pitch", lit: "yes no", maxspeed: "", name: "",
  natural: "tree wood water peak", network: "", office: "", oneway: "yes no",
  opening_hours: "", operator: "", outdoor_seating: "yes no",
  public_transport: "platform stop_position", railway: "rail station tram_stop",
  ref: "", religion: "", route: "", service: "", shop: "supermarket bakery convenience clothes",
  surface: "asphalt paved gravel concrete unpaved", tourism: "hotel attraction museum",
  tunnel: "yes no", waterway: "river stream canal", wheelchair: "yes no limited",
};

function choices(context, result) {
  const { key, prefix } = context;
  const common = key === null ? Object.keys(vocabulary) :
    Object.hasOwn(vocabulary, key) ? vocabulary[key].split(" ").filter(Boolean) : [];
  const items = (result?.items ?? []).filter((item) => item.text.startsWith(prefix) &&
    (key === null || !item.text.includes("*")));
  const observed = new Set(items.map((item) => item.text));
  for (const text of common) {
    if (text.startsWith(prefix) && !observed.has(text)) {
      items.push({ text, numeric: false, count: result?.complete ? 0 : null });
    }
  }
  return items.sort((a, b) => (b.count ?? -1) - (a.count ?? -1) ||
    (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)).slice(0, 8);
}

export function initTagCompletion({ enabled, source, backend, builderSets }) {
  let owner, context, rows = [], selected = -1, timer, controller, lastInput;
  // Only complete tallies are reusable, within the validated dataset snapshot.
  const cache = [];
  const popup = document.createElement("div");
  popup.className = "tag-popup";
  const heading = document.createElement("div");
  heading.className = "tag-heading";
  heading.id = "tag-heading";
  const list = document.createElement("div");
  list.id = "tag-options";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-labelledby", heading.id);
  popup.append(heading, list);
  const number = new Intl.NumberFormat();

  function close() {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    owner?.removeAttribute("aria-activedescendant");
    owner?.removeAttribute("aria-controls");
    owner?.removeAttribute("aria-autocomplete");
    popup.remove();
    owner = context = lastInput = null;
    rows = [];
    selected = -1;
  }

  function highlight(index) {
    selected = index;
    for (const [i, node] of Array.from(list.children).entries()) {
      node.setAttribute("aria-selected", String(i === index));
    }
    if (index >= 0) {
      const row = list.children[index];
      owner.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else owner.removeAttribute("aria-activedescendant");
  }

  function render(result, pending = false) {
    const previous = rows[selected];
    rows = context.options ?? choices(context, result);
    heading.textContent = context.heading ?? (result ? (context.scope || "Features matching selector in view") :
      pending ? "Looking up tags in view…" : "Common tags");
    if (!rows.length && !pending) heading.textContent = result?.complete
      ? (context.scope ? "No matching tags · " + context.scope : "No matching tags in view") : "No suggestions available";
    list.replaceChildren(...rows.map((item, i) => {
      const row = document.createElement("div");
      row.id = "tag-option-" + i;
      row.setAttribute("role", "option");
      row.dataset.index = i;
      const label = document.createElement("span"), count = document.createElement("span");
      label.textContent = context.options ? item.label ?? item.text : tagLiteral(item, context);
      count.textContent = item.count == null ? "" :
        (result.complete ? "" : "≥") + number.format(item.count);
      row.append(label, count);
      return row;
    }));
    if (owner.id === "selector") {
      popup.classList.remove("above");
      list.style.maxHeight = "12rem";
    } else {
      const anchor = popup.parentElement.getBoundingClientRect();
      const frame = owner.closest(".sidebar, .dialog-body").getBoundingClientRect();
      const below = frame.bottom - anchor.bottom, above = anchor.top - frame.top;
      const flip = below < list.scrollHeight + heading.offsetHeight + 12 && above > below;
      popup.classList.toggle("above", flip);
      list.style.maxHeight = Math.max(58, (flip ? above : below) - heading.offsetHeight - 16) + "px";
    }
    highlight(previous ? rows.findIndex((r) => r.text === previous.text && r.numeric === previous.numeric) : -1);
  }

  function accept(index) {
    const item = rows[index], field = owner;
    if (!item || !field || field.value !== lastInput.value ||
        field.selectionStart !== lastInput.caret || field.selectionEnd !== lastInput.caret) return close();
    const insert = context.options ? item.text : tagLiteral(item, context);
    const start = context.start;
    field.setRangeText(insert, start, context.end, "end");
    if (item.cursor !== undefined) field.setSelectionRange(start + item.cursor, start + item.cursor);
    // Notify the editor or builder without reopening the list for our own insertion.
    lastInput = { value: field.value, caret: field.selectionStart };
    field.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    if (item.cursor !== undefined) refresh(field);
  }

  popup.addEventListener("mousedown", (event) => event.preventDefault());
  popup.addEventListener("click", (event) => {
    const row = event.target.closest("[data-index]");
    if (row) accept(Number(row.dataset.index));
  });

  function refresh(field = owner, force = false) {
    if (!field || !field.matches("#selector, [data-source], [data-where]") || !enabled() ||
        field !== document.activeElement || field.selectionStart !== field.selectionEnd) return close();
    const value = field.value, caret = field.selectionStart;
    if (!force && field === owner && value === lastInput?.value && caret === lastInput.caret) return;
    const where = field.hasAttribute("data-where");
    const next = tagContext(value, caret, where ? "where" : field.hasAttribute("data-source"),
      where ? builderSets(field) : []) ?? (field.id === "selector" ? languageContext(value, caret) : null);
    close();
    if (!next) return;
    owner = field;
    context = next;
    lastInput = { value, caret };
    field.setAttribute("aria-autocomplete", "list");
    field.setAttribute("aria-controls", list.id);
    const anchor = field.id === "selector" ? document.getElementById("editor-suggestions") : field.closest(".tag-anchor");
    anchor.append(popup);
    if (context.options) return render(null);
    let dataset;
    try { dataset = source(); } catch { /* A custom URL may still be empty. */ }
    const { selector, key, prefix } = next;
    const scope = dataset && JSON.stringify([dataset.url, dataset.windows, selector, key]);
    const hit = scope && backend.snapshot && cache.find((entry) => entry.scope === scope &&
      entry.result.snapshot === backend.snapshot && prefix.startsWith(entry.result.prefix));
    if (hit) return render(hit.result);
    render(null, Boolean(dataset));
    if (!dataset) return;
    controller = new AbortController();
    const { signal } = controller;
    timer = setTimeout(async () => {
      try {
        const result = await backend.suggest({ ...dataset,
          request: { windows: dataset.windows, selector, key, prefix } }, signal);
        if (signal.aborted || field !== document.activeElement) return;
        if (result?.complete && result.snapshot) {
          cache.unshift({ scope, result });
          cache.splice(4);
        }
        render(result);
      } catch {
        if (!signal.aborted) render(null);
      }
    }, 160);
  }

  document.addEventListener("input", (e) => {
    if (!e.isComposing && e.target.matches("#selector, [data-source], [data-where]")) refresh(e.target);
  });
  document.addEventListener("compositionstart", close);
  document.addEventListener("compositionend", (e) => {
    if (e.target.matches("#selector, [data-source], [data-where]")) refresh(e.target);
  });
  document.addEventListener("focusout", (e) => { if (e.target === owner) close(); });
  document.addEventListener("click", (e) => {
    if (e.target.matches("#selector, [data-source], [data-where]")) refresh(e.target);
  });
  document.addEventListener("keyup", (e) => {
    if (!e.isComposing && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) &&
        e.target.matches("#selector, [data-source], [data-where]")) refresh(e.target);
  });
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.target !== owner || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" && rows.length) highlight((selected + 1) % rows.length);
    else if (e.key === "ArrowUp" && rows.length) highlight(selected < 1 ? rows.length - 1 : selected - 1);
    else if (e.key === "Enter" && selected >= 0) accept(selected);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  return { close, refresh: () => { if (owner) refresh(owner, true); } };
}
