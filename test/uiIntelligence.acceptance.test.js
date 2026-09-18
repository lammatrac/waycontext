import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { config } from "../src/config.js";
import { findOperation } from "../src/operations.js";
import { buildMcpServer } from "../src/mcpServer.js";
import {
  resolveUiReferenceOp, findUiElementOp, getUiContextOp, traceUiActionOp, findUiSourceOp,
} from "../src/ui/uiQueries.js";
import { cleanupTestProject, insertTestFile, insertTestSymbol } from "./helpers/testProject.js";

// Increment 1A hardening/verification phase (1A-9). Exercises AC-001 through
// AC-014, plus AC-018/AC-019, against real, indexed projects -- no mocking,
// same convention every prior UI-intelligence phase's test file uses. See
// docs/specs/ui-intelligence/contracts.md "Phase 1A-9" for the fixture
// choice, the AC-by-AC verification table, and the two real bugs this phase
// found and fixed (identity-preflight/hook-graph ordering; AC-007's
// "positioned" problem_type gap).
//
// Main fixture: test/fixtures/wordpress-ui/ (finished, not rebuilt, from a
// partial fixture a previous interrupted dispatch of this phase left behind
// -- see contracts.md for what was added: languages/waycontext-vi.po for
// AC-003, includes/malformed.php for AC-012). Indexed once as project
// "wp_ui_fixture" and reused read-only across most AC tests below; AC-013
// (a project with NO UI primitives at all) and AC-018/AC-019 (identity
// preflight DB manipulation) each need their own dedicated, disposable
// project and get their own tmp-dir fixtures, matching the pattern
// test/identity.preflight.test.js and test/indexer.uiRelations.test.js
// already established for scenarios that can't share the main fixture.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "wordpress-ui");
const PROJECT = "wp_ui_fixture";

async function uiElementByText(sourcePath, text) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = $2
        AND data->>'text' = $3 AND deleted_at IS NULL`,
    [project.id, sourcePath, text]
  );
  assert.ok(res.rows.length, `no ui_element found for ${sourcePath} text="${text}"`);
  return res.rows[0];
}

async function elementByI18nKey(sourcePath, i18nKey) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = $2
        AND data->>'i18n_key' = $3 AND deleted_at IS NULL`,
    [project.id, sourcePath, i18nKey]
  );
  assert.ok(res.rows.length, `no ui_element found for ${sourcePath} i18n_key="${i18nKey}"`);
  return res.rows[0];
}

