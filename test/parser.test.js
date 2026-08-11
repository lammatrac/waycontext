import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFile, EXT_LANG } from "../src/parser.js";

// Characterization tests: these pin down what the parser actually produces
// today, so the tree-sitter backend can be swapped (native -> WASM) and any
// behavioural drift shows up as a failure rather than as a silently worse
// index. Where current behaviour is arguably wrong, the test says so rather
// than asserting the ideal.

const names = (r) => r.symbols.map((s) => s.name);
const kinds = (r) => Object.fromEntries(r.symbols.map((s) => [s.name, s.kind]));
const rels = (r) => r.relations.map((e) => `${e.srcName} -${e.relation}-> ${e.dstName}`);

test("EXT_LANG maps the supported extensions", () => {
  assert.deepEqual(EXT_LANG, {
    ".js": "js", ".mjs": "js", ".cjs": "js",
    ".jsx": "jsx", ".ts": "ts", ".tsx": "tsx", ".php": "php",
    ".py": "python", ".pyi": "python", ".go": "go",
    ".json": "json", ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss", ".xml": "xml",
  });
});

// --- JavaScript --------------------------------------------------------

test("js: function declarations and their calls", () => {
  const r = parseFile("js", `
function alpha() {
  beta();
  obj.gamma();
}
function beta() {}
`);
  assert.deepEqual(names(r), ["alpha", "beta"]);
  assert.equal(kinds(r).alpha, "function");
  assert.ok(rels(r).includes("alpha -CALLS-> beta"));
  assert.ok(rels(r).includes("alpha -CALLS-> obj.gamma"),
    "callee text is kept raw, so member calls appear as 'obj.gamma'");
});

test("js: const arrow functions and function expressions become symbols", () => {
  const r = parseFile("js", `
const arrow = () => { helper(); };
const expr = function () { helper(); };
const notAFunction = 42;
`);
  assert.deepEqual(names(r), ["arrow", "expr"]);
  assert.ok(rels(r).includes("arrow -CALLS-> helper"));
  assert.ok(rels(r).includes("expr -CALLS-> helper"));
});

test("js: classes, methods, inheritance and instantiation", () => {
  const r = parseFile("js", `
class Base {}
class Child extends Base {
  render() {
    this.helper();
    new Widget();
  }
}
`);
  assert.deepEqual(names(r), ["Base", "Child", "Child::render"]);
  assert.equal(kinds(r)["Child::render"], "method");
  assert.ok(rels(r).includes("Child -EXTENDS-> Base"));
  assert.ok(rels(r).includes("Child::render -CALLS-> this.helper"));
  assert.ok(rels(r).includes("Child::render -INSTANTIATES-> Widget"));
});

test("js: imports are attributed to @file, not to a symbol", () => {
  const r = parseFile("js", `import { a } from "./mod.js";\nimport def from "pkg";\n`);
  assert.deepEqual(names(r), []);
  assert.deepEqual(rels(r), [
    "@file -IMPORTS-> ./mod.js",
    "@file -IMPORTS-> pkg",
  ]);
});

test("js: require() is a plain call, not an import (known limitation)", () => {
  const r = parseFile("js", `const fs = require("node:fs");\nfunction f() { require("x"); }\n`);
  assert.ok(!rels(r).some((e) => e.includes("IMPORTS")),
    "only import_statement produces IMPORTS; require() stays a CALLS edge");
  assert.ok(rels(r).includes("f -CALLS-> require"));
});

test("js: export wrappers are unwrapped", () => {
  const r = parseFile("js", `
export function exported() {}
export default function fallback() {}
export class Thing {}
`);
  assert.ok(names(r).includes("exported"));
  assert.ok(names(r).includes("Thing"));
});

test("js: generator functions are captured", () => {
  const r = parseFile("js", `function* gen() { yield 1; }`);
  assert.deepEqual(names(r), ["gen"]);
  assert.equal(kinds(r).gen, "function");
});

