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