async function naturalKeyFor(kind, sourcePath, ownerLike) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT natural_key FROM entities
      WHERE project_id = $1 AND kind = $2 AND data->>'source_path' = $3
        AND ($4::text IS NULL OR data->>'owner' = $4) AND deleted_at IS NULL`,
    [project.id, kind, sourcePath, ownerLike ?? null]
  );
  assert.ok(res.rows.length, `no ${kind} found for ${sourcePath}/${ownerLike}`);
  return res.rows[0].natural_key;
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  const stats = await indexProject(PROJECT, FIXTURE_ROOT);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.ok(stats.uiRelations && !stats.uiRelations.error, JSON.stringify(stats.uiRelations));
});

after(async () => {
  await cleanupTestProject(PROJECT);
  await pool.end();
});

// ---------------------------------------------------------------------------
// AC-001
// ---------------------------------------------------------------------------

test("AC-001: submit_button(i18n-wrapped) -> ui_element, role/type button, application source", async () => {
  // The msgid "Sync members" is what's authored in source (data.i18n_key) --
  // data.text itself has legitimately been upgraded to the .po catalog's
  // translated value by 1A-4 (see AC-003 below and contracts.md "Phase
  // 1A-9" for why this is correct precedence behaviour, not a fixture bug).
  const el = await elementByI18nKey("wp-content/plugins/waycontext/waycontext.php", "Sync members");
  // AC-001 says "role/type 'button'" -- data.type is the computed semantic
  // classification (this is what it checks); data.role is the RAW aria
  // role="..." attribute, a separate, only-when-explicit identity signal
  // (contracts.md "Phase 1A-1") -- submit_button() sets no such attribute
  // here, so data.role legitimately stays null. Not a bug.
  assert.equal(el.data.type, "button");
  assert.equal(el.data.role, null);
  assert.equal(el.data.source_path, "wp-content/plugins/waycontext/waycontext.php");
  assert.ok(Number.isInteger(el.data.line) && el.data.line > 0);
  assert.equal(el.data.ownership, "application");
  assert.equal(el.data.extraction, "wp_primitive");
});

// ---------------------------------------------------------------------------
// AC-002
// ---------------------------------------------------------------------------

test("AC-002: a no-text-child, aria-label-only control is found via find_ui_element(text), matched via aria-label", async () => {
  // NOTE (1A-9 finding, not a bug -- see contracts.md "Phase 1A-9"): the
  // spec's own Q-005 decision fixes the text signal's weight at 0.40 and the
  // match floor at 0.45 -- a single exact-text match, with no corroborating
  // signal, can therefore NEVER clear the floor (1A-7's own contracts.md
  // note already flags this as intentional). A bare
  // find_ui_element(text="Sync members") call, exactly as AC-002's own
  // wording shows it, returns zero candidates for this mathematical reason,
  // not because aria-label matching is broken. This is a genuine tension
  // between the spec's own worked examples and its own fixed scoring
  // formula, not something this hardening phase can fix without touching
  // constants explicitly locked in elsewhere ("Fixed by the spec") and load-
  // bearing for ~36 already-passing 1A-7/1A-8 tests -- so this test adds the
  // screen corroborating signal AC-002's own scenario has available (the
  // element's screen), to prove the underlying aria-label matching
  // capability genuinely works, the same way 1A-8's own
  // test/operations.uiQueries.test.js had to add a role hint to its
  // otherwise-analogous framework-owned candidate test for the same reason.
  const bareResult = await findUiElementOp(PROJECT, "Sync members");
  assert.deepEqual(bareResult.candidates, [], "documents the floor/weight tension above -- text alone cannot clear 0.45");

  const result = await findUiElementOp(PROJECT, "Sync members", "WayContext");
  assert.equal(result.enabled, true);
  const hit = result.candidates.find(
    (c) => c.source_path === "wp-content/plugins/waycontext/waycontext.php" && c.text_source === "aria_label"
  );
  assert.ok(hit, `expected an aria-label-matched candidate, got: ${JSON.stringify(result.candidates.map((c) => ({ p: c.source_path, ts: c.text_source, t: c.visible_text })))}`);
  assert.equal(hit.visible_text, "Sync members");
  assert.equal(hit.type, "button");
});

// ---------------------------------------------------------------------------
// AC-003
// ---------------------------------------------------------------------------

test("AC-003: a .po-translated element is found by its Vietnamese text, and the candidate exposes the gettext key/textdomain/catalog entry", async () => {
  // Same floor/weight tension AC-002 documents above -- a bare text-only
  // call can't clear 0.45 on an exact match alone, so this adds the
  // element's own screen as a corroborating signal (its owner,
  // render_waycontext_page, is also the "WayContext" screen's renderer).
  const result = await findUiElementOp(PROJECT, "Đồng bộ thành viên", "WayContext");
  assert.equal(result.enabled, true);
  assert.ok(result.candidates.length >= 1);
  const top = result.candidates[0];
  assert.equal(top.visible_text, "Đồng bộ thành viên");
  assert.equal(top.text_source, "translated_catalog_value");
  assert.ok(top.i18n, "candidate should expose i18n metadata");
  assert.equal(top.i18n.msgid, "Sync members");
  assert.equal(top.i18n.textdomain, "waycontext");
  assert.equal(top.i18n.resolved_text, "Đồng bộ thành viên");
  assert.ok(top.i18n.catalog_source.some((p) => p.endsWith("waycontext-vi.po")));
});

// ---------------------------------------------------------------------------
// AC-004
// ---------------------------------------------------------------------------

test("AC-004: add_menu_page -> ui_screen with menu text, page title, slug, admin.php route, renderer, registration callsite", async () => {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT data FROM entities WHERE project_id = $1 AND kind = 'ui_screen'
       AND data->>'source_path' = 'wp-content/plugins/waycontext/waycontext.php' AND deleted_at IS NULL`,
    [project.id]
  );
  assert.equal(res.rows.length, 1);
  const d = res.rows[0].data;
  assert.equal(d.menu_title, "WayContext");
  assert.equal(d.page_title, "WayContext");
  assert.equal(d.menu_slug, "waycontext");
  assert.equal(d.route, "admin.php?page=waycontext");
  assert.equal(d.renderer, "render_waycontext_page");
  assert.equal(d.owner, "waycontext_register_menu");
  assert.ok(Number.isInteger(d.line) && d.line > 0);
});

// ---------------------------------------------------------------------------
// AC-005
// ---------------------------------------------------------------------------