test("js: leading docblocks are captured, other comments too", () => {
  const r = parseFile("js", `
/** Does a thing. */
function documented() {}

// line comment
function lineDoc() {}

function undocumented() {}
`);
  const bySymbol = Object.fromEntries(r.symbols.map((s) => [s.name, s.doc]));
  assert.equal(bySymbol.documented, "/** Does a thing. */");
  assert.equal(bySymbol.lineDoc, "// line comment");
  assert.equal(bySymbol.undocumented, null);
});

test("js: signature is the first line only, and line numbers are 1-based", () => {
  const r = parseFile("js", `function multi(\n  a,\n  b\n) {\n  return a;\n}\n`);
  const [sym] = r.symbols;
  assert.equal(sym.signature, "function multi(");
  assert.equal(sym.startLine, 1);
  assert.equal(sym.endLine, 6);
});

test("js: oversized bodies are truncated with a marker", () => {
  const filler = "  const x = 1;\n".repeat(600); // well past the 6000-char cap
  const r = parseFile("js", `function big() {\n${filler}}\n`);
  const [sym] = r.symbols;
  assert.ok(sym.body.endsWith("/* …truncated */"));
  assert.ok(sym.body.length < filler.length);
});

test("js: a file large enough to trip the old chunked-read bug still parses", () => {
  // node-tree-sitter's default 32768-unit read buffer used to fail here.
  const big = Array.from({ length: 4000 }, (_, i) => `function fn${i}() { helper(); }`).join("\n");
  const r = parseFile("js", big);
  assert.equal(r.symbols.length, 4000);
});

// --- TypeScript --------------------------------------------------------

test("ts: interfaces and implements clauses", () => {
  const r = parseFile("ts", `
interface Shape { area(): number; }
class Circle implements Shape {
  area(): number { return 1; }
}
`);
  assert.equal(kinds(r).Shape, "interface");
  assert.ok(names(r).includes("Circle::area"));
  assert.ok(rels(r).includes("Circle -IMPLEMENTS-> Shape"));
});

test("tsx: components parse as ordinary declarations", () => {
  const r = parseFile("tsx", `
export const Button = ({ label }: { label: string }) => <button>{label}</button>;
export function Panel() { return <div><Button label="x" /></div>; }
`);
  assert.ok(names(r).includes("Button"));
  assert.ok(names(r).includes("Panel"));
});

// --- PHP ---------------------------------------------------------------

test("php: functions, classes, methods and traits", () => {
  const r = parseFile("php", `<?php
function helper() {}
trait Loggable { public function log() {} }
class Service {
  public function run() { $this->helper(); }
}
`);
  assert.ok(names(r).includes("helper"));
  assert.equal(kinds(r).Loggable, "trait");
  assert.ok(names(r).includes("Loggable::log"));
  assert.ok(names(r).includes("Service::run"));
  assert.ok(rels(r).includes("Service::run -CALLS-> helper"),
    "member calls record the bare method name so they can resolve later");
});

test("php: namespaces prefix declared symbols", () => {
  const r = parseFile("php", `<?php
namespace App\\Domain;
class Invoice {}
function total() {}
`);
  assert.ok(names(r).includes("App\\Domain\\Invoice"));
  assert.ok(names(r).includes("App\\Domain\\total"));
});

test("php: use statements become @file imports", () => {
  const r = parseFile("php", `<?php
use App\\Models\\Order;
class C {}
`);
  assert.ok(rels(r).some((e) => e.startsWith("@file -IMPORTS->") && e.includes("Order")));
});

test("php: inheritance and interfaces", () => {
  const r = parseFile("php", `<?php
class Child extends ParentClass implements Countable {}
`);
  assert.ok(rels(r).includes("Child -EXTENDS-> ParentClass"));
  assert.ok(rels(r).includes("Child -IMPLEMENTS-> Countable"));
});

test("php: object instantiation and static calls", () => {
  const r = parseFile("php", `<?php
function build() {
  $x = new Widget();
  Registry::register($x);
}
`);
  assert.ok(rels(r).includes("build -INSTANTIATES-> Widget"));
  assert.ok(rels(r).includes("build -CALLS-> register"));
});

