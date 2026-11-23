import test from "node:test";
import { executionPlan, emptyReferenceNotes } from "../web/query-plan.js";
import assert from "node:assert/strict";
import {
  parseDraft,
  parseProgram,
  formatProgram,
  examples,
  queryWarning,
} from "../web/query-language.js";
test("examples and chained expressions round-trip with their output style", () => {
  for (const text of examples.values()) {
    const plan = parseProgram(text);
    assert.deepEqual(parseProgram(formatProgram(plan)), plan);
  }
  const text = `// syntax within a GOQL literal is opaque
$parks = a[name="x;|//within($z)"]; $b = n | within($parks)
$c = $b
  | touches($parks) | within_distance($geometry, 2.5)
show($c,
 $b)`;
  const plan = parseProgram(text);
  assert.equal(plan.sets[0].source, 'a[name="x;|//within($z)"]');
  assert.equal(plan.sets[2].filters.length, 2);
  assert.deepEqual(plan.show, ["c", "b"]);
});
test("unused warnings follow aliases and spatial references back from every output", () => {
  const query = `$parks = a[leisure=park]
$park_benches = n[amenity=bench] | within($parks)
$unused = $park_benches | intersects($geometry)
$shops = n[shop]
$stops = n[highway=bus_stop]
$near = $shops | within_distance($stops, 100)
$quoted = n[name="$unused"] // $unused in a comment
`;
  const warning = (outputs) =>
    queryWarning(parseProgram(query + "show(" + outputs + ")"));
  assert.match(
    warning("$near, $quoted"),
    /^\$parks, \$park_benches, \$unused are unused\./,
  );
  assert.match(
    warning("$near, $quoted, $park_benches"),
    /^\$unused is unused\./,
  );
  assert.equal(warning("$near, $quoted, $unused"), "");
  assert.match(
    warning("$geometry"),
    /^\$parks, \$park_benches, \$unused, \$shops, \$stops, \$near, \$quoted are unused\./,
  );
  assert.equal(queryWarning(parseProgram("show($geometry)")), "");
});
test("drafts with no output suggest the final set without making them runnable", () => {
  const query = '$places = n[name="show($places)"]\n$near = $places | within($geometry)';
  for (const ending of ["", "\n// show($near)", "\nshow( )"]) {
    const draft = parseDraft(query + ending);
    assert.deepEqual(draft.show, []);
    assert.equal(queryWarning(draft), ending.includes("show( )")
      ? "Choose an output in show(), for example show($near)."
      : "Add show($near) at the end to display results.");
    assert.throws(() => parseProgram(query + ending), /show\(\$near\)/);
  }
  assert.equal(queryWarning(parseDraft(query + "; show($near)")), "");
  assert.equal(queryWarning(parseDraft("// still drafting")), "");
  assert.throws(() => parseDraft(query + "; show(); $other = w"), /final statement/);
});
test("rejects incomplete programs, bad distances, cycles and undefined outputs", () => {
  for (const text of [
    "",
    "$a = n",
    "show()",
    "$a = n\nshow($z)",
    "$a = n\nshow($a,$a)",
    "$a = n\nshow($a)\n$b = w",
    "$a = n\n$a = w\nshow($a)",
    "$a = $b\n$b = n\nshow($a)",
    "$a = n | within($a)\nshow($a)",
    "$a = n | within_distance($geometry, -2)\nshow($a)",
    "$a = n | within($geometry, 2)\nshow($a)",
    "$a = n[name='open]\nshow($a)",
  ])
    assert.throws(() => parseProgram(text), undefined, text);
});

test("membership roles round-trip and set operations require OSM sets", () => {
  for (const role of [undefined, "", "stop", 'a\"|,)//b', "custom rôle"]) {
    const arg = role === undefined ? "" : ", " + JSON.stringify(role);
    const text = `$routes = r; $stops = n | members_of($routes${arg}); show($stops)`;
    const draft = parseProgram(text);
    assert.equal(draft.sets[1].filters[0].role, role);
    assert.deepEqual(parseProgram(formatProgram(draft)), draft);
    assert.equal(queryWarning(draft), "");
  }
  for (const invalid of ["parents_of($geometry)", "except($geometry)", "except($r, 5)",
    'except($r, "")', "members_of($r, stop)", "members_of($r, 2)", "parents_of($unknown)"])
    assert.throws(() => parseProgram(`$r = r\n$x = n | ${invalid}\nshow($x)`), /Line 2, column \d+:/);
});

test("mixed selectors, aliases and roles choose the appropriate membership directions", () => {
  const windows = [[7.407, 43.72, 7.44, 43.75]];
  const plan = (input, candidate, pipe) => executionPlan(parseProgram(
    `$input = ${input}; $ref = $input; $result = ${candidate} | ${pipe}; show($result)`
  ), windows);
  const paths = plan => plan.sets.filter(s => s.membership).map(s =>
    [s.membership.direction, s.overpass.kind]);
  assert.deepEqual(paths(plan('n[name="w,r"],a', "a", "parents_of($ref)")),
    [["bn", "wr"], ["bw", "relation"], ["br", "relation"]]);
  assert.deepEqual(paths(plan("na", "a", 'parents_of($ref, "")')),
    [["bn", "relation"], ["bw", "relation"], ["br", "relation"]]);
  assert.deepEqual(paths(plan("a", "n", "members_of($ref)")), [["r", "node"], ["w", "node"]]);
  assert.deepEqual(paths(plan("a", "n", 'members_of($ref, "")')), [["r", "node"]]);
  assert.deepEqual(paths(plan("w", "n", 'members_of($ref, "")')), []);
  const nodeMembers = plan("r", "n", "members_of($ref)");
  assert.equal(nodeMembers.sets.at(-1).overpass.windows, windows);
  assert(!nodeMembers.sets.some(s => s.source === "n"));
  const chain = plan("n", "n", "except($ref) | within($geometry) | except($ref)");
  const final = chain.sets.at(-1);
  const prior = chain.sets.find(s => s.name === final.difference[0]);
  assert.deepEqual(prior.filters, [{predicate: "within", reference: "geometry"}]);
  assert(prior.difference);
});

