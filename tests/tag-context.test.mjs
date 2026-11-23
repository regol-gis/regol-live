import test from "node:test";
import assert from "node:assert/strict";
import { languageContext, tagContext, tagLiteral } from "../web/tag-context.js";

function at(marked, bare = false) {
  const caret = marked.indexOf("^");
  const text = marked.replace("^", "");
  return tagContext(text, caret, bare);
}

test("keys and list values use only the active union branch and its other predicates", () => {
  const text = '$first = n[name="a,b;|]"]\n$x = n[shop], na[amenity!=bar,ca^fe][name]\n | within($first)';
  const value = at(text);
  assert.deepEqual([value.selector, value.key, value.prefix], ["na[name]", "amenity", "ca"]);
  assert.equal(text.replace("^", "").slice(value.start, value.end), "cafe");
  assert.equal(at("w[highway=primary][!na^]", true).selector, "w[highway=primary]");
  assert.equal(at("$x = na[amenity='picnic,table',^").prefix, "");
  assert.equal(at('$x = n["name:en"="Café de^ Paris"]').prefix, "Café de");
  assert.equal(at("$x = n[am^\nshow($x)").selector, "n");
  assert.equal(at("$x = n[name='Back\\'s^").prefix, "Back's");
});

test("comments, set references, regexes and ordering comparisons have no literal suggestions", () => {
  for (const text of ["// $x = n[amen^", "$x = n // n[am^", "$x = $parks[na^",
    "$a = a | within($parks[na^", "show($a[na^", "$a = n[name~'Bench^",
    "$a = w[height>=1^", "$a = n[name=*Par^", "$a = n[access!=no ^]"]) {
    assert.equal(at(text), null, text);
  }
});

test("insertion preserves numeric encodings, literal punctuation, and quote style", () => {
  const value = {key: "ref", quote: ""};
  assert.equal(tagLiteral({text: "007"}, value), '"007"');
  assert.equal(tagLiteral({text: "8", numeric: true}, value), "8");
  assert.equal(tagLiteral({text: "a,b"}, value), '"a,b"');
  assert.equal(tagLiteral({text: "name:en"}, {key: null}), "name:en");
  const escaped = tagLiteral({text: "A's\\lane\n"}, {...value, quote: "'"});
  assert.equal(at("$a = n[ref=" + escaped + "^]").prefix, "A's\\lane\n");
});

test("completes tags in standalone sources and where stages", () => {
  assert.equal(at("na[amen^]").selector, "na");
  assert.equal(at("$r = n |\n where [amenity=cafe][na^]").selector, "n[amenity=cafe]");
  assert.equal(at("[name][am^]", "where").selector, "*[name]");
});

test("where counts follow sources, aliases, unions and tag filters before the caret", () => {
  assert.equal(at("na[amenity=cafe] | where [outd^]").selector, "na[amenity=cafe]");
  const query = '$base = n[amenity=cafe,bar],a[name="X,Y"]; $near = $base | where [lit] | within($geometry); ' +
    '$alias = $near; $pick = $alias | where [name][out^][access] | where [later]';
  const ctx = at(query);
  assert.equal(ctx.selector, 'n[amenity=cafe,bar][lit][name][access],a[name="X,Y"][lit][name][access]');
  assert.match(ctx.scope, /within/);
  const builder = tagContext("[outd", 5, "where", [
    {name:"cafes", source:"na[amenity=cafe]", filters:[]},
    {name:"named", source:"$cafes", filters:[{predicate:"where",tags:"[name]"}]},
  ]);
  assert.equal(builder.selector, "na[amenity=cafe][name]");
});

test("filter and set completions respect declaration, argument and token boundaries", () => {
  const context = s => languageContext(s.replace("^", ""), s.indexOf("^"));
  const names = s => context(s)?.options.map(item => item.text);
  assert.deepEqual(names("n |\n wit^"), ["within()", "within_distance(, 100)"]);
  assert.deepEqual(names("$x=n; $y=n | members_of($^); $later=r"), ["$x"]);
  assert.deepEqual(names("$x=n; $y=w; show($x,\n $^)"), ["$y", "$geometry"]);
  const s = "$parks=a; $x=n | within($^parks)";
  const ctx = context(s);
  assert.equal(s.replace("^", "").slice(ctx.start, ctx.end), "$parks");
  for (const invalid of ["n // | wi^", "n; | wi^", 'n[name="| wit^"]',
    '$x=r; $y=n | members_of($x, "st^")', "n[am^]", "n | within_distance($geometry, ^)"])
    assert.equal(context(invalid), null, invalid);
});