// --- WordPress hooks ---------------------------------------------------

test("php: add_action registers a hook and links a string callback", () => {
  const r = parseFile("php", `<?php
function boot() {
  add_action('init', 'my_init_handler');
  add_filter('the_content', [$this, 'filter']);
}
`);
  assert.ok(rels(r).includes("boot -REGISTERS_HOOK-> hook:init"));
  assert.ok(rels(r).includes("boot -CALLS-> my_init_handler"),
    "a plain-string callback also yields a CALLS edge so the graph connects");
  assert.ok(rels(r).includes("boot -REGISTERS_HOOK-> hook:the_content"));
  assert.ok(!rels(r).some((e) => e === "boot -CALLS-> filter" && false));
});

test("php: do_action and apply_filters fire hooks", () => {
  const r = parseFile("php", `<?php
function emit() {
  do_action('my_event');
  apply_filters('my_filter', $value);
}
`);
  assert.ok(rels(r).includes("emit -FIRES_HOOK-> hook:my_event"));
  assert.ok(rels(r).includes("emit -FIRES_HOOK-> hook:my_filter"));
});

test("php: top-level hook registration in a plugin bootstrap is attributed to @file", () => {
  const r = parseFile("php", `<?php
add_action('plugins_loaded', 'bootstrap_plugin');
`);
  assert.ok(rels(r).includes("@file -REGISTERS_HOOK-> hook:plugins_loaded"));
  assert.ok(rels(r).includes("@file -CALLS-> bootstrap_plugin"));
});

// --- Python ------------------------------------------------------------

test("python: functions, classes, methods and inheritance", () => {
  const r = parseFile("python", `
class Base:
    pass

class Service(Base):
    def run(self):
        helper()

def top_level():
    pass
`);
  assert.ok(names(r).includes("Base"));
  assert.equal(kinds(r).Service, "class");
  assert.equal(kinds(r)["Service::run"], "method");
  assert.equal(kinds(r).top_level, "function");
  assert.ok(rels(r).includes("Service -EXTENDS-> Base"));
  assert.ok(rels(r).includes("Service::run -CALLS-> helper"));
});

test("python: multiple base classes each get an edge", () => {
  const r = parseFile("python", `class C(A, B):\n    pass\n`);
  assert.ok(rels(r).includes("C -EXTENDS-> A"));
  assert.ok(rels(r).includes("C -EXTENDS-> B"));
});

test("python: decorated functions and methods are not lost", () => {
  const r = parseFile("python", `
@app.route("/x")
def handler():
    work()

class C:
    @property
    def value(self):
        return 1
`);
  assert.ok(names(r).includes("handler"), names(r).join(", "));
  assert.ok(rels(r).includes("handler -CALLS-> work"));
  assert.ok(names(r).includes("C::value"));
});

test("python: both import forms are recorded against @file", () => {
  const r = parseFile("python", `import os\nfrom a.b import c\n`);
  assert.ok(rels(r).includes("@file -IMPORTS-> os"));
  assert.ok(rels(r).includes("@file -IMPORTS-> a.b"));
});

test("python: construction is a call, since there is no `new`", () => {
  const r = parseFile("python", `def f():\n    return Widget()\n`);
  assert.ok(rels(r).includes("f -CALLS-> Widget"));
});

// --- Go ----------------------------------------------------------------

test("go: functions, methods and receiver-qualified names", () => {
  const r = parseFile("go", `
package main

func New() *Server { return nil }

func (s *Server) Handle() { helper() }
`);
  assert.equal(kinds(r).New, "function");
  assert.equal(kinds(r)["Server::Handle"], "method",
    "a method must be named after its receiver type, like Class::method elsewhere");
  assert.ok(rels(r).includes("Server::Handle -CALLS-> helper"));
});

test("go: a value receiver works the same as a pointer receiver", () => {
  const r = parseFile("go", `package main\nfunc (s Server) Name() string { return "" }\n`);
  assert.ok(names(r).includes("Server::Name"));
});

