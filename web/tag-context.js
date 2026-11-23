import { parseDraft, predicates, setPredicates } from "./query-language.js";

// Keep source offsets in textarea (UTF-16) units. Group brackets before looking
// for statement or union boundaries: a comma or pipe in a quoted tag is data.
function tokens(text, caret) {
  const top = [];
  const token = /[\p{L}\p{N}_:*.+-]+|!=|!~|<=|>=|[^\s]|\n/gu;
  let bracket;
  for (let m; (m = token.exec(text));) {
    const start = m.index;
    let raw = m[0];
    if (!bracket && text.startsWith("//", start)) {
      const end = text.indexOf("\n", start);
      token.lastIndex = end < 0 ? text.length : end;
      if (start < caret && caret <= token.lastIndex) return [];
      continue;
    }
    if (raw === '"' || raw === "'") {
      let i = start + 1, closed = false;
      while (i < text.length) {
        const c = text[i++];
        if (c === raw) { closed = true; break; }
        if (c === "\n" && /^[ \t]*(?:\$\w+\s*=|show\s*\(|\|)/.test(text.slice(i))) break;
        if (c === "\\") i++;
      }
      if (!closed) {
        // A missing quote should never replace a following bracket or statement.
        const boundary = /[\]\n]/g;
        boundary.lastIndex = start + 1;
        i = boundary.exec(text)?.index ?? text.length;
      }
      token.lastIndex = i;
      raw = text.slice(start, i);
    }
    if (raw === "[") {
      if (bracket) bracket.end = start;
      bracket = { start, end: text.length, fields: [], closed: false };
      top.push(bracket);
    } else if (bracket && raw === "]") {
      bracket.end = start;
      bracket.closed = true;
      bracket = null;
    } else if (bracket && raw === "\n" && /^[ \t]*(?:\$\w+\s*=|show\s*\(|\|)/.test(text.slice(token.lastIndex))) {
      bracket.end = start;
      bracket = null;
      top.push({ raw, start, end: token.lastIndex });
    } else if (!bracket || raw !== "\n") {
      (bracket?.fields ?? top).push({ raw, start, end: token.lastIndex });
    }
  }
  return top;
}

const bareToken = /^[\p{L}\p{N}_:*.+-]+$/u;
const literal = (raw) => raw != null && (bareToken.test(raw) || /^['"]/.test(raw));
function decode(raw) {
  const quote = raw[0];
  if (quote !== "'" && quote !== '"') return raw;
  return raw.slice(1).replace(/\\([\s\S])|['"]/g, (match, escaped) => {
    if (!escaped) return match === quote ? "" : match;
    return ({ n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' })[escaped] ?? match;
  });
}

// Follow the source chain for this stage. Each where applies to every branch
// of a union. Spatial and set filters need execution and are named in the UI.
function pipelineScope(sets, tags) {
  const byName = new Map(sets.map(s => [s.name, s]));
  const stages = [], omitted = new Set(), visited = new Set();
  let set = sets.at(-1);
  while (set && !visited.has(set)) {
    visited.add(set);
    for (const filter of set.filters) {
      if (filter.predicate === "where") stages.push(filter.tags);
      else omitted.add(filter.predicate);
    }
    if (!set.source.startsWith("$")) {
      const commas = tokens(set.source).filter(token => token.raw === ",");
      const branches = [];
      let from = 0;
      const suffix = stages.join("") + tags;
      if (set.source.length + (commas.length + 1) * suffix.length > 65536) break;
      for (const to of [...commas.map(c => c.start), set.source.length]) {
        branches.push(set.source.slice(from, to).trim() + suffix);
        from = to + 1;
      }
      const selector = branches.join(",");
      if (set.source.trim())
        return { selector, scope: omitted.size ? "Viewport counts omit " + [...omitted].join(", ") : "" };
      break;
    }
    set = byName.get(set.source.slice(1));
  }
  return { selector: "*" + tags, scope: "Across feature types in view · pipeline scope unavailable" };
}

function precedingDraft(text) {
  try { return parseDraft(text); } catch { return null; }
}

export function tagContext(text, caret, bare = false, builderSets = []) {
  const parts = tokens(text, caret);
  const active = parts.findIndex((p) => p.fields && p.start < caret && caret <= p.end);
  if (active < 0) return null;
  const left = parts.slice(0, active);
  const boundary = left.findLastIndex((p) => p.raw === "\n" || p.raw === ";");
  const head = left.slice(boundary + 1);
  const pipe = left.findLastIndex(p => p.raw === "|");
  const tail = left.slice(pipe + 1).filter(p => p.raw !== "\n");
  let whereSets;
  if (bare === "where" || (pipe >= 0 && tail[0]?.raw === "where" && tail.slice(1).every(p => p.closed))) {
    whereSets = bare === "where" ? builderSets : precedingDraft(text.slice(0, left[pipe].start))?.sets ?? [];
    head.splice(0, head.length, {raw: "*"}, ...(bare === "where" ? head : tail.slice(1)));
  } else if (!bare && head[0]?.raw === "$") {
    if (head[0]?.raw !== "$" || !/^[A-Za-z_]\w*$/.test(head[1]?.raw ?? "") || head[2]?.raw !== "=") return null;
    head.splice(0, 3);
  }
  if (head.some((p) => !p.fields && p.raw !== "," && !/^[nwar*]+$/.test(p.raw))) return null;
  const branch = head.slice(head.findLastIndex((p) => p.raw === ",") + 1);
  if (!branch[0]?.raw || branch.slice(1).some((p) => !p.closed)) return null;
  let selector = branch[0].raw;
  const other = [...branch.slice(1)];
  for (let i = active + 1; parts[i]?.closed; i++) other.push(parts[i]);
  for (const p of other) selector += text.slice(p.start, p.end + 1);

  const fields = parts[active].fields;
  const current = fields.find((p) => p.start <= caret && caret <= p.end && literal(p.raw));
  if (!current && fields.some((p) => p.start < caret && caret < p.end)) return null;
  const start = current?.start ?? caret;
  const before = fields.filter((p) => p.end <= start).map((p) => p.raw);
  let key = null;
  if (before.length && !(before.length === 1 && before[0] === "!")) {
    if (!literal(before[0]) || !["=", "!="].includes(before[1])) return null;
    const list = before.slice(2);
    if (list.length % 2 || list.some((v, i) => i % 2 ? v !== "," : !literal(v))) return null;
    key = decode(before[0]);
  }
  const prefix = decode(text.slice(start, caret));
  if (key !== null && prefix.includes("*")) return null;
  const quote = /^['"]/.test(current?.raw ?? "") ? current.raw[0] : "";
  const scope = whereSets ? pipelineScope(whereSets, selector.slice(1)) : { selector };
  return { ...scope, key, prefix, start, end: current?.end ?? caret, quote };
}

// Only recognize grammar positions with a valid prefix. Token boundaries keep
// punctuation in comments, quoted roles and tag brackets out of this context.
export function languageContext(text, caret) {
  const all = tokens(text, caret);
  const left = all.filter(p => p.start < caret);
  const current = left.at(-1);
  if (!current || (current.fields && caret <= current.end)) return null;
  const word = current.end >= caret && /^\w+$/.test(current.raw) ? left.pop() : null;
  const start = word?.start ?? caret, end = word?.end ?? caret;
  const prefix = text.slice(start, caret);
  const significant = left.filter(p => p.raw !== "\n");
  const last = significant.at(-1);
  if (last?.raw === "|") {
    const draft = precedingDraft(text.slice(0, last.start));
    if (!draft?.sets.length || (draft.show.length && !draft.standalone) || draft.emptyShow ||
        significant.at(-2)?.raw === ";") return null;
    const hasSets = draft.sets.length > 1;
    const names = ["where", ...predicates.keys(), ...(hasSets ? setPredicates.keys() : [])];
    const after = text.slice(end).trimStart();
    const options = names.filter(op => op.startsWith(prefix)).map(op => {
      const where = op === "where", distance = op === "within_distance";
      const label = where ? "where [tag]" : op + (distance ? "($set, metres)" : "($set)");
      if (after.startsWith(where ? "[" : "(")) return { text: op, label };
      const insert = where ? "where []" : op + (distance ? "(, 100)" : "()");
      return { text: insert, label, cursor: where ? insert.length - 1 : op.length + 1 };
    });
    return options.length ? { start, end, heading: "Pipeline filters", options } : null;
  }
  // Match an open argument list, optionally with earlier show() arguments.
  const dollar = last?.raw === "$" ? significant.pop() : null;
  const open = significant.findLastIndex(p => p.raw === "(");
  if (open < 1) return null;
  const name = significant[open - 1], args = significant.slice(open + 1);
  const show = name.raw === "show", used = new Set();
  if (show) {
    for (let i = 0; i < args.length; i += 3) {
      if (args[i].raw !== "$" || !/^\w+$/.test(args[i+1]?.raw ?? "") || args[i+2]?.raw !== ",") return null;
      used.add(args[i+1].raw);
    }
  } else if ((!predicates.has(name.raw) && !setPredicates.has(name.raw)) ||
      significant[open - 2]?.raw !== "|" || args.length) return null;
  const before = show ? name.start : significant[open - 2].start;
  const draft = precedingDraft(text.slice(0, before));
  if (!draft || (show && draft.standalone) || (!show && !draft.sets.length) ||
      (!draft.standalone && (draft.show.length || draft.emptyShow))) return null;
  const names = (show ? draft.sets : draft.sets.slice(0, -1)).map(s => s.name);
  if (show || predicates.has(name.raw)) names.push("geometry");
  const options = names.filter(n => n.startsWith(prefix) && !used.has(n)).map(n => ({ text: "$" + n }));
  const suffix = word ? "" : /^\$?\w+|^\$/.exec(text.slice(end))?.[0] ?? "";
  return options.length ? { start: dollar?.start ?? start, end: end + suffix.length, heading: "Reference sets", options } : null;
}

export function tagLiteral({ text, numeric }, { key, quote }) {
  if (numeric) return text;
  if (!quote && bareToken.test(text) &&
      !(key !== null && /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[+-]?(?:inf(?:inity)?|nan))$/i.test(text))) return text;
  quote ||= '"';
  return quote + text.replace(/[\\'"\n\r\t]/g, (c) => {
    if (c === "\\" || c === quote) return "\\" + c;
    return ({ "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c] ?? c;
  }) + quote;
}
