# Phase 1A-4 plan — WordPress gettext i18n resolution

## Spec / contracts recap

REQ-003/REQ-004/EDGE-004/EDGE-005. Depends on 1A-1 (`ui_element.data.i18n_key`,
`data.text`/`text_source` per REQ-011 precedence — contracts.md "Fixed by the
spec") and 1A-2 (`submit_button()` reuses the same `i18n_key`/`text_source`
convention). Nothing referenced by my slice is missing from contracts.md.

## Gap found in Locate (not a blocker, but shapes the design)

1A-1's `data.i18n_key` on `ui_element` only records the i18n wrapper call's
**first argument (msgid)** — `src/ui/phpElements.js` `reconstructEchoProbe()`
never looks at the second argument (WP's `$domain`). So I cannot resolve a
catalog lookup from `ui_element.data` alone; I need my own lightweight walk
to recover `$domain` (and `$msgctxt` for `_x`/`_ex`) at each call site. This
is a much cheaper walk than 1A-1's echo-concatenation reconstruction (no
placeholder/dynamic-text logic, just "is this call's msgid/domain/context a
literal string") — it does not reproduce the "re-parsing the echo statement"
contracts.md said to avoid; it recovers a fact 1A-1 never captured at all.

## Files

1. `package.json` / `package-lock.json` — add `gettext-parser` (already
   installed via `npm install gettext-parser --save`; no existing .po/.mo
   parser dependency was found in this repo).
2. `src/ui/i18nCatalog.js` (NEW) — pure, DB-free, no module-level mutable
   state (concurrency requirement): `discoverCatalogs(root)` walks
   `**/languages/*.po`/`*.mo` under the project root (excluding
   node_modules/vendor/.git/dist/build, mirroring `indexer.js`'s
   `DEFAULT_IGNORES`), parses with `gettext-parser`, groups by textdomain
   inferred from `<textdomain>-<locale>.po` filename convention. Also
   `resolveKey()` / `resolveKeyAnyDomain()` / `pickPrimaryLocale()`.
3. `src/ui/phpI18nCalls.js` (NEW) — fourth sibling PHP extractor (same
   pattern as `phpHooks.js`): walks every `function_call_expression` whose
   function name is one of the 8 recognized WP i18n wrappers, extracting
   `{ wrapper, msgid, msgctxt, domain, owner, line }` regardless of whether
   the call sits inside an echo/literal-HTML context or is fully standalone
   (e.g. `$x = __('Save', 'td');`). `msgid` literal-only (skip entirely if
   not a literal, same no-fabrication rule as `phpHooks.js`'s hook names).
   `domain` uses WP's own documented default `'default'` when the arg is
   omitted (same reasoning 1A-2 already used for `submit_button()`'s
   omitted args); left `null` when the arg is present but not a literal
   (unresolvable, never defaulted).
4. `src/indexer.js`:
   - import the two new modules.
   - in the per-file PHP branch: call `extractPhpI18nCalls`, write via new
     `writeUiI18nCallSites()` (tombstone-then-upsert `kind='i18n_call_site'`,
     same lifecycle pattern as `writeUiHookSites`).
   - add `'i18n_call_site'` to `dropFile()`'s tombstone `IN (...)` list
     (mirrors `hook_site`; `i18n_key` itself is NOT in that list, same as
     `hook` isn't — its tombstoning is driven by "no live call site
     references it", computed in the project-wide pass).
   - after `resolveHookGraph()`, call new `resolveI18nGraph(project, root, log)`
     — same call position/gating/try-catch style as `resolveHookGraph`.
5. New function `resolveI18nGraph()` in `src/indexer.js`:
   - `discoverCatalogs(root)` fresh every call (no caching) — satisfies the
     concurrency note: two `index_project` runs for two different projects
     each build their own catalog object from their own `root`, no shared
     state.
   - loads all live `i18n_call_site` rows for the project, groups distinct
     `(domain, msgctxt, msgid)` triples, resolves each against the catalogs.
   - upserts `i18n_key` entities (`kind='i18n_key'`, generic per REQ-025),
     tombstones ones no live call site references anymore (same "hook"
     precedent).
   - `TRANSLATION_OF`: src = `ui_element` entity whose `data.i18n_key` value
     equals the call site's `msgid` **and** whose `data.text` exactly equals
     that same string (see "Text-update heuristic" below) — dst = the
     matching `i18n_key` entity.
   - `TRANSLATION_USED_AT`: src = `i18n_key` entity, dst = the usage-site
     `symbol` entity (in-file `owner` name -> `symbols.name`, Q-003-bounded,
     same discipline as every other in-file resolution in this codebase).
   - updates the matched `ui_element`'s `data.text`/`data.text_source` per
     REQ-011 precedence (translated catalog value outranks literal child
     text) — see heuristic below.
   - recomputed in full every run (delete + reinsert), same tradeoff 1A-3
     already made and documented for `resolveHookGraph()`.

## Text-update heuristic (judgment call, documented)

1A-1/1A-2 already put the **raw msgid** into `ui_element.data.text` when the
whole literal fragment/argument was the i18n wrapper's first argument
(`text_source: "child_text"`, `text === i18n_key`). This phase only
overwrites `text`/`text_source` when `data.text === data.i18n_key` exactly
(the "pure i18n" case — the dominant real-world idiom, and `submit_button()`
always falls in this bucket per 1A-2's own note that `textRes.value` and
`textRes.i18nKey` come from the same resolved argument). When the literal
fragment mixes real literal text with an i18n call
(`'Save ' . __('now','td') . '!'` -> `text: "Save now!"`, `i18n_key: "now"`),
`text !== i18n_key` and this phase deliberately leaves 1A-1's reconstruction
untouched rather than attempting substring splicing on an already-approximate
probe string — documented as a known limitation, not silently guessed.

- Catalog hit (`resolved_text` non-null): `text = resolved_text`,
  `text_source = "translated_catalog_value"`.
- Catalog miss (EDGE-004: key exists in source, no catalog entry, or domain
  itself couldn't be resolved and no unique cross-domain match exists):
  `text = null`, `text_source = "translation_key"` — matches EDGE-004's
  wording exactly.

## Tests

Follow the existing pattern: `test/ui.phpI18nCalls.test.js` (pure extractor
unit tests, no DB), `test/ui.i18nCatalog.test.js` (pure catalog
parse/resolve unit tests, no DB, using tmp `.po` fixtures), and
`test/indexer.uiI18n.test.js` (end-to-end `indexProject()` against a tmp PHP
+ `.po` fixture tree, DB-backed, mirroring `test/indexer.uiHooks.test.js`).

## Risk re-check (Gate)

Upfront score: 0/0/1/0/1/0 (Concurrency=1, New infra=1). After Locate:
- New infra (gettext-parser): confirmed no existing .po/.mo dependency;
  `gettext-parser` is well-maintained (v9.1.1, 3 transitive deps, no
  network/native-binary requirements) — in line with the upfront score, not
  higher.
- Concurrency: confirmed `pg_advisory_lock(project.id)` already serializes
  same-project runs (1A-3 established this reasoning); my catalog loader
  adds no module-level mutable state, so cross-project concurrency is also
  safe. Not higher than scored.
- No new dimension came in higher than the upfront read (the missing-domain
  gap above is a design detail, not a risk-dimension change — it doesn't
  touch reversibility/security/blast-radius/ambiguity beyond what was
  already anticipated by "generic i18n_key entity" and "no cross-language
  bridging" being spelled out in the spec slice itself).

No escalation. Proceeding to Code.