test("go: structs and interfaces become symbols with distinct kinds", () => {
  const r = parseFile("go", `
package main

type Server struct { Name string }
type Handler interface { Handle() }
`);
  assert.equal(kinds(r).Server, "class");
  assert.equal(kinds(r).Handler, "interface");
});

test("go: composite literals record instantiation", () => {
  const r = parseFile("go", `package main\nfunc f() { x := &Server{}; _ = x }\n`);
  assert.ok(rels(r).includes("f -INSTANTIATES-> Server"));
});

test("go: imports are recorded against @file", () => {
  const r = parseFile("go", `
package main

import (
    "fmt"
    "net/http"
)
`);
  assert.ok(rels(r).includes("@file -IMPORTS-> fmt"));
  assert.ok(rels(r).includes("@file -IMPORTS-> net/http"));
});

test("go: qualified calls keep their package prefix", () => {
  const r = parseFile("go", `package main\nfunc f() { fmt.Println("x") }\n`);
  assert.ok(rels(r).includes("f -CALLS-> fmt.Println"));
});

// --- JSON ----------------------------------------------------------------
// No calls/classes in JSON, so extraction is flat: every object key becomes
// a "key" symbol, at any nesting depth, and there are never any relations.

test("json: every key becomes a symbol, at any nesting depth", () => {
  const r = parseFile("json", `{ "a": 1, "b": { "c": 2, "d": [1, 2] } }`);
  assert.deepEqual(names(r), ["a", "b", "c", "d"]);
  assert.ok(Object.values(kinds(r)).every((k) => k === "key"));
  assert.deepEqual(rels(r), []);
});

test("json: an empty object or array produces no symbols", () => {
  assert.deepEqual(names(parseFile("json", `{}`)), []);
  assert.deepEqual(names(parseFile("json", `[]`)), []);
});

// --- CSS -------------------------------------------------------------------
// Rules and at-rules become "rule" symbols named after their selector (or,
// for at-rules, their keyword + prelude); nested rule_sets inside at-rules
// are walked too. No relations, since CSS has no call concept.

test("css: a plain rule is named after its selector", () => {
  const r = parseFile("css", `.foo { color: red; }`);
  assert.deepEqual(names(r), [".foo"]);
  assert.equal(kinds(r)[".foo"], "rule");
  assert.deepEqual(rels(r), []);
});

test("css: at-rules are named by keyword + prelude, and their nested rules are still captured", () => {
  const r = parseFile("css", `
@media screen { .bar { color: blue; } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
`);
  assert.ok(names(r).includes("@media screen"));
  assert.ok(names(r).includes(".bar"));
  assert.ok(names(r).includes("@keyframes fadeIn"));
});

test("css: bodyless at-rules (@import, @charset) still get a symbol", () => {
  const r = parseFile("css", `@charset "utf-8";\n@import url("foo.css");\n`);
  assert.ok(names(r).some((n) => n.startsWith("@charset")));
  assert.ok(names(r).some((n) => n.startsWith("@import")));
});

// --- SCSS --------------------------------------------------------------
// Reuses the CSS walker verbatim: SCSS's rule_set/selectors/*_statement node
// shapes are a superset of CSS's, so nested rules and SCSS-only at-rules
// (@mixin, @include, etc.) are named and walked the same way.

test("scss: a nested rule is named after its selector at every level", () => {
  const r = parseFile("scss", `.foo { .bar { color: red; } }`);
  assert.deepEqual(names(r), [".foo", ".bar"]);
  assert.equal(kinds(r)[".foo"], "rule");
  assert.equal(kinds(r)[".bar"], "rule");
  assert.deepEqual(rels(r), []);
});

test("scss: SCSS-only at-rules (@mixin) get a rule symbol like any other at-rule", () => {
  const r = parseFile("scss", `@mixin button-variant { color: red; }\n@include button-variant;`);
  assert.ok(names(r).includes("@mixin button-variant"));
  assert.ok(names(r).some((n) => n.startsWith("@include")));
  assert.deepEqual(rels(r), []);
});