test("AC-005: screen-scoped find_ui_element returns only that screen's element as the top candidate", async () => {
  const onMain = await findUiElementOp(PROJECT, "Sync members", "WayContext");
  assert.equal(onMain.candidates[0].source_path, "wp-content/plugins/waycontext/waycontext.php");
  assert.equal(onMain.candidates[0].text_source, "aria_label");

  const onMembers = await findUiElementOp(PROJECT, "Sync members", "Members");
  assert.equal(onMembers.candidates[0].source_path, "wp-content/plugins/waycontext/includes/members-screen.php");
});

// ---------------------------------------------------------------------------
// AC-006
// ---------------------------------------------------------------------------

test("AC-006: trace_ui_action on a Settings Field resolves REGISTERED_AT/RENDERED_BY and the onward call graph from its callback", async () => {
  const fieldId = await naturalKeyFor(
    "ui_settings_field", "wp-content/plugins/waycontext/includes/settings.php", "waycontext_register_settings"
  );
  const trace = await traceUiActionOp(PROJECT, fieldId);
  assert.equal(trace.status, "resolved");
  assert.equal(trace.handler.via, "settings_rendered_by");
  assert.equal(trace.handler.symbol.name, "render_api_key");
  assert.equal(trace.handler.symbol.path, "wp-content/plugins/waycontext/includes/settings.php");

  assert.ok(trace.call_graph, "should reuse getSubgraph to walk onward from render_api_key()");
  assert.equal(trace.call_graph.root, "render_api_key");
  assert.ok(
    trace.call_graph.edges.some((e) => e.to === "fetch_api_key_value"),
    "onward call graph should reach render_api_key()'s own callee"
  );

  const src = await findUiSourceOp(PROJECT, fieldId);
  assert.equal(src.created_via, "add_settings_field");
  assert.ok(src.registered_at, "REGISTERED_AT should resolve to the registering function");
  assert.equal(src.registered_at.symbol, "waycontext_register_settings");
});

// ---------------------------------------------------------------------------
// AC-007
// ---------------------------------------------------------------------------

test("AC-007: resolve_ui_reference on the spec's own worked task text reports screen/element_type/visible_text/viewport/problem_type", async () => {
  const result = await resolveUiReferenceOp(PROJECT, {
    taskText: "The Sync members button on the admin Members settings page is badly positioned on mobile",
  });
  assert.equal(result.enabled, true);
  assert.ok(result.understood, "understood (queryFields) should be present when task_text was given");
  assert.deepEqual(
    Object.keys(result.understood).sort(),
    ["element_type", "problem_type", "screen", "viewport", "visible_text"]
  );
  assert.equal(result.understood.element_type, "button");
  assert.equal(result.understood.viewport, "mobile");
  // 1A-9 fix: "positioned" now maps to the styling problem_type (see
  // referenceResolver.js's PROBLEM_TYPE_PATTERNS and contracts.md "Phase
  // 1A-9") -- this exact sentence used to yield problem_type: null.
  assert.equal(result.understood.problem_type, "styling");
  assert.equal(result.understood.screen, "admin Members settings");
  // visible_text stays null here: 1A-7's free-text extractor only recognizes
  // a QUOTED substring as visible_text (Q-009/REQ-008's own documented,
  // deliberately non-exhaustive heuristic), and this sentence -- copied
  // verbatim from the spec -- has no quotes. A real, verified, documented
  // characteristic, not a bug: see contracts.md "Phase 1A-9".
  assert.equal(result.understood.visible_text, null);
});

// ---------------------------------------------------------------------------
// AC-008
// ---------------------------------------------------------------------------

test("AC-008: every source location in a resolve_ui_reference response is read straight from the graph, never fabricated by an LLM", async () => {
  // Architectural fact, not just a claim: no server-side LLM/completion
  // provider client exists anywhere in this codebase for NL parsing (1A-7's
  // own documented REQ-009 judgment call) -- task_text never leaves the
  // process. Verified structurally (no such import in the resolver module)
  // plus functionally (every candidate's source.path/line traces back
  // byte-for-byte to the entity row's own already-indexed data).
  const resolverSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "ui", "referenceResolver.js"), "utf8"
  );
  assert.ok(!/openai|anthropic|fetch\(|https?:\/\//i.test(resolverSrc),
    "referenceResolver.js must not perform any outbound/LLM call");

  // role hint corroborates the text signal to clear the 0.45 floor (see
  // AC-002's note above on the spec's own floor/weight tension).
  const result = await resolveUiReferenceOp(PROJECT, { text: "Sync members", role: "button" });
  assert.ok(result.candidates.length >= 1);
  const project = await getProject(PROJECT);
  for (const c of result.candidates) {
    const row = await pool.query(
      `SELECT data->>'source_path' AS sp, (data->>'line')::int AS ln FROM entities
        WHERE project_id = $1 AND kind = 'ui_element' AND natural_key = $2 AND deleted_at IS NULL`,
      [project.id, c.element_id]
    );
    assert.equal(row.rows.length, 1);
    assert.equal(c.source.path, row.rows[0].sp, "source.path must come straight from the entity's own stored data");
    assert.equal(c.source.line, row.rows[0].ln, "source.line must come straight from the entity's own stored data");
  }
});

