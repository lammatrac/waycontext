import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStatement, ruleKey, extractNormativeSentences, inferScope,
} from "../src/knowledge/rules.js";

test("prohibitions score highest, preferences lowest", () => {
  const byCue = (text) => extractNormativeSentences(text)[0];
  assert.ok(byCue("Never commit secrets to the repository.").confidence >= 0.65);
  assert.ok(byCue("You must validate the webhook signature.").confidence >= 0.6);
  assert.ok(byCue("Prefer the batch endpoint for bulk writes.").confidence >= 0.5);
});

test("sentences with no normative cue are dropped", () => {
  assert.deepEqual(extractNormativeSentences("This module parses YAML frontmatter."), []);
});

test("questions, fragments and essays are dropped", () => {
  assert.deepEqual(extractNormativeSentences("Should we never do this?"), []);
  assert.deepEqual(extractNormativeSentences("never"), []);
  assert.deepEqual(extractNormativeSentences(`You must ${"x".repeat(400)}`), []);
});

test("list items and multiple sentences are each considered", () => {
  const found = extractNormativeSentences(
    "- Never log full card numbers.\n- Always redact the CVV.\n- This one is just prose.\n"
  );
  assert.equal(found.length, 2);
  assert.ok(found.every((f) => !f.sentence.startsWith("-")), "list markers stripped");
});

test("fenced code contributes no rules", () => {
  assert.deepEqual(extractNormativeSentences("```js\n// never mutate props here at all\n```\n"), []);
});

// The three failure modes that showed up when this ran against a real repo's
// README for the first time. All 75 candidates were technically cue-matched and
// perhaps four were rules.
test("hard-wrapped prose is reflowed before splitting, so sentences stay whole", () => {
  const found = extractNormativeSentences(
    "Never commit a secret to the repository, because history\nis public and rewriting it is worse.\n"
  );
  assert.equal(found.length, 1);
  assert.match(found[0].sentence, /history is public/, "the wrapped line rejoined");
});

test("a sentence truncated mid-clause is not a rule", () => {
  assert.deepEqual(extractNormativeSentences("It never deletes, never deactivates, and never"), []);
  assert.deepEqual(extractNormativeSentences("The upsert refreshes provenance but never"), []);
});

test("descriptive uses of never are not prescriptions", () => {
  assert.deepEqual(extractNormativeSentences("You never write this column directly."), []);
  assert.deepEqual(extractNormativeSentences("NULL means never git-diff-indexed on this run."), []);
  assert.deepEqual(extractNormativeSentences("The ids are never reused by this table."), []);
  assert.deepEqual(extractNormativeSentences("It never fails an index when git is absent."), []);
});

test("prescriptions survive wherever the cue sits in the clause", () => {
  assert.equal(extractNormativeSentences("Never edit an applied migration file.").length, 1);
  assert.equal(
    extractNormativeSentences("Add a new migration file — never edit an applied one.").length,
    1,
    "clause-initial after a dash still counts"
  );
  assert.equal(extractNormativeSentences("A fenced code block must never be split.").length, 1);
  assert.equal(extractNormativeSentences("You should pin the migration version.").length, 1);
});

test("markdown table rows contribute no rules", () => {
  assert.deepEqual(
    extractNormativeSentences("| Identity | `entities` | append + tombstone, ids are never reused |\n"),
    []
  );
});

test("emphasis markers do not survive into the statement", () => {
  const [found] = extractNormativeSentences("**Never** commit a secret to this repository.");
  assert.equal(found.sentence, "Never commit a secret to this repository");
});

test("scope is the common directory of the paths", () => {
  assert.equal(inferScope(["src/payments/api.js", "src/payments/refund.js"]), "src/payments/**");
  assert.equal(inferScope(["src/payments/api.js"]), "src/payments/api.js");
  assert.equal(inferScope(["src/a.js", "docs/b.md"]), null);
  assert.equal(inferScope([]), null);
});

test("keys are deterministic, and stable under trivial rewording", () => {
  assert.equal(
    ruleKey("Never commit secrets.", "src/**"),
    ruleKey("  never   Commit secrets  ", "src/**"),
    "normalization folds case, spacing and trailing punctuation"
  );
  assert.notEqual(ruleKey("Never commit secrets.", "src/**"), ruleKey("Never commit secrets.", null));
  assert.match(ruleKey("Never commit secrets.", null), /^rule:[0-9a-f]{12}$/);
});

test("normalizeStatement keeps the sentence readable", () => {
  assert.equal(normalizeStatement("  Never   commit secrets.  "), "never commit secrets");
});
