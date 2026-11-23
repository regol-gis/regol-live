import {
  formatProgram,
  parseDraft,
  parseProgram,
  predicates,
  setPredicates,
  takesRole,
  queryWarning,
} from "./query-language.js";

const $ = (id) => document.getElementById(id);
const dialog = $("builder");
let draft, initial;
export function setsBeforeBuilderFilter(field) {
  const i = Number(field.dataset.setIndex);
  const set = draft.sets[i];
  return [...draft.sets.slice(0, i), { ...set, filters: set.filters.slice(0, Number(field.dataset.where)) }];
}
function control(tag, value, label) {
  const el = document.createElement(tag);
  el.setAttribute("aria-label", label);
  if (tag === "input") el.value = value;
  return el;
}
function field(title, el) {
  const label = document.createElement("label");
  label.append(title, el);
  return label;
}
function button(label, action) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = action;
  return b;
}
function toggleShow(name, checked) {
  draft.show = draft.show.filter((n) => n !== name);
  if (checked) draft.show.push(name);
}
function refreshReferences() {
  for (const select of dialog.querySelectorAll("[data-reference]")) {
    const setIndex = Number(select.dataset.setIndex);
    const f = draft.sets[setIndex].filters[Number(select.dataset.reference)];
    const opts = [
      ...draft.sets.slice(0, setIndex).map((s) => s.name),
      ...(setPredicates.has(f.predicate) ? [] : ["geometry"]),
    ];
    select.replaceChildren(...opts.map((n) => new Option("$" + n, n)));
    if (!opts.includes(f.reference))
      select.add(new Option("$" + f.reference + " (missing)", f.reference));
    select.value = f.reference;
  }
}
function render() {
  const panels = draft.sets.map((set, i) => {
    const panel = document.createElement("fieldset");
    panel.className = "builder-set";
    const legend = document.createElement("legend");
    legend.textContent = "Set " + (i + 1);
    panel.append(legend);
    const name = control("input", set.name, "Set name");
    name.spellcheck = false;
    name.oninput = () => {
      const value = name.value;
      const valid =
        /^[A-Za-z_]\w*$/.test(value) &&
        value !== "geometry" &&
        !draft.sets.some((other) => other !== set && other.name === value);
      name.setCustomValidity(
        valid
          ? ""
          : "Use a unique set name beginning with a letter or underscore. The name geometry is reserved.",
      );
      if (!valid) return;
      const old = set.name;
      set.name = name.value;
      draft.show = draft.show.map((n) => (n === old ? set.name : n));
      for (const [j, later] of draft.sets.entries()) {
        if (j <= i) continue;
        if (later.source === "$" + old) {
          later.source = "$" + set.name;
          $("builder-sets").querySelectorAll("[data-source]")[j].value =
            later.source;
        }
        for (const filter of later.filters)
          if (filter.reference === old) filter.reference = set.name;
      }
      refreshReferences();
    };
    const source = control("input", set.source, "GOQL selector or earlier set");
    source.dataset.source = "";
    source.spellcheck = false;
    source.oninput = () => {
      set.source = source.value;
    };
    const top = document.createElement("div");
    top.className = "set-heading";
    const remove = button("Remove set", () => {
      if (
        draft.sets.some(
          (s, j) =>
            j > i &&
            (s.source === "$" + set.name ||
              s.filters.some((f) => f.reference === set.name)),
        )
      ) {
        showError("Remove uses of $" + set.name + " before removing the set.");
        return;
      }
      draft.sets.splice(i, 1);
      toggleShow(set.name, false);
      render();
    });
    top.append(field("Set name", name), remove);
    const selector = document.createElement("div");
    selector.className = "tag-anchor";
    selector.append(field("GOQL selector or earlier set", source));
    panel.append(top, selector);
    for (const [j, f] of set.filters.entries()) {
      const row = document.createElement("div");
      row.className = "filter-row";
      const pred = control("select", "", "Relationship");
      for (const [value, label] of [["where", "Where tags match"], ...predicates, ...setPredicates]) {
        const option = new Option(label, value);
        option.disabled = !i && setPredicates.has(value);
        pred.add(option);
      }
      pred.value = f.predicate;
      pred.onchange = () => {
        f.predicate = pred.value;
        if (pred.value === "where") {
          delete f.reference;
          f.tags = "[name]";
        } else {
          delete f.tags;
          f.reference ??= draft.sets[i - 1]?.name ?? "geometry";
        }
        if (pred.value === "within_distance") f.meters ??= 100;
        else delete f.meters;
        if (!takesRole(pred.value)) delete f.role;
        if (setPredicates.has(pred.value) && f.reference === "geometry")
          f.reference = draft.sets[i - 1].name;
        render();
      };
      row.append(field("Filter", pred));
      if (f.predicate === "where") {
        const tags = control("input", f.tags, "GOQL tag brackets");
        tags.spellcheck = false;
        tags.dataset.where = j;
        tags.dataset.setIndex = i;
        tags.oninput = () => { f.tags = tags.value; };
        const anchor = field("Tag brackets", tags);
        anchor.classList.add("tag-anchor");
        row.append(anchor);
      } else {
        const ref = control("select", "", "Reference set");
        ref.dataset.reference = j;
        ref.dataset.setIndex = i;
        ref.onchange = () => {
          f.reference = ref.value;
        };
        row.append(field("Reference set", ref));
      }
      if (f.predicate === "within_distance") {
        const m = control("input", f.meters, "Distance in metres");
        m.type = "number";
        m.min = 0;
        m.step = "any";
        m.oninput = () => {
          f.meters = m.valueAsNumber;
        };
        row.append(field("Metres", m));
      }
      if (takesRole(f.predicate)) {
        const match = control("input", "", "Match member role");
        match.type = "checkbox";
        match.checked = f.role !== undefined;
        match.onchange = () => {
          if (match.checked) f.role = "";
          else delete f.role;
          render();
        };
        const label = document.createElement("label");
        label.className = "toggle";
        label.append(match, "Match member role");
        row.append(label);
        if (match.checked) {
          const role = control("input", f.role, "Member role");
          role.oninput = () => { f.role = role.value; };
          row.append(field("Member role", role));
        }
      }
      row.append(
        button("Remove filter", () => {
          set.filters.splice(j, 1);
          render();
        }),
      );
      panel.append(row);
    }
    const bottom = document.createElement("div");
    bottom.className = "set-actions";
    const visible = control("input", "", "Show this set");
    visible.type = "checkbox";
    visible.checked = draft.show.includes(set.name);
    visible.onchange = () => toggleShow(set.name, visible.checked);
    const show = document.createElement("label");
    show.className = "toggle";
    show.append(visible, "Show this set");
    bottom.append(
      button("Add filter", () => {
        set.filters.push({
          predicate: "intersects",
          reference: draft.sets[i - 1]?.name ?? "geometry",
        });
        render();
      }),
      show,
    );
    panel.append(bottom);
    return panel;
  });
  $("builder-sets").replaceChildren(...panels);
  refreshReferences();
  $("show-geometry").checked = draft.show.includes("geometry");
  $("builder-error").hidden = true;
  updateSetWarning();
}
function updateSetWarning() {
  const warning = $("builder-warning");
  const message = draft.sets.length && !draft.show.length
    ? "Select a set to show on the map."
    : queryWarning(draft);
  if (warning.textContent !== message) warning.textContent = message;
}
function showError(message) {
  $("builder-error").textContent = message;
  $("builder-error").hidden = false;
}
export function initBuilder(editor, apply) {
  dialog.addEventListener("input", updateSetWarning);
  dialog.addEventListener("change", updateSetWarning);
  $("open-builder").onclick = () => {
    let parseError;
    try {
      draft = parseDraft(editor.value);
    } catch (error) {
      parseError =
        error.message +
        " Build a replacement here or cancel to keep editing the text.";
      draft = { sets: [], show: [] };
    }
    initial = formatProgram(draft);
    render();
    if (parseError) showError(parseError);
    dialog.showModal();
  };
  $("show-geometry").onchange = (e) => toggleShow("geometry", e.target.checked);
  $("add-set").onclick = () => {
    let n = 1;
    while (draft.sets.some((s) => s.name === "set" + n)) n++;
    const name = "set" + n;
    draft.sets.push({ name, source: "", filters: [] });
    draft.show.push(name);
    render();
    $("builder-sets").lastElementChild.querySelector("[data-source]").focus();
  };
  $("cancel-builder").onclick = $("dismiss-builder").onclick = () =>
    dialog.close();
  $("apply-builder").onclick = () => {
    try {
      const invalid = dialog.querySelector(":invalid");
      if (invalid) {
        invalid.reportValidity();
        return;
      }
      for (const s of draft.sets) {
        if (!/^[A-Za-z_]\w*$/.test(s.name) || !s.source.trim())
          throw Error("Give every set a name and a selector or earlier set.");
      }
      for (const s of draft.sets) s.source = s.source.trim();
      const text = formatProgram(draft);
      // A source field represents one expression. Reject extra DSL statements.
      const parsed = parseProgram(text);
      if (formatProgram(parsed) !== text)
        throw Error("Enter one selector or earlier set in each source field.");
      if (text !== initial) editor.value = text;
      dialog.close();
      apply();
    } catch (error) {
      showError(error.message);
    }
  };
}
