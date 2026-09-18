STATUS: DONE

## What was verified

- Full test suite: **779 passing (765 pre-existing + 14 new), 0 failures**,
  run via `npm test` (`node --test test/*.test.js`), real Postgres DB, no
  mocking, consistent with every prior phase's convention.
  - `test/ui.phpShortcodes.test.js` (7 tests): pure `extractPhpShortcodes()`
    unit tests — literal tag + string callback; `array($this,'method')`;
    `array(__CLASS__,'method')`/`array('LiteralClass','method')`; dynamic
    tag skipped entirely (REQ-026); unresolvable callback recorded `null`,
    never fabricated; owner tracking (`"@file"` sentinel for top-level);
    `do_shortcode()` NOT recognized (REQ-023 names no firing side).
  - `test/indexer.uiShortcodes.test.js` (6 tests): real-DB end-to-end —
    AC-015's own worked example produces a `shortcode` entity + both
    relations; orphan callback (unindexed) gets no `RENDERED_BY`, never a
    placeholder; a cross-file callback resolves `REGISTERED_AT` but NOT
    `RENDERED_BY` (proves the same-file-only design decision, see below);
    storage-plane isolation (`symbols`/`edges` untouched); tombstone/restore
    lifecycle; `config.uiEnabled = false` full skip.
  - `test/uiIntelligence.acceptance.test.js` (+1 test, AC-015 against the
    shared `wp_ui_fixture` project): confirms `kind = "shortcode"` (not
    `"ui_shortcode"`), `REGISTERED_AT`/`RENDERED_BY` both present,
    `RENDERED_BY` points at `render_members()`'s own symbol entity.
- Storage plane: confirmed by test (`symbols`/`edges` row counts) and by
  `git status` — `src/parser.js` was not touched at all (its own existing
  `add_shortcode`/`REGISTERS_HOOK` pseudo-edge handling, 1A-3's own
  documented "supersede vs. additive" precedent, is completely untouched;
  the new `shortcode`/`REGISTERED_AT`/`RENDERED_BY` graph lives entirely in
  `entities`/`entity_links`, kind `shortcode`/`shortcode_site` and relations
  `REGISTERED_AT`/`RENDERED_BY`). `src/operations.js`/`src/completion.js`
  were not touched (no new MCP operation — out of scope for this phase per
  the brief).
- Concurrency: no new primitive. `resolveShortcodeGraph()` runs inside the
  same per-project `pg_advisory_lock(project.id)` every other project-wide
  post-pass in `runIndex()` already relies on (confirmed by reading
  `indexProject()` directly, not assumed).
- Pipeline order: `resolveShortcodeGraph()` is called after the identity
  preflight (right after `resolveI18nGraph()`, before `resolveUiRelations()`)
  — deliberately avoiding 1A-9's own Bug #1 (a project-wide post-pass that
  joins `symbols.entity_id` must run after the identity preflight, else a
  same-run identity backfill can't be reflected in that run's own relations).

## What was NOT verified / left for a later phase

- No load/scale testing against a real large WordPress codebase (same
  documented limitation every prior project-wide post-pass in this feature
  carries — `resolveHookGraph()`/`resolveI18nGraph()`/`resolveUiRelations()`
  all recompute in full on every run, and this phase follows the identical
  tradeoff).
- No MCP-surface exposure was added or checked (`resolve_ui_reference`/
  `find_ui_element`/etc. don't yet know about `shortcode` entities) — this
  was explicitly out of scope per the brief ("No new MCP operations... if a
  `shortcode` entity should be reachable through them, that's out of scope
  for this phase unless REQ-023 explicitly requires it (it doesn't)").
- 1B-3 (hardening) still needs to re-verify AC-015 against the full,
  finished 1B fixture set (alongside 1B-2's block work) — this phase only
  verified it in isolation.

## Design decisions (see contracts.md "Phase 1B-1" for the full reasoning)

1. **`shortcode` entity keying: project-wide by tag, not per callsite** —
   follows `hook`'s precedent (contracts.md "Phase 1A-3"), not the
   per-callsite `ui:<project>:php:<path>:<owner>:<fingerprint>` format every
   `ui_*` kind uses. Reasoning: WordPress allows only one callback per tag
   (a second `add_shortcode()` call for the same tag overwrites the first at
   runtime), so a shortcode tag is one shared concept, not a per-callsite
   fact.
2. **`REGISTERED_AT`/`RENDERED_BY` resolve same-file only, NOT project-wide**
   — deliberately diverges from `hook`'s `LISTENS_TO` (which IS
   project-wide, per EDGE-012's explicit cross-file requirement). Follows
   1A-2's precedent for these exact two relation names instead. Reasoning:
   REQ-023/AC-015 name no cross-file scenario (unlike EDGE-012), and a
   shortcode's registration + render callback are overwhelmingly declared in
   the same file in real WP plugin code. Verified directly by test
   (`indexer.uiShortcodes.test.js`'s cross-file case): a callback defined in
   a different file gets `REGISTERED_AT` (same file as the call) but no
   `RENDERED_BY` — a deliberate, tested boundary, not an oversight.
3. **A staging entity (`shortcode_site`) + project-wide post-pass
   (`resolveShortcodeGraph()`) IS still needed**, even though relation
   resolution is same-file-only, because the *entity's own lifecycle*
   (upsert/tombstone by tag) needs project-wide visibility across files —
   it cannot be done as a pure per-file write the way `ui_screen`/
   `ui_settings_section` are (contracts.md "Phase 1A-2"), since a shared
   tag's liveness can't be scoped to one file's `data->>'source_path'`.
   This is the "hybrid" the orchestrator's brief flagged as the likely
   right call — confirmed here against the real `resolveHookGraph()` SQL
   (mirrors its `FIRED_BY` same-file-join shape, not its `LISTENS_TO`
   project-wide-unique-match shape) rather than assumed.
4. **No `do_shortcode()` recognition** — REQ-023 only names `add_shortcode()`
   (registration); no firing side is named the way REQ-014 named both
   `add_action`/`do_action`. Confirmed by re-reading REQ-023's own text
   directly (spec.md L549-560) — inventing one would be scope creep.

## Gate re-check

No dimension moved to "high" after Locate/Plan — see plan.md "Gate" for the
full re-scoring against all six dimensions. Proceeded to Code without
escalation.
