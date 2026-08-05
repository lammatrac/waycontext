import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/reasoning/slug.js";

test("slugify lowercases and hyphenates a title", () => {
  assert.equal(slugify("Forgot password"), "forgot-password");
});

test("slugify collapses punctuation and whitespace runs into one hyphen", () => {
  assert.equal(slugify("  Forgot   Password!! (v2)  "), "forgot-password-v2");
});

test("slugify strips leading/trailing hyphens", () => {
  assert.equal(slugify("--Reset Email--"), "reset-email");
});

test("slugify falls back to a non-empty default for a degenerate title", () => {
  assert.equal(slugify("!!!"), "feature");
  assert.equal(slugify(""), "feature");
});