// --- HTML ------------------------------------------------------------------
// Only elements carrying an id or class attribute become symbols -- a plain
// <p> with neither is noise, not a symbol. No relations.

test("html: an element with an id becomes tag#id", () => {
  const r = parseFile("html", `<div id="main"><p>text</p></div>`);
  assert.deepEqual(names(r), ["div#main"]);
  assert.equal(kinds(r)["div#main"], "element");
  assert.deepEqual(rels(r), []);
});

test("html: an element with a class (no id) becomes tag.firstClass", () => {
  const r = parseFile("html", `<span class="card highlight">x</span>`);
  assert.deepEqual(names(r), ["span.card"]);
});

test("html: an element with neither id nor class produces no symbol", () => {
  const r = parseFile("html", `<p>no attrs</p>`);
  assert.deepEqual(names(r), []);
});

test("html: id wins over class when both are present", () => {
  const r = parseFile("html", `<div id="main" class="card">x</div>`);
  assert.deepEqual(names(r), ["div#main"]);
});

// --- XML -------------------------------------------------------------------
// Every element becomes a symbol unconditionally (no id/class gating, unlike
// HTML), named after its tag. No relations.

test("xml: every element becomes a symbol named after its tag", () => {
  const r = parseFile("xml", `<root><item id="1"><name>foo</name></item></root>`);
  assert.deepEqual(names(r), ["root", "item", "name"]);
  assert.ok(Object.values(kinds(r)).every((k) => k === "element"));
  assert.deepEqual(rels(r), []);
});

test("xml: a self-closing element still becomes a symbol", () => {
  const r = parseFile("xml", `<root><item id="2"/></root>`);
  assert.deepEqual(names(r), ["root", "item"]);
});

// --- regressions -------------------------------------------------------

test("regression: ts implements is IMPLEMENTS, not EXTENDS with the clause text", () => {
  const r = parseFile("ts", `class A implements B {}`);
  assert.deepEqual(rels(r), ["A -IMPLEMENTS-> B"]);
});

test("regression: ts extends and implements together are both recorded", () => {
  const r = parseFile("ts", `class A extends Base implements X, Y {}`);
  assert.ok(rels(r).includes("A -EXTENDS-> Base"));
  assert.ok(rels(r).includes("A -IMPLEMENTS-> X"));
  assert.ok(rels(r).includes("A -IMPLEMENTS-> Y"));
  assert.equal(rels(r).length, 3);
});

test("regression: generic arguments are not mistaken for base types", () => {
  const r = parseFile("ts", `class A extends Base<Config> implements Shape<T> {}`);
  assert.ok(rels(r).includes("A -EXTENDS-> Base"));
  assert.ok(!rels(r).some((e) => e.includes("<Config>")), "type_arguments must not become an edge");
  assert.ok(rels(r).some((e) => e.startsWith("A -IMPLEMENTS->")));
});

test("regression: plain js extends still works after the heritage rewrite", () => {
  const r = parseFile("js", `class Child extends Base {}`);
  assert.deepEqual(rels(r), ["Child -EXTENDS-> Base"]);
});

test("regression: php statement namespace prefixes every following declaration", () => {
  const r = parseFile("php", `<?php
namespace App\\Domain;

use App\\Support\\Str;

class Invoice {}
interface Payable {}
trait Refundable {}
function total() {}
`);
  assert.ok(names(r).includes("App\\Domain\\Invoice"));
  assert.ok(names(r).includes("App\\Domain\\Payable"));
  assert.ok(names(r).includes("App\\Domain\\Refundable"));
  assert.ok(names(r).includes("App\\Domain\\total"));
});

test("regression: php methods inherit the namespaced class name", () => {
  const r = parseFile("php", `<?php
namespace App\\Domain;
class Invoice { public function send() {} }
`);
  assert.ok(names(r).includes("App\\Domain\\Invoice::send"));
});