test("a standalone pipeline displays itself and accepts either newline convention", () => {
  const text = 'na[name="x|//;"] | // next stage\n\n where [name]\n | within($geometry)';
  const plan = parseProgram(text);
  assert.equal(queryWarning(plan), "");
  assert.equal(plan.standalone, true);
  assert.deepEqual(plan.show, ["result"]);
  assert.deepEqual(parseProgram(formatProgram(plan)), plan);
  for (const text of ["n; w", "n; show($result)", "$a = n; w", "n |", "n | | where [name]"])
    assert.throws(() => parseProgram(text), /pipeline|filter/);
  assert.match(queryWarning(parseDraft("$result = n")), /show\(\$result\)/);
  assert.equal(parseProgram("$result = n; show($result)").standalone, undefined);
});

test("diagnostics identify the offending token and propose a repair", () => {
  for (const [text, message] of [
    ["$x = n\n$named = $x[name]", /Line 2, column 1:.*\$x \| where \[name\]/],
    ["n |\n  wher [name]", /Line 2, column 3: Unknown filter "wher"/],
    ["n | where name", /where \[name\]/],
    ["n | within(parks)", /within\(\$set\)/],
    ["$x = n\nshow(x)", /Line 2, column 6:.*\$ before/],
    ["n[name='unclosed", /Line 1, column 8: Close the '/],
    ["n | within($geometry", /Line 1, column 11: Close/],
  ]) assert.throws(() => parseProgram(text), message);
});

test("single-use sources fuse, while shared inputs and references retain their identity", () => {
  const plan = (text) => executionPlan(parseProgram(text), [[0,0,1,1]]).sets;
  const simple = plan("$nodes = n; $alias = $nodes; $near = $alias | within($geometry); show($near)");
  assert.deepEqual(simple.at(-1), {name:"near", source:"n", filters:[{predicate:"within",reference:"geometry"}]});
  const refined = plan("$all = n,a; $named = $all | where [name]; $inside = $named | within($geometry); show($inside)");
  assert.deepEqual(refined.at(-1).filters, [{selector:"*[name]"}, {predicate:"within",reference:"geometry"}]);
  const shown = plan("$all = n; $named = $all | where [name]; show($named, $all)");
  assert.equal(shown.at(-1).source, "$all");
  assert.deepEqual(shown.at(-1).filters, [{selector:"*[name]"}]);
  const shared = plan("$all = n; $near = $all | intersects($all); show($near)");
  assert.equal(shared.at(-1).source, "$all");
  const dead = plan("$all = n; $unused = $all; $named = $all | where [name]; show($named)");
  assert.equal(dead.at(-1).source, "n[name]");
  const ordered = plan("n | within($geometry) | where [name]");
  assert.deepEqual(ordered[0].filters, [{predicate:"within",reference:"geometry"},{selector:"*[name]"}]);
});

test("semicolons terminate a pipeline and repairs target exact source ranges", () => {
  for (const query of ["$x=n; | where [name]", "$x=n; // finished\n\n | where [name]"]) {
    assert.throws(() => parseDraft(query), err =>
      query.slice(err.start, err.end) === ";" && err.repair.text === "");
  }
  for (const query of ['$parks=a; $x=n | within($praks)',
    '$parks=a; show( // 😀 first\n $praks)', '$parks=a; $x = $praks']) {
    assert.throws(() => parseDraft(query), err =>
      query.slice(err.start, err.end) === "$praks" && err.repair.text === "$parks");
  }
  assert.throws(() => parseDraft("$pen=n; $pan=n; show($pin)"), err => !err.repair);
  assert.equal(parseProgram('n[name="a;|b"] | where [name]').sets.length, 1);
});

test("empty reference notes use executed dependencies and complete results", () => {
  const draft = parseProgram("$parks=a; $unused=n | disjoint($parks); $in=n | within($parks); $far=n | except($parks); show($in,$far)");
  const {sets} = executionPlan(draft, [[0,0,1,1]]);
  const stats = sets.map((s, setIndex) => ({setIndex, retained:0, matchesKept:s.name === "far" ? 8 : 0}));
  const notes = emptyReferenceNotes(draft, sets, {complete:true, setStats:stats});
  assert.equal(notes.length, 2);
  assert.match(notes[0], /\$in, within matched no candidates/);
  assert.match(notes[1], /\$far, except excluded no candidates/);
  assert.deepEqual(emptyReferenceNotes(draft, sets, {complete:false, setStats:stats}), []);
  assert.deepEqual(emptyReferenceNotes(draft, sets, {complete:true, setStats:stats.slice(1)}), []);
});
