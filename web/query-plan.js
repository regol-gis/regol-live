// Translate workspace filters into the set operations understood by both backends.
import { liveUses, selectorKinds, setPredicates } from "./query-language.js";

function membershipSteps(filter, candidates, references) {
  const steps = [];
  const { reference, role } = filter;
  const add = (direction, kind) => steps.push({
    source: "",
    membership: { direction, reference, ...(role === undefined ? {} : { role }) },
    overpass: { kind, tags: [] },
  });
  if (filter.predicate === "members_of") {
    if (references.has("r")) add("r", candidates.size === 1 && candidates.has("n") ? "node" : "nwr");
    if (role === undefined && references.has("w") && candidates.has("n"))
      add("w", "node");
  } else {
    if (references.has("n")) {
      const ways = role === undefined && candidates.has("w");
      const relations = candidates.has("r");
      if (ways) add("bn", relations ? "wr" : "way");
      else if (relations) add("bn", "relation");
    }
    if (candidates.has("r") && references.has("w")) add("bw", "relation");
    if (candidates.has("r") && references.has("r")) add("br", "relation");
  }
  return steps;
}

export function executionPlan(draft, windows) {
  const sets = [];
  const kinds = new Map(), inline = new Map();
  const uses = liveUses(draft);
  const singleInputs = new Set();
  for (const set of draft.sets) {
    if (uses.has(set.name) && set.source.startsWith("$")) {
      const input = set.source.slice(1);
      if (uses.get(input) === 1) singleInputs.add(input);
    }
  }
  for (const { name, source, filters } of draft.sets) {
    // All authored selectors have been validated before this lowering pass.
    if (!uses.has(name)) continue;
    const input = source.startsWith("$") ? source.slice(1) : null;
    const candidateKinds = input ? kinds.get(input) : selectorKinds(source);
    kinds.set(name, candidateKinds);
    let current = inline.get(input) ?? { source, filters: [] };
    let tagOnly = true;
    inline.delete(input);
    // Colons cannot occur in user-defined names. Keep the owner for progress reporting.
    const save = step => {
      const id = name + ":" + sets.length;
      sets.push({ ...step, name: id });
      return id;
    };
    const inputName = () => current.source.startsWith("$") && !current.filters.length
        ? current.source.slice(1) : save(current);
    for (const filter of filters) {
      if (filter.predicate === "where") {
        if (/^[nwar*]+$/.test(current.source) && !current.filters.length) {
          // A type-only scan can use the tag index directly.
          current.source += filter.tags;
        } else {
          current.filters.push({ selector: "*" + filter.tags });
        }
        continue;
      }
      tagOnly = false;
      if (!setPredicates.has(filter.predicate)) {
        current.filters.push(filter);
        continue;
      }
      if (filter.predicate === "except") {
        current = { source: "", difference: [inputName(), filter.reference], filters: [] };
        continue;
      }
      const steps = membershipSteps(filter, candidateKinds, kinds.get(filter.reference));
      if (steps.length && current.source === "n" && !current.filters.length &&
          windows.every(([west, , east]) => west > -180 && east < 180)) {
        // Clip linked nodes directly: scanning every node in a city can exhaust
        // the set budget. At the antimeridian retain GOQL's exact window semantics.
        for (const step of steps) step.overpass.windows = windows;
      } else {
        const input = inputName();
        // Intersect during traversal to keep unrelated members out of stored sets.
        for (const step of steps) step.intersect = [input];
        if (!steps.length) steps.push({ source: "", difference: [input, input] });
      }
      current = steps.length === 1 ? steps[0] : { source: "", union: steps.map(save) };
      current.filters = [];
    }
    // Spatial references and set operations have their own preparation budgets
    // and skipped-geometry counts. Preserve those boundaries when fusing.
    if (singleInputs.has(name) && tagOnly)
      inline.set(name, current);
    else sets.push({ ...current, name });
  }
  return { sets, show: draft.show };
}

export function emptyReferenceNotes(draft, steps, view) {
  if (!view.complete || !view.setStats?.length) return [];
  const empty = new Set(), references = new Map();
  for (const { setIndex, matchesKept, retained } of view.setStats) {
    const step = steps[setIndex];
    if (!matchesKept && !retained) empty.add(step.name);
    const owner = step.name.split(":")[0];
    if (!references.has(owner)) references.set(owner, new Set());
    const used = references.get(owner);
    for (const filter of step.filters ?? []) if (filter.reference) used.add(filter.reference);
    if (step.membership) used.add(step.membership.reference);
    if (step.difference) used.add(step.difference[1]);
  }
  const notes = new Set();
  for (const set of draft.sets) {
    for (const { predicate, reference } of set.filters) {
      // A stat can describe an independently shown set even if the planner
      // never needed it for this filter (e.g. incompatible membership types).
      if (!empty.has(reference) || !references.get(set.name)?.has(reference)) continue;
      const effect = predicate === "disjoint" || predicate === "except"
        ? "excluded no candidates" : "matched no candidates";
      notes.add(`$${reference} contained no usable features in this view. In $${set.name}, ${predicate} ${effect}.`);
    }
  }
  return [...notes];
}
