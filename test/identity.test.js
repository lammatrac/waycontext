import { test } from "node:test";
import assert from "node:assert/strict";
import {
  symbolKey, bodyFingerprint, assignSymbolKeys, matchRenames, MIN_FINGERPRINT_CHARS,
} from "../src/identity.js";

const longBody = (marker) => `function x() { ${marker.padEnd(90, " /* pad */")} }`;

// --- keys ------------------------------------------------------------------

test("symbolKey is location + shape, and only suffixes actual duplicates", () => {
  assert.equal(symbolKey("src/a.js", "function", "run"), "src/a.js#function:run");
  assert.equal(symbolKey("src/a.js", "function", "run", 1), "src/a.js#function:run");
  assert.equal(symbolKey("src/a.js", "function", "run", 3), "src/a.js#function:run~3");
});

test("assignSymbolKeys numbers duplicates in source order, not array order", () => {
  // Deliberately out of line order: the parser is not required to emit
  // symbols top-to-bottom, but the key numbering has to be positional so it
  // agrees with the SQL backfill's ORDER BY start_line.
  const symbols = [
    { name: "helper", kind: "function", startLine: 40, body: longBody("second") },
    { name: "helper", kind: "function", startLine: 10, body: longBody("first") },
    { name: "other", kind: "function", startLine: 20, body: longBody("other") },
  ];
  const keys = assignSymbolKeys("src/u.js", symbols).map((k) => k.key);
  assert.deepEqual(keys, [
    "src/u.js#function:helper~2",
    "src/u.js#function:helper",
    "src/u.js#function:other",
  ]);
});

test("a name that is duplicated under different kinds is not treated as a duplicate", () => {
  const symbols = [
    { name: "Thing", kind: "class", startLine: 1, body: longBody("c") },
    { name: "Thing", kind: "function", startLine: 20, body: longBody("f") },
  ];
  const keys = assignSymbolKeys("src/u.js", symbols).map((k) => k.key);
  assert.deepEqual(keys, ["src/u.js#class:Thing", "src/u.js#function:Thing"]);
});

test("keys within one file are unique, which is what the entity upsert relies on", () => {
  const symbols = Array.from({ length: 5 }, (_, i) => ({
    name: "same", kind: "method", startLine: i * 10, body: longBody(`b${i}`),
  }));
  const keys = assignSymbolKeys("src/u.js", symbols).map((k) => k.key);
  assert.equal(new Set(keys).size, keys.length);
});

// --- fingerprints ----------------------------------------------------------

test("bodyFingerprint ignores reindentation but not content", () => {
  const a = "function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}";
  const b = "function total(items) {\n\t\treturn items.reduce((s, i) => s + i.price, 0);\n}";
  const c = "function total(items) {\n  return items.reduce((s, i) => s + i.cost, 0);\n}";
  assert.equal(bodyFingerprint(a), bodyFingerprint(b));
  assert.notEqual(bodyFingerprint(a), bodyFingerprint(c));
});

test("bodies too short to be distinctive are not fingerprinted at all", () => {
  assert.equal(bodyFingerprint("get() { return 1; }"), null);
  assert.equal(bodyFingerprint(""), null);
  assert.equal(bodyFingerprint(null), null);
  assert.equal(bodyFingerprint("x".repeat(MIN_FINGERPRINT_CHARS - 1)), null);
  assert.ok(bodyFingerprint("x".repeat(MIN_FINGERPRINT_CHARS)));
});

// --- rename matching -------------------------------------------------------

const row = (over) => ({ kind: "function", name: "run", fingerprint: null, ...over });

test("an identical body in a new file is a move, and carries the entity over", () => {
  const renames = matchRenames(
    [row({ key: "a.js#function:run", path: "a.js", fingerprint: "fp1", entityId: 7 })],
    [row({ key: "b.js#function:run", path: "b.js", fingerprint: "fp1" })]
  );
  assert.equal(renames.length, 1);
  assert.deepEqual(renames[0], {
    oldKey: "a.js#function:run", newKey: "b.js#function:run",
    oldPath: "a.js", newPath: "b.js", entityId: 7, reason: "move",
  });
});

test("a moved symbol whose body also changed is still matched, by kind and name", () => {
  const renames = matchRenames(
    [row({ key: "a.js#function:run", path: "a.js", fingerprint: "before", entityId: 7 })],
    [row({ key: "pkg/a.js#function:run", path: "pkg/a.js", fingerprint: "after" })]
  );
  assert.equal(renames.length, 1);
  assert.equal(renames[0].reason, "move");
  assert.equal(renames[0].entityId, 7);
});

test("an ambiguous fingerprint is left unmatched rather than guessed", () => {
  // Two functions with the same body vanish and two appear. Any pairing would
  // be a coin flip, and a wrong one moves a whole history onto other code.
  const renames = matchRenames(
    [
      row({ key: "a.js#function:one", name: "one", path: "a.js", fingerprint: "dup", entityId: 1 }),
      row({ key: "a.js#function:two", name: "two", path: "a.js", fingerprint: "dup", entityId: 2 }),
    ],
    [
      row({ key: "b.js#function:three", name: "three", path: "b.js", fingerprint: "dup" }),
      row({ key: "b.js#function:four", name: "four", path: "b.js", fingerprint: "dup" }),
    ]
  );
  assert.deepEqual(renames, []);
});

test("fingerprint matching wins over name matching, and neither double-claims", () => {
  const renames = matchRenames(
    [
      row({ key: "a.js#function:run", path: "a.js", fingerprint: "fp1", entityId: 1 }),
      row({ key: "a.js#function:helper", name: "helper", path: "a.js", fingerprint: "fp2", entityId: 2 }),
    ],
    [
      row({ key: "b.js#function:run", path: "b.js", fingerprint: "fp1" }),
      row({ key: "b.js#function:helper", name: "helper", path: "b.js", fingerprint: "changed" }),
    ]
  );
  assert.equal(renames.length, 2);
  assert.deepEqual(
    renames.map((r) => [r.entityId, r.newKey]).sort(),
    [[1, "b.js#function:run"], [2, "b.js#function:helper"]].sort()
  );
});

test("a symbol that simply disappeared produces no rename", () => {
  assert.deepEqual(
    matchRenames([row({ key: "a.js#function:run", path: "a.js", fingerprint: "fp1", entityId: 1 })], []),
    []
  );
});

test("an in-place identifier rename is deliberately NOT matched", () => {
  // The declaration is part of the body, so both the fingerprint and the name
  // changed. There is nothing left linking the two that wouldn't also link two
  // unrelated edits -- see the note in src/identity.js.
  const renames = matchRenames(
    [row({ key: "a.js#function:oldName", name: "oldName", path: "a.js", fingerprint: "fp1", entityId: 1 })],
    [row({ key: "a.js#function:newName", name: "newName", path: "a.js", fingerprint: "fp2" })]
  );
  assert.deepEqual(renames, []);
});
