STATUS: DONE

## What was verified

- `npm test` (full suite, `node --test test/*.test.js`): **691/691 pass**,
  0 failures. This includes the 668 pre-existing tests (1A-1/1A-2/1A-3 and
  everything else in the repo) unchanged, plus 23 new tests added by this
  phase:
  - `test/ui.phpI18nCalls.test.js` (8 tests) — pure extractor unit tests:
    msgid/domain/msgctxt extraction, omitted-domain WP default, dynamic
    (non-literal) domain left null, non-literal msgid skipped entirely,
    owner tracking, recognized regardless of echo/standalone context, all
    8 wrapper functions recognized.
  - `test/ui.i18nCatalog.test.js` (10 tests) — pure catalog discovery/parse/
    resolve unit tests against real tmp `.po` fixtures (via `gettext-parser`):
    discovery + textdomain/locale inference from filename, resolved
    translation lookup, EDGE-004's empty-but-non-null vs. domain-not-found-
    at-all null distinction, multi-locale `translations` map (EDGE-005),
    `pickPrimaryLocale`'s tiebreak, `resolveKeyAnyDomain`'s unique-match-only
    discipline (including the ambiguous-refuses-to-guess case), `.po`
    preference over `.mo`, unparseable-filename warning path.
  - `test/indexer.uiI18n.test.js` (5 tests) — end-to-end `indexProject()`
    against a tmp PHP + `.po` fixture tree: catalog-resolved key upgrades a
    `ui_element`'s `text`/`text_source` and links `TRANSLATION_OF`;
    EDGE-004's exact non-error shape (`text: null`,
    `text_source: "translation_key"`); a standalone i18n call (no consuming
    `ui_element`) still gets an `i18n_key` + `TRANSLATION_USED_AT`;
    storage-plane check (`symbols`/`edges` untouched); tombstone-on-removal
    and un-tombstone-on-re-add.
- `node --check` on every new/modified source file
  (`src/indexer.js`, `src/config.js`, `src/ui/i18nCatalog.js`,
  `src/ui/phpI18nCalls.js`) — all syntactically valid.
- Manual byte-level scan of `src/indexer.js` for stray control characters
  after an Edit-tool mishap introduced two literal NUL/SOH bytes mid-edit
  (caught because `grep`/`file` started reporting the file as binary);
  fixed and re-verified clean (`file` reports "Unicode text, UTF-8 text",
  zero control bytes below 0x09 outside `\n`/`\r`).

## What wasn't verified

- No real-world WordPress plugin/theme catalog tree was tested against —
  only the synthetic fixtures in this phase's own tests. 1A-9's hardening
  phase (which the manifest already flags as needing a WordPress fixture
  project) is the natural place to validate the `<textdomain>-<locale>`
  filename heuristic and `.po`/`.mo` precedence against a real plugin's
  `languages/` directory.
- `.mo` (binary) parsing was exercised only through `gettext-parser`'s own
  library correctness (not independently re-verified against a hand-built
  `.mo` fixture in this phase's tests) — building a binary `.mo` fixture by
  hand was judged out of scope; the `.po`-precedence test documents this
  gap explicitly rather than skipping it silently.
- No performance/scale test against a project with hundreds or thousands of
  i18n call sites — `resolveI18nGraph()` follows `resolveHookGraph()`'s
  already-accepted "recompute in full every run" tradeoff, not benchmarked
  here either (contracts.md "Phase 1A-3" already flagged this as unmeasured
  for hooks; the same caveat now applies to i18n).

## Risk re-check (Gate)

Upfront: 0/0/1/0/1/0 (Concurrency=1, New infra=1), total 2, no checkpoint.
Re-scored after Locate/Plan against the real codebase:
- New infra (gettext-parser): confirmed no pre-existing `.po`/`.mo`
  dependency; added a small, actively maintained library (3 transitive
  deps, no native bindings). Not higher than scored.
- Concurrency: confirmed the existing `pg_advisory_lock(project.id)`
  already serializes same-project `index_project` runs (1A-3's precedent);
  the new catalog loader (`src/ui/i18nCatalog.js`) holds no module-level
  mutable state, so cross-project concurrency needed no new primitive
  either. Not higher than scored.
- No other dimension moved. The one real design gap found in Locate — 1A-1
  never captured the i18n wrapper's `$domain` argument — was a scope/design
  detail requiring a new lightweight extractor, not a risk-dimension
  change; it's fully documented in contracts.md and did not require
  escalation.

No escalation was triggered. Proceeded through Code/Review normally.

## Files changed

- `package.json`, `package-lock.json` — added `gettext-parser` (^9.1.1).
- `src/config.js` — added `config.uiI18nLocale` (env `UI_I18N_LOCALE`).
- `src/indexer.js` — imports for the two new modules; per-file PHP branch
  now also extracts+writes `i18n_call_site` staging rows
  (`writeUiI18nCallSites`); `dropFile()`'s tombstone list now includes
  `i18n_call_site`; new project-wide `resolveI18nGraph()` called after
  `resolveHookGraph()`; `i18n` added to `indexProject()`'s returned stats.
- `src/ui/i18nCatalog.js` (NEW) — catalog discovery/parse/resolve.
- `src/ui/phpI18nCalls.js` (NEW) — fourth sibling PHP i18n-call extractor.
- `test/ui.phpI18nCalls.test.js` (NEW)
- `test/ui.i18nCatalog.test.js` (NEW)
- `test/indexer.uiI18n.test.js` (NEW)
- `docs/specs/ui-intelligence/contracts.md` — appended "Phase 1A-4" section.
- `docs/specs/ui-intelligence/manifest.md` — phase 1A-4 row `Status`:
  `pending` → `done`.
- `docs/specs/ui-intelligence/context/phase-1A-4/plan.md` (NEW)
- `docs/specs/ui-intelligence/context/phase-1A-4/review.md` (NEW, this file)

Note: `git status` shows the entire `src/ui/` directory and
`docs/specs/ui-intelligence/` as untracked (not just this phase's new
files) — 1A-1/1A-2/1A-3's work appears to be sitting uncommitted in the
working tree already, from before this phase started. Not something this
phase's implementer changed or should change unilaterally; flagged here in
case the orchestrator expects a commit at this checkpoint.