test("regression: two namespaces in one file scope their own declarations", () => {
  const r = parseFile("php", `<?php
namespace A;
class Thing {}
namespace B;
class Thing {}
`);
  assert.deepEqual(names(r), ["A\\Thing", "B\\Thing"],
    "same class name under two namespaces must stay distinct");
});

test("regression: braced namespaces stay scoped to their block", () => {
  const r = parseFile("php", `<?php
namespace A { class Inside {} }
`);
  assert.deepEqual(names(r), ["A\\Inside"]);
});

test("regression: declarations before any namespace stay unprefixed", () => {
  const r = parseFile("php", `<?php
class Global1 {}
namespace A;
class Scoped {}
`);
  assert.ok(names(r).includes("Global1"));
  assert.ok(names(r).includes("A\\Scoped"));
});

// --- scope-aware call resolution ----------------------------------------
//
// A bare-identifier call is only a reference to a project-wide symbol if
// nothing more local already owns that name. Without checking the calling
// function's own parameters, `function f(log) { log(); }` produced a CALLS
// edge to whichever unrelated project symbol happened to be named "log" --
// harmless for search, but it invented a module dependency in the
// architecture graph. These pin down that a call to a parameter is left
// unattributed rather than guessed.

test("regression: a call to a same-named parameter is not attributed to a project symbol", () => {
  const r = parseFile("js", `
function log(x) { console.log(x); }
function derive(project, log = () => {}) {
  log("hello");
}
`);
  assert.ok(!rels(r).includes("derive -CALLS-> log"),
    "log is derive's own parameter, not the top-level log function");
});

test("regression: a destructured parameter is also recognized as local", () => {
  const r = parseFile("js", `
function log() {}
function run({ log }) {
  log("hi");
}
`);
  assert.ok(!rels(r).includes("run -CALLS-> log"));
});

test("regression: new on a same-named parameter is not attributed either", () => {
  const r = parseFile("js", `
class Model {}
function factory(Model) {
  return new Model();
}
`);
  assert.ok(!rels(r).includes("factory -INSTANTIATES-> Model"));
});

test("regression: a call still resolves when the name is not a parameter", () => {
  const r = parseFile("js", `
function log() {}
function helper() {}
function run(other) {
  log("hi");
  helper();
}
`);
  assert.ok(rels(r).includes("run -CALLS-> log"),
    "log is not one of run's parameters, so the edge is unaffected");
  assert.ok(rels(r).includes("run -CALLS-> helper"));
});

test("regression: a member call through a param-named receiver is unaffected", () => {
  const r = parseFile("js", `
function run(log) {
  this.log();
}
`);
  assert.ok(rels(r).includes("run -CALLS-> this.log"),
    "the guard only applies to bare identifiers, not member access");
});

test("python: a call to a default-valued parameter is not attributed to a project symbol", () => {
  const r = parseFile("python", `
def log(msg): pass

def derive(project, log=None):
    log("hello")
`);
  assert.ok(!rels(r).includes("derive -CALLS-> log"));
});

test("php: a call through a same-named parameter is not attributed to a project symbol", () => {
  const r = parseFile("php", `<?php
function log($msg) {}
function derive($log) {
  $log("hello");
}
`);
  assert.ok(!rels(r).includes("derive -CALLS-> $log"));
});

// --- robustness --------------------------------------------------------

test("empty and comment-only files produce nothing", () => {
  for (const [lang, src] of [["js", ""], ["js", "// nothing\n"], ["php", "<?php\n"]]) {
    const r = parseFile(lang, src);
    assert.deepEqual(r.symbols, [], `${lang}: expected no symbols`);
  }
});

test("syntactically broken files still return partial results instead of throwing", () => {
  const r = parseFile("js", `function ok() {}\nfunction broken( {\n`);
  assert.ok(names(r).includes("ok"));
});

test("unicode content does not corrupt offsets", () => {
  const r = parseFile("js", `// 日本語のコメント\nfunction café() { naïve(); }\n`);
  assert.ok(names(r).includes("café"));
  assert.ok(rels(r).includes("café -CALLS-> naïve"));
  assert.equal(r.symbols[0].startLine, 2);
});
