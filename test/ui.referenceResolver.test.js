import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { config } from "../src/config.js";
import { cleanupTestProject } from "./helpers/testProject.js";
import {
  extractQueryFields,
  canonicalElementType,
  textSimilarity,
  scoreCandidate,
  resolveUiReference,
  MIN_MATCH_SCORE,
  MAX_CANDIDATES,
} from "../src/ui/referenceResolver.js";

// Phase 1A-7 (REQ-008/REQ-009/REQ-010/REQ-011): the UI Reference Resolver.
// Pure-function tests (extractQueryFields/scoreCandidate/textSimilarity) run
// with no DB. resolveUiReference()'s end-to-end tests run against a real
// indexProject() run over a tmp PHP fixture, same "real DB, no mocking"
// convention every prior UI-intelligence phase's test file uses.

test("extractQueryFields: pulls quoted visible_text, screen phrase, element type, viewport, problem type from free text", () => {
  const fields = extractQueryFields(
    'The Save button on the Settings page says "Save Changes" and it is broken on mobile',
    {}
  );
  assert.equal(fields.screen, "Settings");
  assert.equal(fields.element_type, "button");
  assert.equal(fields.visible_text, "Save Changes");
  assert.equal(fields.viewport, "mobile");
  assert.equal(fields.problem_type, "broken");
});

test("extractQueryFields: structured hints (screen/text/role) bypass free-text extraction entirely (Q-009)", () => {
  const fields = extractQueryFields("", { screen: "General Settings", text: "Sync now", role: "button" });
  assert.equal(fields.screen, "General Settings");
  assert.equal(fields.visible_text, "Sync now");
  assert.equal(fields.element_type, "button");
});

test("extractQueryFields: a hint always wins over what free text would have extracted", () => {
  const fields = extractQueryFields('The link on the Billing page says "Upgrade"', {
    screen: "Account",
    text: "Cancel plan",
    role: "checkbox",
  });
  assert.equal(fields.screen, "Account");
  assert.equal(fields.visible_text, "Cancel plan");
  assert.equal(fields.element_type, "checkbox");
});

test("extractQueryFields: no quoted text / no recognizable screen phrase yields null, not a guess", () => {
  const fields = extractQueryFields("something is wrong somewhere", {});
  assert.equal(fields.screen, null);
  assert.equal(fields.visible_text, null);
  assert.equal(fields.element_type, null);
  assert.equal(fields.viewport, null);
  assert.equal(fields.problem_type, null);
});

test("canonicalElementType: recognized synonym maps to canonical form", () => {
  assert.equal(canonicalElementType("input"), "textbox");
  assert.equal(canonicalElementType("dropdown"), "select");
  assert.equal(canonicalElementType("a"), "a"); // bare tag "a" isn't in the phrase table -- passthrough
  assert.equal(canonicalElementType("link"), "link");
});

test("canonicalElementType: unrecognized structured hint passes through normalized rather than being dropped", () => {
  assert.equal(canonicalElementType("combobox"), "combobox");
});

test("textSimilarity: exact match, substring, token overlap, and no-match all score as expected", () => {
  assert.equal(textSimilarity("Save Changes", "Save Changes"), 1);
  assert.equal(textSimilarity("Save Changes", "save changes"), 1);
  assert.equal(textSimilarity("Save", ""), 0);
  assert.equal(textSimilarity("", "Save"), 0);
  assert.ok(textSimilarity("Save Changes Now", "Save Changes") >= 0.8);
  assert.equal(textSimilarity("Save Changes", "Delete Everything"), 0);
});

test("scoreCandidate: REQ-011 weighted sum, all four signals contributing", () => {
  const candidate = {
    data: {
      text: "Save Changes",
      text_source: "child_text",
      type: "button",
      role: null,
      owner: "Admin_Page::render_page",
      source_path: "admin.php",
    },
    screens: [
      { route: "admin.php?page=my-slug", menu_slug: "my-slug", page_title: "My Page Title", menu_title: "My Menu" },
    ],
  };
  const queryFields = {
    screen: "my page title",
    element_type: "button",
    visible_text: "Save Changes",
    taskText: "Save button on the admin page rendered by render_page",
  };
  const { match_score, evidence } = scoreCandidate(candidate, queryFields);
  assert.ok(match_score > 0.85, `expected high score, got ${match_score}`);
  assert.deepEqual(evidence, ["text", "route", "role", "context"]);
});

test("scoreCandidate: EDGE-006 -- zero screens still scores text/role signals, never throws", () => {
  const candidate = {
    data: { text: "Save Changes", type: "button", owner: "@file", source_path: "x.php" },
    screens: [],
  };
  const { match_score, evidence } = scoreCandidate(candidate, {
    visible_text: "Save Changes",
    element_type: "button",
  });
  assert.ok(match_score > 0);
  assert.deepEqual(evidence, ["text", "role"]);
});

