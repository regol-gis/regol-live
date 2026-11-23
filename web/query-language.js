import { hostedPages, parentsOfMessage } from "./site-mode.js";

// GOQL inside tag brackets remains opaque to the spatial query language.
export const predicates = new Map([
  ["intersects", "Intersects"],
  ["within", "Within"],
  ["contains", "Contains"],
  ["covered_by", "Covered by"],
  ["touches", "Touches"],
  ["overlaps", "Overlaps"],
  ["crosses", "Crosses"],
  ["disjoint", "Disjoint from"],
  ["within_distance", "Within distance of"],
]);
export const setPredicates = new Map([
  ["except", "Except"],
  ["parents_of", "Parents of"],
  ["members_of", "Members of"],
]);
export function takesRole(predicate) {
  return predicate === "parents_of" || predicate === "members_of";
}
if (hostedPages) setPredicates.delete("parents_of");
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
function diagnostic(text, start, end, message, details) {
  const lines = text.slice(0, start).split("\n");
  const error = new SyntaxError(`Line ${lines.length}, column ${lines.at(-1).length + 1}: ${message}`);
  return Object.assign(error, { start, end }, details);
}

// Suggest a unique name one edit away, including a transposed pair.
function nearName(a, b) {
  if (a.length > b.length) return nearName(b, a);
  if (b.length - a.length > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length < b.length) return a.slice(i) === b.slice(i + 1);
  return a.slice(i + 1) === b.slice(i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}

// Split only at the workspace grammar's boundaries. GOQL tag text and quoted
// role names pass through verbatim. Locations use the editor's line and column.
function pipelineParts(text) {
  const parts = [];
  let line = 1, column = 1, start, content = "", quote, brackets = [];
  let stage = false, pipe, terminator, i;
  const at = () => ({ line, column, offset: i });
  const fail = (pos, message, details) => {
    throw diagnostic(text, pos.offset, pos.offset + 1, message, details);
  };
  const flush = () => {
    if (!start) return;
    parts.push({ ...start, text: content.trimEnd(), stage });
    content = "";
    start = undefined;
    stage = false;
    pipe = undefined;
  };
  for (i = 0; i < text.length; i++, column++) {
    const c = text[i];
    if (!quote && brackets.at(-1)?.char !== "[" && c === "/" && text[i + 1] === "/") {
      const comment = i;
      while (i + 1 < text.length && text[i + 1] !== "\n") { i++; column++; }
      if (start && brackets.length) content += " ".repeat(i - comment + 1);
      continue;
    }
    if (!quote && !brackets.length && (c === "|" || c === ";" || c === "\n")) {
      if (!start && pipe && c !== "\n") fail(pipe, "Add a filter after |, for example where [name].");
      flush();
      if (c === ";") terminator = at();
      if (c === "|") {
        if (terminator) fail(terminator, "A semicolon ends the statement. Remove it to continue the pipeline.", {
          repair: { label: "Remove semicolon", text: "" },
        });
        stage = true;
        pipe = at();
      }
    } else {
      if (!start && !/\s/.test(c)) { start = at(); terminator = undefined; }
      if (start) content += c;
      if (quote) {
        if (c === "\\" && i + 1 < text.length) {
          const next = text[++i];
          content += next;
          column++;
          if (next === "\n") { line++; column = 0; }
        } else if (c === quote.char) quote = undefined;
      } else if (c === "'" || c === '"') {
        quote = { ...at(), char: c };
      } else if (c === "[" || (c === "(" && brackets.at(-1)?.char !== "[")) {
        brackets.push({ ...at(), char: c });
      } else if (c === "]" || (c === ")" && brackets.at(-1)?.char !== "[")) {
        if (brackets.at(-1)?.char !== (c === "]" ? "[" : "(")) fail(at(), `Unexpected ${c}.`);
        brackets.pop();
      }
    }
    if (c === "\n") { line++; column = 0; }
  }
  if (quote) fail(quote, `Close the ${quote.char} quote opened here.`, { unfinished: true });
  const open = brackets.at(-1);
  if (open) fail(open, `Close the ${open.char} opened here with ${open.char === "[" ? "]" : ")"}.`, { unfinished: true });
  if (!start && pipe) fail(pipe, "Add a filter after |, for example where [name].", { unfinished: true });
  flush();
  return parts;
}
// Check the outer selector shape here. Regol parses keys, values and operators.
const quotedOrTag = /\[(?:[^\[\]"']|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')*\]/g;
function selectorShape(text) {
  return text.replace(quotedOrTag, "[]");
}
function parseFilter(text, problem) {
  if (/^where\b/.test(text)) {
    const tags = text.slice(5).trim();
    if (!/^(?:\[\]\s*)+$/.test(selectorShape(tags)) || !tags.startsWith("["))
      throw problem(tags || "where", "Follow where with GOQL tag brackets, for example where [name][amenity=cafe].");
    return { predicate: "where", tags };
  }
  const op = /^[a-z_]\w*/i.exec(text)?.[0];
  if (hostedPages && op === "parents_of")
    throw problem(op, parentsOfMessage);
  if (!op || !(predicates.has(op) || setPredicates.has(op))) {
    if (text.startsWith("[")) throw Error("Use where before tag brackets, for example | where [name].");
    throw Error(`Unknown filter ${JSON.stringify(op ?? text)}. Use where [name], within($parks), or another filter from Query syntax.`);
  }
  const m = /^([a-z_]+)\s*\(\s*\$([A-Za-z_]\w*)\s*(?:,\s*([\s\S]*?))?\s*\)$/.exec(text);
  if (!m) {
    const message = `Use ${op}($set${op === "within_distance" ? ", 100" : ""}) with a $ before the reference name.`;
    const open = text.indexOf("(");
    const arg = text.slice(open + 1).split(/[,)]/, 1)[0];
    if (open >= 0 && !arg.trim()) throw problem("", message, open + 1 + arg.length, true);
    throw problem(arg.trim() || op, message, undefined, text === op);
  }
  const [, predicate, reference, arg] = m;
  const filter = { predicate, reference };
  if (setPredicates.has(predicate) && reference === "geometry")
    throw problem("$" + reference, `${predicate} needs a named set of OSM features.`);
  if (predicate === "within_distance") {
    filter.meters = Number(arg);
    if (!/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?$/i.test(arg) ||
        !Number.isFinite(filter.meters) || filter.meters < 0)
      throw problem(arg || ")", `Enter a nonnegative number of metres, for example within_distance($${reference}, 100).`);
  } else if (takesRole(predicate) && arg !== undefined) {
    try {
      filter.role = JSON.parse(arg);
      if (typeof filter.role !== "string") throw Error();
    } catch {
      throw problem(arg || ")", `Use a double-quoted member role, for example ${predicate}($${reference}, "stop").`);
    }
  } else if (arg !== undefined) {
    throw problem(arg || ",", `${predicate} takes only a reference set.`);
  }
  return filter;
}
// A GOQL area can be either an OSM way or an OSM relation.
export function selectorKinds(source) {
  const kinds = new Set();
  for (const branch of selectorShape(source).split(",")) {
    const types = /^([nwar]+)(?=\s*(?:\[|$))/.exec(branch.trim())?.[1];
    if (!types) return new Set(["n", "w", "r"]);
    for (const kind of types.replaceAll("a", "wr")) kinds.add(kind);
  }
  return kinds;
}
export function parseDraft(program, selectors) {
  const sets = [], known = new Set(["geometry"]);
  let show = null, standalone = false;
  for (const part of pipelineParts(program)) {
    const { text, stage, offset } = part;
    const requireSet = (name, localOffset, excluded = []) => {
      if (known.has(name)) return;
      const available = [...known].filter(n => !excluded.includes(n));
      const similar = available.filter(n => nearName(name, n));
      const suggestion = similar.length === 1 ? "$" + similar[0] : null;
      const earlier = available.filter(n => n !== "geometry").slice(-4).map(n => "$" + n);
      const hint = suggestion ? ` Did you mean ${suggestion}?` :
        earlier.length ? " Earlier sets include " + earlier.join(", ") + "." : "";
      const start = offset + localOffset;
      throw diagnostic(program, start, start + name.length + 1, `Define $${name} before using it.${hint}`,
        suggestion ? { repair: { label: "Replace with " + suggestion, text: suggestion } } : {});
    };
    try {
      if (show) throw Error("show(...) must be the final statement.");
      if (stage) {
        const set = sets.at(-1);
        if (!set) throw Error("Start the pipeline with a GOQL selector or an earlier set before |.");
        const filter = parseFilter(text, (token, message, localOffset = text.lastIndexOf(token), unfinished = false) => {
          const start = offset + localOffset, end = start + token.length;
          return diagnostic(program, start, end, message,
            unfinished ? { unfinished: true, unfinishedUntil: end } : {});
        });
        if (filter.predicate === "where" && selectors) {
          const i = text.indexOf("[") - 1; // Rust validates a synthetic * prefix.
          selectors.push({ text: "*" + filter.tags, offset: offset + i, line: part.line, column: part.column + i });
        }
        if (filter.reference) {
          if (!standalone && filter.reference === set.name) {
            const start = offset + text.indexOf("$");
            throw diagnostic(program, start, start + set.name.length + 1, "A set cannot reference itself.");
          }
          requireSet(filter.reference, text.indexOf("$"), setPredicates.has(filter.predicate) ? [set.name, "geometry"] : [set.name]);
        }
        set.filters.push(filter);
        continue;
      }
      if (standalone) throw Error("A standalone pipeline displays itself. To add statements, assign the pipeline to a named set and end with show($set).");
      if (/^show\b/.test(text)) {
        const output = /^show\s*\(([\s\S]*)\)$/.exec(text);
        if (!output) throw Error("Write show($set), with the output names in parentheses.");
        const names = output[1].trim() ? output[1].split(",").map(v => v.trim()) : [];
        if (!names.length && !sets.length) throw Error("Choose a set to display, for example show($geometry).");
        show = [];
        let searchFrom = text.indexOf("(") + 1;
        for (const ref of names) {
          const position = text.indexOf(ref, searchFrom);
          searchFrom = position + ref.length;
          if (!ref.startsWith("$") || !namePattern.test(ref.slice(1))) throw diagnostic(program, offset + position, offset + position + ref.length,
            "Use $ before each output name, for example show($cafes, $parks).",
            known.has(ref) ? { repair: { label: "Insert $" + ref, text: "$" + ref } } : {});
          const name = ref.slice(1);
          requireSet(name, position, show);
          if (show.includes(name)) throw diagnostic(program, offset + position, offset + position + ref.length,
            `Remove the repeated $${name} from show(...).`);
          show.push(name);
        }
        continue;
      }
      const assignment = /^\$([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(text);
      if (!assignment && sets.length)
        throw Error("Give this pipeline a name, for example $cafes = na[amenity=cafe], then choose the outputs with show(...).");
      const name = assignment?.[1] ?? "result";
      const source = assignment ? assignment[2].trim() : text;
      if (known.has(name)) throw Error(`$${name} is already defined. Choose a different name.`);
      if (!source) throw Error("Enter a selector or an earlier $set after =.");
      if (source.startsWith("$")) {
        const tagged = /^(\$\w+)\s*(\[[\s\S]*)$/.exec(source);
        if (tagged) throw Error(`Filter a named set with ${tagged[1]} | where ${tagged[2]}.`);
        if (!namePattern.test(source.slice(1))) throw Error("Use a set name like $cafes, or assign one with $cafes = na[amenity=cafe].");
        requireSet(source.slice(1), text.length - source.length, ["geometry"]);
        if (source === "$geometry") throw Error("Use $geometry in a spatial filter or display it with show($geometry).");
      } else if (!/^(?:[nwar*]+\s*(?:\[\]\s*)*)(?:,\s*[nwar*]+\s*(?:\[\]\s*)*)*$/.test(selectorShape(source))) {
        throw Error("Start with a GOQL feature type (n, w, a, r or *), for example na[amenity=cafe]. Separate pipeline filters with |.");
      }
      if (!source.startsWith("$") && selectors) {
        const i = text.length - source.length;
        selectors.push({ text: source, offset: offset + i, line: part.line, column: part.column + i });
      }
      standalone = !assignment;
      if (assignment) known.add(name);
      sets.push({ name, source, filters: [] });
    } catch (error) {
      if (error instanceof SyntaxError && error.start !== undefined) throw error;
      const word = /^\w+/.exec(text)?.[0];
      const prefix = stage && word === text &&
        ["where", ...predicates.keys(), ...setPredicates.keys()].some(op => op.startsWith(word) && op !== word);
      throw diagnostic(program, offset, offset + (word?.length || 1), error.message,
        prefix ? { unfinished: true, unfinishedUntil: offset + word.length } : {});
    }
  }
  if (standalone) return { sets, show: ["result"], standalone: true };
  if (show && !show.length) return { sets, show, emptyShow: true };
  return { sets, show: show ?? [] };
}
export function parseProgram(text, selectors) {
  return runnableProgram(parseDraft(text, selectors));
}
export function runnableProgram(plan) {
  if (!plan.show.length)
    throw Error(queryWarning(plan) || "Enter a GOQL selector, for example na[amenity=cafe].");
  return plan;
}
function formatFilter(f) {
  if (f.predicate === "where") return "where " + f.tags;
  const args = ["$" + f.reference];
  if (f.predicate === "within_distance") args.push(f.meters);
  if (f.role !== undefined) args.push(JSON.stringify(f.role));
  return `${f.predicate}(${args.join(", ")})`;
}
export function formatProgram({ sets, show, standalone }) {
  const bare = standalone && sets.length === 1 && sets[0].name === "result" && show.length === 1 && show[0] === "result";
  const statements = sets.map(
    ({ name, source, filters }) =>
      (bare ? source : `$${name} = ${source}`) +
      filters.map((f) => "\n  | " + formatFilter(f)).join(""),
  );
  if (bare) return statements[0];
  return [
    ...statements,
    `show(${show.map((name) => "$" + name).join(", ")})`,
  ].join("\n");
}
// Count only live uses. A shown set and a set used as a spatial or membership
// reference must keep its identity.
export function liveUses({ sets, show }) {
  const uses = new Map();
  const use = name => uses.set(name, (uses.get(name) ?? 0) + 1);
  for (const name of show) use(name);
  for (let i = sets.length - 1; i >= 0; i--) {
    const { name, source, filters } = sets[i];
    if (!uses.has(name)) continue;
    if (source.startsWith("$")) use(source.slice(1));
    for (const filter of filters) if (filter.reference) use(filter.reference);
  }
  return uses;
}

export function queryWarning({ sets, show, emptyShow }) {
  if (!show.length) {
    const last = sets.at(-1);
    if (emptyShow && last) return `Choose an output in show(), for example show($${last.name}).`;
    return last ? `Add show($${last.name}) at the end to display results.` : "";
  }
  const needed = liveUses({ sets, show });
  const unused = sets
    .filter((s) => !needed.has(s.name))
    .map((s) => "$" + s.name);
  if (!unused.length) return "";
  return (
    unused.join(", ") +
    (unused.length === 1 ? " is unused." : " are unused.") +
    " Only sets needed by show() are evaluated."
  );
}
export const examples = new Map([
  ["Cafés", "na[amenity=cafe]"],
  ["Buildings", "a[building]"],
  ["Roads", "w[highway]"],
  [
    "Cafés with outdoor seating",
    "na[amenity=cafe][outdoor_seating=yes]",
  ],
  [
    "Named pedestrian streets",
    "w[highway=pedestrian] | where [name]",
  ],
  [
    "Named cafés within 100 m of a bus stop",
    "$stops = n[highway=bus_stop]\n$cafes = na[amenity=cafe][name]\n  | within_distance($stops, 100)\nshow($cafes)",
  ],
  [
    "Cafés over 100 m from every selected bus stop",
    "$stops = n[highway=bus_stop]\n$cafes = n[amenity=cafe]\n$near = $cafes | within_distance($stops, 100)\n$far = $cafes | except($near)\nshow($far)",
  ],
  [
    "Bus routes serving selected stops",
    "$stops = n[public_transport=stop_position]\n$routes = r[type=route][route=bus] | parents_of($stops)\nshow($routes)",
  ],
  [
    "Stop members of bus routes",
    '$routes = r[type=route][route=bus]\n$stops = n | members_of($routes, "stop")\nshow($stops)',
  ],
  [
    "Benches in parks and gardens",
    "$parks = a[leisure=park,garden]\n$benches = n[amenity=bench]\n  | within($parks)\nshow($benches)",
  ],
  [
    "Footpaths crossing park or garden boundaries",
    "$parks = a[leisure=park,garden]\n$paths = w[highway=footway,path]\n  | crosses($parks)\nshow($paths)",
  ],
  [
    "Cafés near park benches",
    "$parks = a[leisure=park,garden]\n$benches = n[amenity=bench]\n  | within($parks)\n$cafes = na[amenity=cafe]\n  | within_distance($benches, 150)\nshow($benches, $cafes)",
  ],
]);
if (hostedPages) examples.delete("Bus routes serving selected stops");