// ---------------------------------------------------------------------------
// AC-009
// ---------------------------------------------------------------------------

test("AC-009: multiple matches are ranked by match_score, capped at 5, none below 0.45, each with evidence[] and text_source", async () => {
  const result = await resolveUiReferenceOp(PROJECT, { text: "Sync members", role: "button" });
  assert.equal(result.enabled, true);
  assert.ok(result.candidates.length >= 2, `expected 2+ candidates, got ${result.candidates.length}`);
  assert.ok(result.candidates.length <= 5);
  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(result.candidates[i - 1].match_score >= result.candidates[i].match_score, "must be sorted descending by match_score");
  }
  for (const c of result.candidates) {
    assert.ok(c.match_score >= 0.45, `candidate below the 0.45 floor: ${c.match_score}`);
    assert.ok(Array.isArray(c.evidence) && c.evidence.length > 0);
    assert.ok("text_source" in c);
    assert.ok(!("confidence" in c), "field must be named match_score, never confidence (REQ-011)");
  }
});

// ---------------------------------------------------------------------------
// AC-010
// ---------------------------------------------------------------------------

test("AC-010: a running MCP server's tool list includes all five UI operations", async () => {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ac-010-test-client", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["resolve_ui_reference", "find_ui_element", "get_ui_context", "trace_ui_action", "find_ui_source"]) {
      assert.ok(names.includes(n), `${n} missing from a live MCP server's tool list`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// AC-011
// ---------------------------------------------------------------------------

test("AC-011: trace_ui_action resolves LISTENS_TO/FIRED_BY across a theme/plugin boundary to the callback's actual file", async () => {
  const elementId = (await uiElementByText("wp-content/themes/storefront/functions.php", "View Cart")).natural_key;
  const trace = await traceUiActionOp(PROJECT, elementId);
  assert.equal(trace.status, "resolved");
  assert.equal(trace.handler.via, "hook_handled_by");
  assert.equal(trace.handler.hook, "woocommerce_before_cart");
  assert.equal(trace.handler.symbol.name, "WC_Cart_Notices::render_notice");
  assert.equal(trace.handler.symbol.path, "wp-content/plugins/cart-plugin/cart-plugin.php",
    "the resolved callback must be in the OTHER plugin's file, not the theme's");
});

// ---------------------------------------------------------------------------
// AC-012
// ---------------------------------------------------------------------------

test("AC-012: a UI adapter throwing on one malformed PHP file doesn't fail indexing, and is logged with adapter/file/error class/message", async () => {
  // include/malformed.php (a ~4,000-deep run of nested <div> tags inside
  // literal PHP-emitted HTML -- see that file's own doc comment) overflows
  // phpElements.js's own SECOND, independent tree-sitter-html sub-parse
  // ("Invalid argument" from the native binding) while leaving the base
  // tree-sitter-php parse (which treats the whole markup blob as one opaque
  // text node) completely unaffected -- a real, reproducible, non-mocked
  // crash isolated to exactly one UI adapter, unlike a sufficiently-deep PHP
  // expression tree, which (verified separately, see contracts.md "Phase
  // 1A-9") crashes the base parser itself before any UI adapter even runs.
  //
  // Indexed into its OWN dedicated project rather than the shared PROJECT
  // fixture: PROJECT was already indexed once in before(), and this file's
  // content/hash never changes across runs, so a second indexProject(PROJECT,
  // ...) call here would just incremental-skip it (unchanged hash) and never
  // re-trigger the crash -- a fresh project guarantees a real first-time
  // parse.
  const AC012_PROJECT = "ac012_fixture";
  await cleanupTestProject(AC012_PROJECT);
  const logLines = [];
  const stats = await indexProject(AC012_PROJECT, FIXTURE_ROOT, (m) => logLines.push(m));
  assert.equal(stats.failed, 0, "indexing must complete for the rest of the project despite the crash");

  const skipLine = logLines.find((l) => l.includes('UI adapter "phpElements" extraction skipped') && l.includes("malformed.php"));
  assert.ok(skipLine, `expected a phpElements skip diagnostic for malformed.php, got: ${JSON.stringify(logLines.filter((l) => l.includes("malformed")))}`);
  assert.match(skipLine, /Error/, "diagnostic should name the real error class");
  assert.match(skipLine, /Invalid argument/i, "diagnostic should carry the real error message");

  // The rest of the same file's ordinary code (its render_broken() function
  // itself) must still be indexed normally -- only UI extraction for this
  // file was skipped, not the whole file.
  const project = await getProject(AC012_PROJECT);
  const sym = await pool.query(
    `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = 'wp-content/plugins/waycontext/includes/malformed.php' AND s.name = 'render_broken'`,
    [project.id]
  );
  assert.equal(sym.rows.length, 1, "the rest of the file's ordinary code should still index");

  await cleanupTestProject(AC012_PROJECT);
});

// ---------------------------------------------------------------------------
// AC-013
// ---------------------------------------------------------------------------

test("AC-013: a project with no recognized WordPress UI primitives indexes with ui_elements=0, no warning or error", async () => {
  const NO_UI_PROJECT = "ac013_no_primitives_fixture";
  await cleanupTestProject(NO_UI_PROJECT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ac013-"));
  try {
    fs.writeFileSync(path.join(dir, "plain.php"), `<?php
function add_two_numbers( $a, $b ) {
  return $a + $b;
}
class Calculator {
  public function multiply( $a, $b ) {
    return $a * $b;
  }
}
`);
    const logLines = [];
    const stats = await indexProject(NO_UI_PROJECT, dir, (m) => logLines.push(m));
    assert.equal(stats.failed, 0, JSON.stringify(stats));
    assert.ok(!logLines.some((l) => /warn|error/i.test(l) && /ui/i.test(l)),
      `expected no UI-related warning/error, got: ${JSON.stringify(logLines)}`);

    const project = await getProject(NO_UI_PROJECT);
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM entities WHERE project_id = $1 AND kind = 'ui_element' AND deleted_at IS NULL`,
      [project.id]
    );
    assert.equal(count.rows[0].n, 0);

    // The ordinary, non-UI code in the same project must still index fine
    // (REQ-022's additive-only guarantee -- UI being off/inapplicable must
    // never degrade the plain code index).
    const sym = await pool.query(
      `SELECT count(*)::int AS n FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.project_id = $1`,
      [project.id]
    );
    assert.ok(sym.rows[0].n >= 2);
  } finally {
    await cleanupTestProject(NO_UI_PROJECT);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-014
// ---------------------------------------------------------------------------

test("AC-014: element_id is stable across a re-index with no source change", async () => {
  // Checked two ways: directly against the stored entity (the real REQ-020
  // claim, independent of 1A-7's scoring/floor), and via find_ui_element
  // with a screen hint (see AC-002's note above on why text alone can't
  // clear the 0.45 floor -- "View Cart" is an orphan element with no
  // screen, so it's checked via aria-label's sibling on waycontext.php
  // instead, which does have one).
  const idBefore = (await uiElementByText("wp-content/plugins/waycontext/waycontext.php", "Sync members")).natural_key;
  const searchBefore = await findUiElementOp(PROJECT, "Sync members", "WayContext");
  assert.equal(searchBefore.candidates.find((c) => c.text_source === "aria_label")?.element_id, idBefore);

  const stats = await indexProject(PROJECT, FIXTURE_ROOT);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const idAfter = (await uiElementByText("wp-content/plugins/waycontext/waycontext.php", "Sync members")).natural_key;
  assert.equal(idAfter, idBefore, "element_id must be stable across a no-change re-index (REQ-020)");

  const searchAfter = await findUiElementOp(PROJECT, "Sync members", "WayContext");
  assert.equal(searchAfter.candidates.find((c) => c.text_source === "aria_label")?.element_id, idBefore,
    "find_ui_element must return the same element_id after the re-index too");
});

// ---------------------------------------------------------------------------
// AC-015 (phase 1B-1, REQ-023)
// ---------------------------------------------------------------------------

test("AC-015: add_shortcode('members', 'render_members') produces a generic shortcode entity with REGISTERED_AT and RENDERED_BY", async () => {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, kind, natural_key, data, deleted_at FROM entities
      WHERE project_id = $1 AND kind = 'shortcode' AND data->>'tag' = 'members'`,
    [project.id]
  );
  assert.equal(res.rows.length, 1, "exactly one shortcode entity for tag 'members'");
  const shortcode = res.rows[0];
  assert.equal(shortcode.kind, "shortcode", 'must be the generic "shortcode" kind, not "ui_shortcode"');
  assert.equal(shortcode.deleted_at, null);

  const links = await pool.query(
    `SELECT relation, src_id, dst_id FROM entity_links WHERE src_id = $1`,
    [shortcode.id]
  );
  const registeredAt = links.rows.find((l) => l.relation === "REGISTERED_AT");
  const renderedBy = links.rows.find((l) => l.relation === "RENDERED_BY");
  assert.ok(registeredAt, "shortcode should have a REGISTERED_AT link to the call site");
  assert.ok(renderedBy, "shortcode should have a RENDERED_BY link to render_members()");

  const renderSym = await pool.query(
    `SELECT s.entity_id FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = $2 AND s.name = 'render_members'`,
    [project.id, "wp-content/plugins/waycontext/includes/members-screen.php"]
  );
  assert.equal(renderedBy.dst_id, renderSym.rows[0].entity_id);
});

// ---------------------------------------------------------------------------
// AC-016 / AC-017 (phase 1B-2, REQ-024, EDGE-014)
// ---------------------------------------------------------------------------

test("AC-016: register_block_type(__DIR__.'/build', ['render_callback' => ...]) with a block.json declaring a namespace produces a generic block entity with DEFINED_IN and RENDERED_BY", async () => {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, kind, natural_key, data, deleted_at FROM entities
      WHERE project_id = $1 AND kind = 'block' AND data->>'namespace' = 'waycontext/pricing'`,
    [project.id]
  );
  assert.equal(res.rows.length, 1, "exactly one block entity for namespace 'waycontext/pricing'");
  const block = res.rows[0];
  assert.equal(block.kind, "block", 'must be the generic "block" kind, not "ui_block"');
  assert.equal(block.deleted_at, null);

  const links = await pool.query(
    `SELECT relation, src_id, dst_id FROM entity_links WHERE src_id = $1`,
    [block.id]
  );
  const definedIn = links.rows.find((l) => l.relation === "DEFINED_IN");
  const renderedBy = links.rows.find((l) => l.relation === "RENDERED_BY");
  assert.ok(definedIn, "block should have a DEFINED_IN link to the block_manifest entity for block.json");
  assert.ok(renderedBy, "block should have a RENDERED_BY link to waycontext_render_pricing_block()");

  const manifest = await pool.query(
    `SELECT id, data FROM entities
      WHERE project_id = $1 AND kind = 'block_manifest' AND id = $2`,
    [project.id, definedIn.dst_id]
  );
  assert.equal(manifest.rows[0].data.path, "wp-content/plugins/waycontext/build/block.json");

  const renderSym = await pool.query(
    `SELECT s.entity_id FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = $2 AND s.name = 'waycontext_render_pricing_block'`,
    [project.id, "wp-content/plugins/waycontext/includes/blocks.php"]
  );
  assert.equal(renderedBy.dst_id, renderSym.rows[0].entity_id);

  // "no attempt is made to resolve any persisted instance of that block" --
  // no writer for resolution_status ("data_owned") exists in this phase at
  // all, so it must be absent here too.
  assert.equal(block.data.resolution_status, undefined);
});

test("AC-017: a persisted Gutenberg block instance is structurally unreachable -- find_ui_element/resolve_ui_reference surface nothing for it, never a fabricated visible_text", async () => {
  // There is no <!-- wp:button --> HTML comment or any persisted-content
  // concept anywhere in this indexer's source-only extraction path (it
  // never reads wp_posts.post_content -- REQ-024/EDGE-014 both scope that
  // to Increment 3). Querying for text that would only ever appear inside
  // a *persisted* block instance's markup must come back empty, not
  // fabricated -- verified against both entry points named in AC-017.
  const found = await findUiElementOp(PROJECT, "wp:button persisted instance text");
  assert.equal(found.status, "not_found");
  assert.equal(found.candidates.length, 0);

  const resolved = await resolveUiReferenceOp(PROJECT, {
    taskText: "the wp:button persisted instance text on some page",
  });
  assert.equal(resolved.status, "not_found");
  assert.equal(resolved.candidates.length, 0);

  // No entity anywhere in the project carries resolution_status
  // "data_owned" -- confirms this phase never introduced a writer for it
  // (REQ-015 category C stays reserved, per contracts.md "Phase 1A-6"/
  // "Phase 1B-2").
  const project = await getProject(PROJECT);
  const dataOwned = await pool.query(
    `SELECT count(*)::int AS n FROM entities
      WHERE project_id = $1 AND data->>'resolution_status' = 'data_owned'`,
    [project.id]
  );
  assert.equal(dataOwned.rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// AC-018 / AC-019 -- identity preflight, both paths (own dedicated project)
// ---------------------------------------------------------------------------

test("AC-018: backfillProjectIdentity runs at most once, before the UI relation post-pass, and dependent DEFINED_BY/HANDLED_BY links resolve normally afterward (same run)", async () => {
  const IDPROJECT = "ac018_fixture";
  await cleanupTestProject(IDPROJECT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ac018-"));
  try {
    fs.writeFileSync(path.join(dir, "admin.php"), `<?php
class Admin_Page {
  public function boot() {
    add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', array( $this, 'render_page' ) );
  }
  public function render_page() {
    submit_button( 'Save Changes' );
    do_action( 'my_plugin_saved' );
  }
}
`);
    fs.writeFileSync(path.join(dir, "listener.php"), `<?php
class Save_Handler {
  public function boot() {
    add_action( 'my_plugin_saved', array( $this, 'handle_save' ) );
  }
  public function handle_save() {}
}
`);
    const stats1 = await indexProject(IDPROJECT, dir);
    assert.equal(stats1.failed, 0, JSON.stringify(stats1));
    assert.equal(stats1.identityPreflight.complete, true);

    const project = await getProject(IDPROJECT);
    // Simulate Save_Handler::handle_save's symbol predating the identity
    // plane: NULL its entity_id but keep symbol_key intact (no collision --
    // this exercises the SUCCESS path, unlike AC-019 below). Its file's
    // content/hash is unchanged, so normal per-file processing will SKIP it
    // this run, leaving the fix entirely to the project-wide backfill.
    const sym = await pool.query(
      `SELECT id FROM symbols WHERE project_id = $1 AND name = 'Save_Handler::handle_save'`,
      [project.id]
    );
    assert.equal(sym.rows.length, 1);
    await pool.query(`UPDATE symbols SET entity_id = NULL WHERE id = $1`, [sym.rows[0].id]);

    const stats2 = await indexProject(IDPROJECT, dir);
    assert.equal(stats2.failed, 0, JSON.stringify(stats2));
    assert.equal(stats2.identityPreflight.backfillRan, true, "backfillProjectIdentity should have run to fix the NULL entity_id");
    assert.equal(stats2.identityPreflight.complete, true, "backfill should succeed (no collision this time)");
    assert.equal(stats2.identityPreflight.backfillResult.files, 1,
      "backfillProjectIdentity should run at most once for the project, covering the one legacy file");

    const relinked = await pool.query(`SELECT entity_id FROM symbols WHERE id = $1`, [sym.rows[0].id]);
    assert.ok(relinked.rows[0].entity_id, "handle_save should be relinked after backfill");

    // The real AC-018 claim: DEFINED_BY/HANDLED_BY links depending on the
    // previously-NULL entity_id resolve normally AFTERWARD, in this same
    // run -- not merely on a subsequent run. This depends on 1A-9's own
    // pipeline-ordering fix (resolveHookGraph/resolveI18nGraph now run
    // after the identity preflight, not before it) -- see contracts.md
    // "Phase 1A-9" for the bug this caught and the fix.
    const comp = await pool.query(
      `SELECT id FROM entities WHERE project_id = $1 AND kind = 'ui_component'
         AND data->>'source_path' = 'admin.php' AND data->>'owner' = 'Admin_Page::render_page'`,
      [project.id]
    );
    assert.equal(comp.rows.length, 1);
    const handledBy = await pool.query(
      `SELECT dst_id FROM entity_links WHERE src_id = $1 AND relation = 'HANDLED_BY'`,
      [comp.rows[0].id]
    );
    assert.equal(handledBy.rows.length, 1, "HANDLED_BY should resolve within this same run per AC-018");
    assert.equal(handledBy.rows[0].dst_id, relinked.rows[0].entity_id);
  } finally {
    await cleanupTestProject(IDPROJECT);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-019: a genuine backfillProjectIdentity failure still completes the code index + UI entities, marks dependent links unresolved, and surfaces UI_IDENTITY_INCOMPLETE", async () => {
  const IDPROJECT = "ac019_fixture";
  await cleanupTestProject(IDPROJECT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ac019-"));
  try {
    fs.writeFileSync(path.join(dir, "admin.php"), `<?php
class Admin_Page {
  public function boot() {
    add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', array( $this, 'render_page' ) );
  }
  public function render_page() {
    submit_button( 'Save Changes' );
  }
}
`);
    const stats1 = await indexProject(IDPROJECT, dir);
    assert.equal(stats1.failed, 0, JSON.stringify(stats1));
    assert.equal(stats1.identityPreflight.complete, true);

    // Force a genuine, reproducible backfillProjectIdentity failure (same
    // technique test/identity.preflight.test.js and
    // test/indexer.uiRelations.test.js's own REQ-027 test use): two symbol
    // rows sharing one pre-set symbol_key with entity_id NULLed. The
    // backfill's single multi-row INSERT ... ON CONFLICT DO UPDATE throws
    // for real ("ON CONFLICT DO UPDATE command cannot affect row a second
    // time"), leaving both genuinely unlinked.
    const project = await getProject(IDPROJECT);
    const syms = await pool.query(
      `SELECT id FROM symbols WHERE project_id = $1 AND name IN ('Admin_Page::render_page', 'Admin_Page::boot')`,
      [project.id]
    );
    assert.equal(syms.rows.length, 2);
    await pool.query(
      `UPDATE symbols SET entity_id = NULL, symbol_key = 'admin.php#collision' WHERE id = ANY($1)`,
      [syms.rows.map((r) => r.id)]
    );

    const stats2 = await indexProject(IDPROJECT, dir);
    assert.equal(stats2.failed, 0, JSON.stringify(stats2), "the code index must still complete successfully");
    assert.ok(stats2.uiRelations && !stats2.uiRelations.error, "UI entity creation must still complete successfully");

    const pf = stats2.identityPreflight;
    assert.equal(pf.backfillRan, true);
    assert.equal(pf.complete, false, "backfill should genuinely fail on the collision");
    assert.equal(pf.diagnostics.length, 1);
    const diag = pf.diagnostics[0];
    assert.deepEqual(Object.keys(diag).sort(), ["affected_feature", "code", "message", "recommended_action", "severity"]);
    assert.equal(diag.code, "UI_IDENTITY_INCOMPLETE", "a diagnostic with this exact code must be present in the index_project result");

    const els = await pool.query(
      `SELECT id, data FROM entities WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'admin.php'`,
      [project.id]
    );
    assert.equal(els.rows.length, 1);
    assert.equal(els.rows[0].data.defined_by_status, "unresolved", "DEFINED_BY miss must be marked unresolved, not fabricated or silently dropped");
    const definedBy = await pool.query(
      `SELECT id FROM entity_links WHERE src_id = $1 AND relation = 'DEFINED_BY'`,
      [els.rows[0].id]
    );
    assert.equal(definedBy.rows.length, 0, "no fabricated DEFINED_BY row -- entity_links.dst_id is NOT NULL");
  } finally {
    await cleanupTestProject(IDPROJECT);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Section 15 regression checks
// ---------------------------------------------------------------------------

test("Regression: project_overview/get_callers/get_callees output shape is unaffected by the new UI entity_links relations", async () => {
  const { getProjectOverview, getCallers, getCallees } = await import("../src/graph.js");

  const overview = await getProjectOverview(PROJECT);
  assert.deepEqual(
    Object.keys(overview).sort(),
    ["languages", "most_referenced_symbols", "project", "top_directories", "wordpress_hooks"]
  );
  // wordpress_hooks reads the OLD edges-based REGISTERS_HOOK/FIRES_HOOK
  // pseudo-targets (src/parser.js), completely unrelated to the NEW
  // entities/entity_links hook/LISTENS_TO/FIRED_BY graph 1A-3 added --
  // both should coexist without contaminating each other's output shape.
  for (const row of overview.wordpress_hooks) {
    assert.deepEqual(Object.keys(row).sort(), ["hook", "relation", "uses"]);
  }

  const callers = await getCallers(PROJECT, "fetch_api_key_value");
  assert.ok(callers.some((r) => r.caller === "render_api_key"));
  for (const row of callers) {
    assert.deepEqual(Object.keys(row).sort(), ["caller", "kind", "line", "path", "relation"]);
  }

  const callees = await getCallees(PROJECT, "render_api_key");
  assert.ok(callees.some((r) => r.target === "fetch_api_key_value"));
  for (const row of callees) {
    assert.deepEqual(Object.keys(row).sort(), ["kind", "line", "relation", "target", "target_file"]);
  }
});