test("scoreCandidate: EDGE-006 -- multiple screens take the best (max) route match, not the first", () => {
  const candidate = {
    data: { text: "Save", type: "button", owner: "@file", source_path: "x.php" },
    screens: [
      { page_title: "Totally Unrelated" },
      { page_title: "Billing Settings" },
    ],
  };
  const { match_score, evidence } = scoreCandidate(candidate, { screen: "Billing Settings" });
  assert.ok(match_score >= 0.3 * 0.99, `expected route signal near-full weight, got ${match_score}`);
  assert.ok(evidence.includes("route"));
});

test("scoreCandidate: no matching signal at all scores 0 with empty evidence", () => {
  const candidate = {
    data: { text: "Delete", type: "link", owner: "@file", source_path: "x.php" },
    screens: [],
  };
  const { match_score, evidence } = scoreCandidate(candidate, { visible_text: "Save", element_type: "button" });
  assert.equal(match_score, 0);
  assert.deepEqual(evidence, []);
});

// ---------------------------------------------------------------------------
// resolveUiReference() -- real DB, real indexProject() run.
// ---------------------------------------------------------------------------

const PROJECT = "ui_resolver_fixture";
let dir;

function writeFixture() {
  fs.writeFileSync(
    path.join(dir, "admin.php"),
    `<?php
class Admin_Page {
  public function boot() {
    add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', array( $this, 'render_page' ) );
  }
  public function render_page() {
    submit_button( 'Save Changes' );
    ?>
    <a href="#" aria-label="Cancel this form"></a>
    <button>Delete Everything</button>
    <?php
  }
}
`
  );
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-resolver-"));
  writeFixture();
  await indexProject(PROJECT, dir, () => {});
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("resolveUiReference: ranks the exact text match first, excludes unrelated elements below the 0.45 floor", async () => {
  const { enabled, queryFields, candidates } = await resolveUiReference({
    project: PROJECT,
    taskText: 'The button that says "Save Changes" on the My Page Title screen',
  });
  assert.equal(enabled, true);
  assert.equal(queryFields.visible_text, "Save Changes");
  assert.ok(candidates.length >= 1, "expected at least one candidate");
  assert.equal(candidates[0].visible_text, "Save Changes");
  assert.ok(candidates[0].match_score >= MIN_MATCH_SCORE);
  for (const c of candidates) {
    assert.ok(c.match_score >= MIN_MATCH_SCORE, `candidate ${c.element_id} scored below the floor`);
  }
  // "Delete Everything" shares no text/screen/role signal with the query and
  // must not appear.
  assert.ok(!candidates.some((c) => c.visible_text === "Delete Everything"));
});

test("resolveUiReference: never returns more than MAX_CANDIDATES", async () => {
  const { candidates } = await resolveUiReference({
    project: PROJECT,
    taskText: "button",
  });
  assert.ok(candidates.length <= MAX_CANDIDATES);
});

test("resolveUiReference: text_source is passed through from the already-computed ui_element field, not re-derived", async () => {
  // An exact text match alone (0.40 weight) sits below the 0.45 floor by
  // design (REQ-010's floor exceeds any single signal's max weight) -- a
  // realistic caller supplies more than one hint, so a role hint is added
  // here for corroboration.
  const { candidates } = await resolveUiReference({
    project: PROJECT,
    hints: { text: "Save Changes", role: "button" },
  });
  const hit = candidates.find((c) => c.visible_text === "Save Changes");
  assert.ok(hit, "expected the Save Changes candidate to be found via a structured hint");
  assert.equal(hit.text_source, "child_text");
});

test("resolveUiReference: aria-label-only element matches via structured role hint + text hint", async () => {
  const { candidates } = await resolveUiReference({
    project: PROJECT,
    hints: { text: "Cancel this form", role: "link" },
  });
  const hit = candidates.find((c) => c.visible_text === "Cancel this form");
  assert.ok(hit, "expected aria-label element to be found");
  assert.equal(hit.text_source, "aria_label");
});

test("resolveUiReference: unknown project rejects rather than silently returning empty", async () => {
  await assert.rejects(() => resolveUiReference({ project: "no_such_project_xyz", taskText: "anything" }));
});

test("resolveUiReference: config.uiEnabled=false short-circuits before any DB query", async () => {
  const original = config.uiEnabled;
  config.uiEnabled = false;
  try {
    const result = await resolveUiReference({ project: "no_such_project_xyz", taskText: "anything" });
    assert.deepEqual(result, { enabled: false, queryFields: null, candidates: [] });
  } finally {
    config.uiEnabled = original;
  }
});
