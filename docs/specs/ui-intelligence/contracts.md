# Contracts — UI Intelligence / UI Graph

Append-only. Each phase appends its own section when it completes — interfaces,
schema/data shapes, naming, and decisions later phases must honor. Do not edit
a prior phase's section; add a new dated note instead if something needs
correcting.

Spec: `tasks/context/ui-intelligence/spec.md`. Manifest: `manifest.md` in this
directory.

## Pending cross-phase decisions

These are left open by the spec (marked NOTE [MISSING] there) and each is
load-bearing for more than one phase. The phase that first hits the decision
should resolve it here, not silently pick something locally.

- ~~**EDGE-006**~~ — RESOLVED by 1A-6: one entity, many `RENDERED_ON` links.
  See "Phase 1A-6" below.
- ~~**EDGE-010**~~ — RESOLVED by 1A-8: stay silent, matching every existing
  line-number-returning operation in this codebase. See "Phase 1A-8" below.
- ~~**`resolution_status` enum**~~ — RESOLVED by 1A-6: five-value closed
  enum, two different storage locations depending on value. See "Phase 1A-6"
  below.
- ~~**WordPress fixture project**~~ — RESOLVED by 1A-9: `test/fixtures/wordpress-ui/`.
  See "Phase 1A-9" below.

## Fixed by the spec (not open — recorded here for quick reference)

- Storage plane: `entities`/`entity_links` only, never `symbols`/`edges`
  (REQ-019). No schema migration (Q-001).
- `entities.kind` values and prefixing: UI-specific kinds keep `ui_` prefix
  (`ui_screen`, `ui_component`, `ui_element`, `ui_text`,
  `ui_settings_section`, `ui_settings_field`); generic engineering concepts
  do not (`hook`, `i18n_key`, `shortcode`, `block`) — REQ-025, Q-018/D-UI-018.
- `element_id` format: `ui:<project_id>:<framework>:<source_path>:<component_identity>:<element_fingerprint>`,
  never a raw `entities.id` (REQ-020).
- Score field name is `match_score`, never `confidence` (REQ-011, Q-006).
  Weights: text 0.40, screen/route 0.30, role/type 0.20, context 0.10. Cap 5
  candidates, floor 0.45.
- `text_source` precedence: resolved rendered text → translated catalog value
  → literal child text → `aria-label` → `title` → `placeholder` → `alt` →
  unresolved translation key (REQ-011, Q-005).
- No fabricated graph targets: an absent relation target (e.g. `FIRED_BY`
  into unindexed WordPress core) stays absent — never a placeholder entity
  (REQ-026, Q-018).
- Identity preflight runs once per `index_project` job, project-level, never
  per file, right after the existing `reconcileIdentity` call
  (`src/indexer.js:455`) and before the UI relation post-pass (REQ-027).
- Ownership-category path heuristic (REQ-013): `wp-admin/`, `wp-includes/`,
  `vendor/` ⇒ framework/core (`not_relevant`); everything else ⇒ application.
- `ui.enabled` config flag, default `true`, additive-only — `ui_elements = 0`
  on a project with no UI artifacts is not a warning/error (REQ-022).
- Every new capability must be declared in `src/operations.js` (single
  registry for MCP + CLI + HTTP) — REQ-012, § 6.2.3.

---

<!-- Phases append below this line, oldest first. -->

## Phase 1A-1 — PHP literal-HTML UI element indexer + a11y/identity attrs (2026-08-27)

STATUS: DONE. Implements REQ-001, REQ-002 for Increment 1A (PHP-emitted literal
HTML only — JSX/TSX is Increment 2, not touched). Resolves EDGE-009.

### How extraction works (for anyone building on top of this)

Two independent tree-sitter parses, not a change to `src/parser.js`:
tree-sitter-php never parses the HTML it emits — literal markup between
`?>`/`<?php` comes back as one opaque `text` node — so `src/ui/phpElements.js`
walks the PHP AST for `text` nodes and `echo_statement`s, and hands each
candidate fragment to a second, independent `tree-sitter-html` parse to pull
out tag/attrs/text. `extractPhpUiElements(source)` is pure and DB-free; the
write path lives in `src/indexer.js` (`writeUiElements`), called inside the
same per-file transaction that already writes `symbols`/`edges` for a `.php`
file, right before `COMMIT`.

### `entities` row shape

- `kind = 'ui_element'`.
- `natural_key` = the `element_id` (REQ-020's fixed format):
  `ui:<project_name>:php:<source_path>:<owner>:<fingerprint>`.
  **`<project_id>` in REQ-020's format string is the project's *name***, not
  `entities.id` and not the numeric `projects.id` — every other MCP-facing
  identifier in this codebase (`search_code(project, ...)` etc.) takes a
  project by name, and `element_id` needs to be self-describing to a caller
  that only has the entity row, not its FK columns. Later phases (1A-6, 1A-8)
  should keep this convention rather than switching to the numeric id.
  `<owner>` is the component/function identity (see below). `<fingerprint>`
  is `sha256(tag|text|role|aria_label|title|placeholder|alt|name|data_testid)`
  truncated to 12 hex chars, content-based (not line-based) so it survives
  unrelated line shifts elsewhere in the file; a `-2`/`-3` suffix disambiguates
  genuinely identical siblings under the same owner.
- `title` = resolved `text`, or the tag name if there is no resolvable text.
- `data` (JSONB), all fields always present:
  ```
  {
    element_id, framework: "php", source_path, owner, line,
    tag, type, role,
    text, text_source,               // one of "child_text" | "aria_label" | "title" | "placeholder" | "alt" | null
    aria_label, title_attr, placeholder, alt, name, data_testid,  // raw REQ-002 attrs, or null
    has_dynamic_text,                // bool, see EDGE-009 below
    i18n_key,                        // string | null, see EDGE-009 below
    extraction                       // "literal_html" | "echo_concat"
  }
  ```
  Note the JSON key is `title_attr`, not `title` — the HTML `title` attribute,
  distinct from the entity row's own `title` column.

### REQ-002: a11y/identity attribute resolution

At index time (this phase) the only tiers available are: literal child text →
`aria-label` → `title` → `placeholder` → `alt` (`role`/`name`/`data-testid`
are stored but are identity signals, not text fallbacks, per REQ-002's
wording). `text`/`text_source` record whichever tier this phase could resolve;
**all raw attribute values are also stored individually** so 1A-7's resolver
can re-run the full contracts.md precedence (which also includes "resolved
rendered text" and "translated catalog value", neither available at index
time) without re-parsing the file.

An explicit `role` attribute always wins for `type`; otherwise `<input>` maps
to `"button"` (submit/button/reset) or `"textbox"`, `<a>` → `"link"`,
`<textarea>` → `"textbox"`, `h1`-`h6` → `"heading"`, everything else falls
back to its own tag name.

**Element filter (a decision this phase made, not spec-mandated):** an
element is only recorded if its tag is one of
`button, a, input, select, textarea, option, label, summary, legend, caption,
h1..h6`, OR it carries at least one REQ-002 identity attribute. A bare
structural tag (`div`, `span`, `li`, ...) with neither is not indexed — REQ-001
asks for "button/heading/etc", not markup structure, and indexing every `div`
would make `ui_element` noise-dominated. 1A-2/1A-6 should not expect
structural wrapper elements to exist in this table.

### EDGE-009 — dynamic label text (resolved)

Scope: a label assembled via PHP string concatenation into an `echo`
(`'<button>' . $x . '</button>'`), bounded by Q-003 (in-file, deterministically
resolvable only — no data-flow beyond the syntactic call site).

**Decision:** walk the `.`-concatenation chain and keep only the literal
fragments:
- string operands pass through verbatim;
- the **first string argument of a recognized WP i18n wrapper call**
  (`__, _e, esc_html__, esc_html_e, esc_attr__, esc_attr_e, _x, _ex`) is also
  treated as a literal fragment — it's a syntactic literal at the call site,
  not a resolved catalog lookup, so it stays inside Q-003's bound. Its value
  is additionally recorded in `data.i18n_key`, so **1A-4 can look it up
  against `.po`/`.mo` directly instead of re-parsing the echo statement**.
- everything else (a bare variable, another function call, a ternary, ...) is
  replaced by a single placeholder character so the surrounding tag structure
  still parses, and sets `data.has_dynamic_text = true`.

If no literal fragment ever forms a recognizable opening tag (e.g.
`echo $fully_dynamic;`), **nothing is emitted at all** — REQ-001 requires a
type/role, and there is no fabricated element with an unknown type. This
mirrors "no fabricated graph targets" (REQ-026) in spirit even though that
rule is about relation targets, not entities.

A dynamic value landing inside an identity attribute (e.g.
`aria-label="' . $x . '"`) is recorded as `null` for that attribute, not as
garbled placeholder text, and still sets `has_dynamic_text`.

**Rationale:** this keeps `text`/`aria_label`/etc. honest (never a fabricated
value, per the spirit of REQ-026) while still recovering the common WP
idiom of `'<button>' . esc_html__('Save', 'td') . '</button>'` in full. 1A-7's
`match_score` text-signal weighting should treat `has_dynamic_text: true` as
a reason to discount confidence in the recorded `text`, since it may be a
partial reconstruction rather than the complete rendered label — this is an
available signal, not a scoring mandate; 1A-7 decides how much to use it.

**Known limitation, documented not fixed:** a PHP double-quoted string
containing backslash-escaped characters is used as its raw source text
(quotes stripped, escape sequences not unescaped). Uncommon in practice (the
dominant WP/PHP idiom is single-quoted PHP strings around double-quoted HTML
attributes, which this phase handles correctly), but worth knowing before
trusting `text` byte-for-byte on an unusual file.

### Lifecycle / staleness

`ui_element` entities are **not** covered by `reconcileIdentity` (that plane
is `kind='symbol'`-specific, matched by `body_fingerprint`). Instead: every
time a `.php` file is (re-)processed, all its previously-recorded
`ui_element` entities (matched by `data->>'source_path'`) are tombstoned
(`deleted_at = now()`) first, then the freshly-extracted set is upserted —
still-present elements un-tombstone via `ON CONFLICT ... deleted_at = NULL`
instead of duplicating; genuinely removed ones stay tombstoned. The same
tombstone runs when a `.php` file is deleted outright. There is no rename
detection for UI elements (unlike symbols) — an element that moves to a
different file or a different owner function is recorded as tombstone-old +
insert-new, not a tracked move. 1A-6/1A-8 should not assume `ui_element`
survives a rename the way a `symbol` entity does.

### Config

`config.uiEnabled` (`src/config.js`), env var `UI_ENABLED`, default `"1"` (on)
— same pattern as `docsEnabled`/`historyEnabled`/`rulesEnabled`. Gates the
entire PHP UI-extraction step; off costs nothing (the extraction call is
skipped, not run-and-discarded). This is the `ui.enabled` flag named in the
spec/manifest — the JS property is camelCase `uiEnabled` per this codebase's
existing convention, not a literal dotted `ui.enabled` key.

### What 1A-2 needs to know

1A-2 (WP UI primitives: `submit_button`, admin menu, Settings API) depends on
this phase. It can either extend `src/ui/phpElements.js`'s extraction (same
per-file hook point in `src/indexer.js`, same `writeUiElements`-style
tombstone/upsert lifecycle) or add a parallel extractor writing the same
`ui_element` shape — either way, reuse `natural_key`'s `ui:<project_name>:php:...`
format and the `owner` sentinel convention (`"@file"` for top-level,
`"fn"`/`"Class::method"` otherwise) so 1A-6's post-pass doesn't need two
owner-identity conventions.

### What 1A-6 needs to know

- Storage plane confirmed: only `entities`/`entity_links` were touched;
  `symbols`/`edges` are untouched by this phase (verified by test).
- `owner` in `data` is a bare function/method name or `"@file"`, not yet a
  `CONTAINS`/`RENDERED_ON` graph edge — 1A-6 is the phase that turns "owner
  function X contains element Y" into an actual `entity_links` relation
  against the corresponding `symbol` entity (join on `entities.kind='symbol'
  AND natural_key`'s embedded name, or resolve `owner` against `symbols.name`
  the same way `edges` resolution already does in `runIndex`).
  `resolveType`/tag filtering happens in `src/ui/phpElements.js`; 1A-6 should
  not re-derive `type` from `tag` itself, just read `data.type`.

## Phase 1A-2 — WP UI primitives: `submit_button`, admin menu, Settings API (2026-08-28)

STATUS: DONE. Implements REQ-016 (`submit_button()`), REQ-017
(`add_menu_page()`/`add_submenu_page()`), REQ-018 (`add_settings_section()`/
`add_settings_field()`/`do_settings_sections()`) for Increment 1A.

### Module boundary (why a new file, not an extension of phpElements.js)

`src/ui/phpWpPrimitives.js` is a **sibling** extractor to 1A-1's
`src/ui/phpElements.js`, not an extension of it — a second, independent
tree-sitter-php walk over the same source, recognizing `function_call_expression`
nodes rather than HTML. It is pure and DB-free, exactly like phpElements.js.

This was a deliberate choice to keep 1A-1's file and its tested export
contract (`extractPhpUiElements(source) -> element[]`) completely untouched:
changing its return shape to also carry screens/settings would have broken
every existing 1A-1 test. `I18N_WRAPPERS` and `stripQuotes` are **duplicated**
in the new file rather than imported from phpElements.js, for the same
isolation reason — a few duplicated lines beats adding new exports to a
frozen, already-reviewed file whose only other consumer would be this one.
If a third PHP UI extractor is ever added, consider factoring these two
constants into a shared `src/ui/phpLiteralHelpers.js` at that point rather
than duplicating a third time.

`extractPhpWpPrimitives(source)` returns
`{ elements, screens, settingsSections, settingsFields }`. `elements` is
`submit_button()`'s REQ-016 output — **shaped identically** to phpElements.js's
`ui_element` records (same fields: `tag, type, role, text, textSource,
ariaLabel, title, placeholder, alt, name, dataTestId, hasDynamicText,
i18nKey, owner, line, extraction`) — `src/indexer.js` concatenates it into
the same array before the single call to `writeUiElements()`, so
`submit_button()` calls get exactly 1A-1's write path, tombstone lifecycle,
and `natural_key` format for free. `extraction: "wp_primitive"` is a new
value alongside 1A-1's `"literal_html"`/`"echo_concat"`.

### `submit_button()` -> `ui_element` (REQ-016)

`tag: "input"`, `type: "button"` (matches 1A-1's `<input type="submit">`
mapping — this is what `submit_button()` renders). `text`/`i18nKey` resolve
the `$text` argument through the same literal/`.`-concat/i18n-wrapper walk
as EDGE-009, reimplemented locally as `resolveLiteralArg()` (see "Module
boundary" above for why it's a separate implementation, not a shared import).
`textSource` is always `"child_text"` when resolved — a `submit_button()`
label plays the same "primary literal visible text" role text_source's
`child_text` tier represents, so no new `text_source` enum value was
introduced for it. `name` resolves the `$name` argument. `aria_label`,
`title_attr`, `placeholder`, `alt`, `data_testid` are populated **only**
when `$other_attributes` (5th positional arg) is a literal
`array('key' => 'literal value', ...)` with the matching recognized key —
never guessed. **Omitted arguments use WP's own documented defaults**
(`$text = 'Save Changes'`, `$name = 'submit'`) rather than being left null —
this is applying a stable, public, compile-time-constant fact about WP
core's own function signature, not fabricating dynamic data; it is not
bound by Q-003 (which is about *this project's* code, not WP core's fixed
API contract). An argument that *is* present but not statically resolvable
(a variable, a non-i18n function call) is never defaulted — `hasDynamicText`
is set instead, same as EDGE-009 elsewhere.

### `ui_screen` (REQ-017) — no prior phase defined this shape

`kind = 'ui_screen'`. `natural_key` = `ui:<project_name>:php:<source_path>:<owner>:<fingerprint>`,
identical format/derivation to 1A-1's `element_id` (owner sentinel
convention reused verbatim; fingerprint = `sha256(registration_fn|slug|page_title|menu_title|parent_slug)`
truncated to 12 hex, `-2`/`-3` disambiguation on collision). `title` =
`page_title || menu_title || slug || "screen"`.

`data` (all fields always present):
```
{
  screen_id,            // = natural_key, self-describing, same convention as element_id
  framework: "php", source_path, owner, line,   // registration callsite
  registration_fn,      // "add_menu_page" | "add_submenu_page"
  menu_title, page_title, menu_slug,             // literal string, or null if unresolved
  parent_slug,           // add_submenu_page's 1st arg; null for add_menu_page or if unresolved
  capability,             // literal string, or null (not required by REQ-017, cheap to keep, useful)
  route,                   // "admin.php?page=<menu_slug>" when menu_slug resolved, else null
  renderer,                 // resolved callback descriptor ("fnName" | "Class::method"), or null
  has_dynamic_args,          // bool: true if any positional arg above wasn't statically resolvable
}
```
`add_menu_page`'s positional args are `($page_title, $menu_title,
$capability, $menu_slug, $callback, $icon_url, $position)`;
`add_submenu_page`'s are `($parent_slug, $page_title, $menu_title,
$capability, $menu_slug, $callback, $position)` — `icon_url`/`position` are
not extracted (styling/ordering, not identity per REQ-017's explicit list).

**REGISTERED_AT**/**RENDERED_BY** are written for `ui_screen` too, even
though REQ-017 doesn't name relations explicitly the way REQ-018 does — this
keeps the graph shape uniform across every entity this phase produces
(`REGISTERED_AT` -> the owner function containing the `add_menu_page`/
`add_submenu_page()` call, `RENDERED_BY` -> the resolved `renderer`
callback), rather than screens being relation-less while settings
sections/fields aren't. 1A-6/1A-8 should expect both relations on
`ui_screen` too.

### `ui_settings_section` / `ui_settings_field` (REQ-018)

`kind = 'ui_settings_section'` / `'ui_settings_field'`. `natural_key` same
format/convention as above; fingerprints are
`sha256(add_settings_section|section_id|page|title)` and
`sha256(add_settings_field|field_id|page|section|title)` respectively
(12 hex, `-2`/`-3` disambiguation). `title` = `title || section_id/field_id
|| "settings_section"/"settings_field"`.

`ui_settings_section.data`:
```
{
  settings_id, framework: "php", source_path, owner, line,   // registration callsite
  registration_fn: "add_settings_section",
  section_id, title, page,     // literal string, or null
  callback,                     // resolved descriptor, or null
  has_dynamic_args,
  rendered_at,                  // { owner, line } | null -- see "do_settings_sections()" below
}
```
`ui_settings_field.data`: same shape, with `field_id`/`section` in place of
`section_id`, plus `label_for` (literal string from `$args['label_for']` if
`$args` is a literal array with that key, else null). `add_settings_field`'s
omitted `$section` defaults to WP's own documented default `"default"`
(same "stable public API default, not fabrication" reasoning as
`submit_button()` above).

**REGISTERED_AT** -> the owner function/method containing the
`add_settings_section()`/`add_settings_field()` call. **RENDERED_BY** -> the
resolved `callback` argument (3rd positional in both functions) — this is
the function WP itself invokes to render the section/field's HTML, which is
already a direct, always-present argument at the registration call site; it
does **not** depend on `do_settings_sections()` at all (see below for why).

Both relations resolve **in-file only** (Q-003's bound, same everywhere
else in this phase): `writeUiWpPrimitives()` queries
`SELECT name, entity_id FROM symbols WHERE file_id = $1 AND entity_id IS
NOT NULL` on the **same client, same transaction** as the write (this
file's own symbols/their entities were already inserted earlier in the same
per-file transaction — confirmed via `src/indexer.js`'s existing structure,
see plan.md "Locate") and matches `owner`/`callback` against `symbols.name`
by exact string equality. This works because `src/parser.js:534` already
stores a PHP method's `symbols.name` as `${className}::${methodName}` —
**the same string shape** `phpWpPrimitives.js`'s owner tracking and
`resolveCallable()` produce, with no translation needed. A callback defined
in a different file (the common WP pattern: settings registered in an
`admin_init` hook in one file, rendered from a page-template callback in
another) or passed in an unresolvable form (a variable object, a Closure, a
dynamic method name) yields no relation — the raw resolved name (or `null`)
stays in `data` regardless, so nothing already known is lost, and 1A-6/1A-7
can complete the cross-file case with project-wide resolution without
re-parsing this file.

**`resolveCallable()` (new, in phpWpPrimitives.js) — Q-003-bounded callable
resolution:**
- `'literal_name'` -> `"literal_name"`
- `array($this, 'method')` -> `"<enclosingClass>::method"` (inside a class
  body only; `$this` outside a class resolves to nothing)
- `array(__CLASS__, 'method')` -> `"<enclosingClass>::method"`
- `array('LiteralClass', 'method')` -> `"LiteralClass::method"`
- anything else (a variable object, `[$obj, 'method']` where `$obj` isn't
  `$this`, a first-class callable `strlen(...)`, a Closure, a dynamic method
  name expression) -> `null`, never fabricated.

This matters in practice: `array($this, 'method')` is the dominant
callback idiom in real-world WP admin-page/settings-API code (OOP plugin
classes), far more common than a bare string callback — without resolving
it, `RENDERED_BY` would almost never fire on real WordPress code.

### `do_settings_sections()` — recognized, produces no entity and no new relation (REQ-018, judgment call)

REQ-018 requires `do_settings_sections()` to be "recognized" but doesn't say
what it produces. Two readings were considered:

1. **RENDERED_BY's target is `do_settings_sections()`'s call site** (i.e.,
   the field/section is "rendered by" wherever `do_settings_sections($page)`
   is called for the matching `$page`).
2. **RENDERED_BY's target is the field/section's own `$callback` argument**
   (i.e., "rendered by" the function WP actually invokes to emit its HTML,
   which `do_settings_sections()` triggers indirectly but doesn't itself
   define).

Reading 2 was chosen: it's the literal, always-available, single-call-site
fact ("the render callback... and its location" — REQ-018's own wording
names a *callback*, and every `add_settings_section`/`add_settings_field()`
call already carries one as a direct argument, no correlation needed). It
also avoids inventing a relation this phase would have to guess the name of
— 1A-6's manifest row already reserves `RENDERS`/`RENDERED_ON` for its own
project-wide post-pass (including resolving EDGE-006, one node vs. several
`RENDERED_ON` links), and this phase writing a same- or similar-named
relation independently risked colliding with a design 1A-6 hasn't made yet.

So `do_settings_sections($page)` calls are recognized (walked, matched by
function name) but produce **no `ui_*` entity of their own** and **no new
relation type**. Their only effect: within the *same file*, if any
`ui_settings_section`/`ui_settings_field` record's `page` matches the
`do_settings_sections()` call's `$page` argument, that record's
`data.rendered_at` is set to `{ owner, line }` — the owner/location of the
`do_settings_sections()` call, i.e., "this section/field is actually
painted on screen when this function runs." This is same-file correlation
only (Q-003 bound); a `do_settings_sections($page)` call with no in-file
section/field matching that `$page` produces nothing at all (silently
dropped — no dangling entity, no fabricated relation, consistent with
REQ-026's spirit even though REQ-026 is nominally about relation targets).

**What 1A-6 needs to know:** `data.rendered_at` (when non-null) is a
ready-made, already-resolved fact — the actual page-render call site, at
least for the in-file case. 1A-6's project-wide post-pass is expected to be
the phase that (a) completes the cross-file case (most real WP plugins
register settings in a different file than the one that renders the page)
and (b) decides what relation type (if any — `RENDERED_ON`? something
settings-specific?) to turn this into, consistent with whatever EDGE-006
resolution it settles on. This phase deliberately does not pre-empt that
choice.

### Config / storage plane

No new config flag — reuses `config.uiEnabled` (`UI_ENABLED`) exactly as
1A-1 gated it; `lang === "php"` gate unchanged. Storage plane confirmed:
only `entities`/`entity_links` touched (verified by test); `symbols`/`edges`
untouched by this phase.

### Lifecycle / staleness

Same tombstone-then-upsert pattern as 1A-1, in a new `writeUiWpPrimitives()`
function: every previously-recorded `ui_screen`/`ui_settings_section`/
`ui_settings_field` entity for a re-processed path is tombstoned first (by
`data->>'source_path'`), then the freshly-extracted set is upserted.
`dropFile()`'s outright-deletion tombstone (`src/indexer.js`) now covers all
four `ui_*` kinds (`ui_element`, `ui_screen`, `ui_settings_section`,
`ui_settings_field`) in one `UPDATE ... WHERE kind IN (...)`. No rename
detection, same as `ui_element`.

### What 1A-4 needs to know

`submit_button()`'s `i18nKey` (when the `$text` argument resolves through a
recognized i18n wrapper) is captured the same way EDGE-009 captures it for
literal HTML — `data.i18n_key` on the `ui_element` row, ready for 1A-4's
`.po`/`.mo` lookup without re-parsing.

### What 1A-6 needs to know (summary)

- `ui_screen`/`ui_settings_section`/`ui_settings_field` all carry `owner`
  (registration callsite, function-level granularity) in `data`, same
  convention as `ui_element` — 1A-6 can resolve any still-unresolved `owner`
  the same way it already plans to for `ui_element`'s `CONTAINS` relations.
- `REGISTERED_AT`/`RENDERED_BY` are already populated in `entity_links` for
  the in-file-resolvable case; 1A-6/1A-7 only need to complete the
  cross-file remainder (a `null` `renderer`/`callback` field, or an `owner`/
  `callback` name that didn't match any in-file symbol) — this phase never
  overwrites or removes what it did resolve, so 1A-6 can treat "relation
  already exists" as "already done, skip."
- `ui_settings_section`/`ui_settings_field.data.rendered_at` is the in-file
  half of the `do_settings_sections()` correlation described above — 1A-6
  owns deciding the relation type and completing it cross-file.
- `ui_screen.data.route` is always `"admin.php?page=<menu_slug>"` when
  `menu_slug` resolved (WordPress's real routing convention for both
  top-level and subordinate pages registered this way) — 1A-6/1A-8 should
  not need to reconstruct this themselves.

## Phase 1A-3 — Hook graph as first-class entities (2026-08-28)

STATUS: DONE. Implements REQ-014, REQ-026 for Increment 1A. Resolves
EDGE-012.

### Why `src/parser.js`/`edges` are read nowhere in this phase (supersede-vs-additive decision)

`src/parser.js:221-233` already recognizes `add_action`/`add_filter`/
`add_shortcode` (writing a `REGISTERS_HOOK` edge, `dst_name = "hook:<name>"`)
and `do_action`/`apply_filters`/`do_shortcode` (writing `FIRES_HOOK` the same
way). `dst` is never resolved for these — no symbol is ever literally named
`hook:<name>` — so today these are pure text pseudo-targets, exactly as
REQ-014 describes.

Two readings of "supersedes" were considered:

1. **Replace/resolve the existing `edges` pseudo-targets in place.**
   Rejected: contracts.md's fixed rule is "storage plane: `entities`/
   `entity_links` only, never `symbols`/`edges`" for UI Intelligence writes,
   and touching `src/parser.js`/the general edge-resolution pass is core
   pipeline surface shared by every consumer of `get_graph`/`get_callers`,
   not scoped to this feature. It would also not even be *correct*: `edges`'
   `REGISTERS_HOOK`/`FIRES_HOOK` conflate hooks with shortcodes (both
   `add_shortcode`/`do_shortcode` feed the same relation names as
   `add_action`/`do_action`) — reading or resolving that table as the hook
   graph's source would create `hook` entities for shortcodes too, which
   belongs to REQ-023/phase 1B-1's distinct `shortcode` kind.
2. **Add the new `hook` entity graph in `entities`/`entity_links`, leave
   `edges`/`src/parser.js` completely untouched.** Chosen. "Supersedes" is
   read as describing *intent for future consumers* — this UI Intelligence
   feature's own resolver/MCP surface (1A-7/1A-8) should read the new
   `hook`/`LISTENS_TO`/`FIRED_BY` graph, not the old `hook:<name>`
   pseudo-targets — not a mandate to delete or rewrite working `edges`
   behavior in this phase. Confirmed by test: the full existing suite (668
   tests, including every 1A-1/1A-2 test) passes unchanged after this
   phase's changes, and `src/parser.js` was not modified at all.

`src/parser.js`'s `WP_REGISTER`/`WP_FIRE` sets and the `REGISTERS_HOOK`/
`FIRES_HOOK` edges they produce are **unaffected and untouched** by this
phase. A caller relying on old behavior for `add_shortcode`/`do_shortcode`
via `edges` sees no change.

### `src/ui/phpHooks.js` — third sibling PHP extractor

A third independent tree-sitter-php walk, sibling to `phpElements.js`/
`phpWpPrimitives.js` (same "pure, DB-free, returns plain records" contract).
Recognizes **only** `add_action`/`add_filter` (registration) and
`do_action`/`apply_filters` (firing) — deliberately **not** the same
function set as `src/parser.js`'s `WP_REGISTER`/`WP_FIRE`, which also
include `add_shortcode`/`do_shortcode` (see above for why that distinction
matters). `stripQuotes`/`resolveCallable`/`positionalArgs` are duplicated a
third time rather than imported from `phpWpPrimitives.js`, extending the
1A-2 module-boundary precedent ("a few duplicated lines beats adding new
exports to a frozen, already-reviewed file").

`extractPhpHooks(source) -> { listens: object[], fires: object[] }`:
- `listens[i]`: `{ hookName, registrationFn, callback, owner, line }`.
  `hookName` resolved from a literal `string`/`encapsed_string` argument
  only — **no partial reconstruction** the way EDGE-009 partially
  reconstructs dynamic *text*: a hook name is an identifier, and a call site
  whose hook-name argument isn't a literal is **skipped entirely** (no
  entity, no relation at all for that call site — REQ-026's spirit).
  `callback` is `resolveCallable()`'s output (`'literal_name'`,
  `array($this,'method')` → `"<enclosingClass>::method"`,
  `array(__CLASS__,'method')`, `array('LiteralClass','method')`), or `null`
  when unresolvable from syntax alone (a Closure, a variable object, a
  dynamic method name, ...) — never fabricated, same rule set as
  `phpWpPrimitives.js`'s `resolveCallable()` verbatim.
- `fires[i]`: `{ hookName, firingFn, owner, line }`. Same literal-only
  `hookName` rule. No callback resolution needed for this direction — the
  "firing symbol" *is* `owner`, the function/method enclosing the
  `do_action`/`apply_filters` call itself, always resolvable in its own
  file.

### `hook` entity — `kind = 'hook'` (generic, no `ui_` prefix, per REQ-025/Q-018/D-UI-018)

**Unlike every other entity this UI Intelligence feature writes, `natural_key`
is keyed by hook *name* alone, project-wide — not per call site.** A hook is
one shared concept referenced by every file that registers or fires it, so
`ui:<project_name>:php:<source_path>:...`-style per-callsite fingerprinting
(REQ-020's `element_id` format, used by every `ui_*` kind) does not apply
here; `element_id`'s format is fixed for `ui_*` kinds specifically, and
`hook` — being explicitly generic/non-`ui_`-prefixed per REQ-025 — was not
bound by it. 1A-6/1A-7/1A-8 should not expect a `hook` entity's
`natural_key` to embed a source path or line.

`natural_key` = `hook:<project_name>:<hook_name>`. `title` = `hook_name`.
`data` (all fields always present):
```
{ hook_id, name, framework: "php" }
```
`hook_id` = `natural_key`, self-describing, same convention as
`element_id`/`screen_id`/`settings_id` elsewhere.

Lifecycle: upserted whenever any live `hook_site` (see below) references its
name; **tombstoned once no live `hook_site` references it anymore** (i.e.
every registration/firing call site for that hook name was removed or
edited away across the whole project). Not tied to any one file's
tombstone-by-`source_path` pass, since a hook's liveness depends on the
*whole project's* current state, not one file's.

### `hook_site` — internal-only staging entity, NOT spec-facing

`kind = 'hook_site'` is **not** one of REQ-025's fixed `entities.kind`
values and is **never returned by any MCP operation**. It exists purely so
`resolveHookGraph()` (below) can see every file's hook call sites without
re-parsing PHP source on every `index_project` run. 1A-6/1A-7/1A-8 should
never read or expose `hook_site` rows directly — treat it as this phase's
private implementation detail, the same way `chunks`/`derived_state` are
private to their own subsystems.

One row per `add_action`/`add_filter`/`do_action`/`apply_filters` call site.
`natural_key` = `hooksite:<project_name>:php:<source_path>:<owner>:<fingerprint>`
(same per-callsite format/fingerprinting convention as `ui_element`/
`ui_screen`/etc — content-hashed, `-2`/`-3` disambiguated). `data`:
```
{
  source_path, owner, line, direction: "listen" | "fire",
  hook_name,
  // direction: "listen" only —
  registration_fn,      // "add_action" | "add_filter"
  callback,              // resolved string, or null
  // direction: "fire" only —
  firing_fn,             // "do_action" | "apply_filters"
}
```
Lifecycle: same tombstone-then-upsert-by-`source_path` pattern as
`ui_element` — every re-processed `.php` file's previously-recorded
`hook_site` rows are tombstoned first, then the fresh set is upserted.
`dropFile()`'s outright-deletion tombstone now covers `hook_site` alongside
the four `ui_*` kinds.

### `LISTENS_TO` / `FIRED_BY` — the actual hook graph (REQ-014)

- `LISTENS_TO`: `src` = the callback's `symbol` entity, `dst` = the `hook`
  entity. "code symbol → hook", per REQ-014's own direction.
- `FIRED_BY`: `src` = the `hook` entity, `dst` = the firing symbol's `symbol`
  entity. "hook → firing symbol", per REQ-014's own direction.

Both are recomputed by `resolveHookGraph(project, log)`
(`src/indexer.js`), a **project-wide post-pass** — called once per
`index_project` job (not per file), positioned right after the existing
`edges` resolution block and before `reconcileIdentity()`. Gated by
`config.uiEnabled`; wrapped in the same try/catch-and-log-skip pattern as
every other additive subsystem in `runIndex()` (docs/history/rules/
derived) — a bug here must not fail the code index.

Resolution rule, **asymmetric by design**:
- `FIRED_BY` is matched **same-file only**: the firing owner (the function/
  method enclosing the `do_action`/`apply_filters` call) is always
  resolvable within that call site's own file — no cross-file join is
  needed for this direction. When nothing matches (`owner` is the `"@file"`
  sentinel, meaning top-level code with no enclosing symbol, or the firer is
  outside the indexed project entirely — WordPress core, an unindexed
  plugin), **no relation is written** — REQ-026/Q-018's no-fabrication rule.
- `LISTENS_TO` is matched **project-wide** by exact `symbols.name` — this is
  EDGE-012's actual requirement (a hook fired by one plugin/theme, handled
  by a callback registered+defined in a different one). Only a **unique**
  symbol-name match is linked, reusing the exact "only unique matches are
  linked" discipline the pre-existing namespace-edge-resolution pass in
  `runIndex()` already applies to `edges` — pointing `LISTENS_TO` at an
  arbitrary one of several same-named methods would be worse than leaving
  it unresolved. **Known limitation:** a bare (unqualified) global PHP
  function name used as a callback is effectively guaranteed unique
  project-wide (PHP forbids two same-named global function declarations
  without namespacing), so this resolves reliably for the classic
  `add_action('init', 'my_plugin_init')` idiom. A **class-qualified**
  callback (`Class::method`, the dominant OOP-plugin idiom, resolved via
  `array($this,'method')` etc.) can collide when two *different* classes
  both declare a same-named method (e.g. two unrelated classes both have a
  `render()` method) — in that case `LISTENS_TO` is left unresolved for
  that call site rather than guessing. Not measured against a real
  large-scale WP codebase's actual collision rate; flagged for 1A-9.

**Recomputed in full on every run** (delete every existing `LISTENS_TO`/
`FIRED_BY` touching this project's `hook` entities, then reinsert from the
current `hook_site` set) rather than diffed incrementally. This is a
deliberate simplicity/cost tradeoff: `hook_site` rows are already correctly
tombstoned per file by the time this runs, so a full recompute is always
consistent with zero extra bookkeeping, at the cost of redoing the whole
project's hook-graph SQL on every `index_project` call (not scoped to just
the files that changed this run). Not benchmarked against a large real-world
WordPress codebase (thousands of hook call sites) — if this becomes a
measured bottleneck, a future phase should watermark-gate it the way
`deriveIntelligence()` gates its own recomputation, rather than this phase
inventing that mechanism preemptively.

### Concurrency

The manifest's Concurrency=1 risk was scored before reading
`indexProject()`: a session-level `pg_advisory_lock(project.id)` already
serializes every `runIndex()` call for a given project (see the comment
above that lock in `src/indexer.js`), so `resolveHookGraph()`'s project-wide
reads/writes run under the same single-writer guarantee every other
project-wide pass (`edges` resolution, `reconcileIdentity`) already relies
on. No new concurrency primitive was introduced or needed.

### Config / storage plane

No new config flag — reuses `config.uiEnabled` exactly as 1A-1/1A-2 gated
it; `lang === "php"` gate unchanged. Storage plane confirmed by test: only
`entities` (`kind IN ('hook','hook_site')`) and `entity_links`
(`relation IN ('LISTENS_TO','FIRED_BY')`) are touched; `symbols`/`edges` are
untouched by this phase (verified by test, and by the full pre-existing
668-test suite passing unchanged).

### What 1A-6 needs to know

- `hook`/`LISTENS_TO`/`FIRED_BY` are **already fully resolved project-wide**
  by the time 1A-6's own post-pass runs (1A-6 depends on 1A-3 per the
  manifest) — 1A-6 should not need to re-resolve or complete anything hook-
  related, only consume `hook` entities/relations as inputs if its own
  ownership-classification or graph-assembly logic wants to reference them
  (e.g. REQ-013's ownership-category-D scenario, which EDGE-012 already
  demonstrates end-to-end at this phase).
- Do not read or write `hook_site` — it is this phase's private
  implementation detail (see above), not part of the spec-facing graph.
- If 1A-6 introduces its own project-wide post-pass step, note that
  `resolveHookGraph()` already established the pattern/position for one
  (called once per `runIndex()`, after edges resolution, gated by
  `config.uiEnabled`, wrapped in try/catch-and-log) — reuse that spot/style
  rather than inventing a second convention.

## Phase 1A-4 — WordPress gettext i18n resolution (2026-08-28)

STATUS: DONE. Implements REQ-003, REQ-004 for Increment 1A. Resolves
EDGE-004, EDGE-005.

### Gap found in 1A-1 that shaped this phase's design

1A-1's `ui_element.data.i18n_key` only ever recorded an i18n wrapper call's
**first argument (msgid)** — `reconstructEchoProbe()` in `phpElements.js`
never looks at the second (`$domain`) argument. This phase therefore cannot
resolve a catalog lookup from `ui_element.data` alone; it adds its own
lightweight, unconditional walk (`src/ui/phpI18nCalls.js`) that reads every
i18n wrapper call's full argument list — `msgid`, `$domain`, and (for
`_x`/`_ex`) `$msgctxt` — regardless of whether the call sits inside an
echo/literal-HTML fragment or is fully standalone (`$x = __('Save','td');`).
This is a much cheaper walk than 1A-1's echo-concatenation reconstruction
(no placeholder/dynamic-text logic, just "is this argument a literal
string") and does not re-parse the echo statement's structure — it recovers
a fact 1A-1 never captured, rather than redoing what 1A-1 already did.

### `src/ui/phpI18nCalls.js` — fourth sibling PHP extractor

Same pattern as `phpHooks.js`: independent tree-sitter-php walk, pure/
DB-free, `stripQuotes`/owner-tracking duplicated rather than imported
(module-boundary precedent from 1A-2/1A-3). `extractPhpI18nCalls(source) ->
{ wrapper, msgid, msgctxt, domain, owner, line }[]`.

- `msgid` literal-only; a non-literal first argument skips the call site
  entirely (no entity, no relation — same no-fabrication rule
  `phpHooks.js` applies to hook names).
- `domain` is `"default"` (WP core's own documented default) when the
  argument is **omitted** — same "stable, public, compile-time-constant
  fact about WP core's own signature" reasoning 1A-2 applied to
  `submit_button()`'s omitted args. When the argument **is present** but
  not a literal (a variable, a constant), `domain` is `null` — unresolvable,
  never defaulted.
- `_x`/`_ex` take `(msgid, msgctxt, domain)`; every other recognized
  wrapper takes `(msgid, domain)`.
- Recognizes a call site wherever it sits — this is what lets it also see
  (and later match back up to) the same call sites 1A-1/1A-2 already staged
  as `ui_element.data.i18n_key`, with no separate correlation pass needed
  beyond the (source_path, owner, msgid) matching `resolveI18nGraph()` does.

### `src/ui/i18nCatalog.js` — catalog discovery/parse/resolve, no module-level state

**New dependency: `gettext-parser` (^9.1.1).** No existing `.po`/`.mo`
parser was found in this repo (checked `package.json` and `node_modules`);
`gettext-parser` was chosen over hand-rolling PO/MO parsing per the phase
brief's own guidance — small (3 transitive deps: `content-type`,
`encoding`, `iconv-lite`), no native bindings, actively maintained, and its
`{ headers, translations: { msgctxt: { msgid: { msgstr } } } }` output
shape is exactly what a msgctxt-aware lookup needs.

**Discovery heuristic (WP convention, documented not exhaustive):**
`discoverCatalogs(root)` globs `**/languages/*.po` and `**/languages/*.mo`
under the project root (excluding node_modules/vendor/.git/dist/build).
A catalog's basename is split on its **last hyphen**:
`<textdomain>-<locale>` (e.g. `my-plugin-de_DE.po` → textdomain
`my-plugin`, locale `de_DE`). `.po` is preferred over `.mo` for the same
(textdomain, locale) pair when both exist (human-authored source of truth);
`.mo` is used only when no `.po` counterpart is present (common in
production-only plugin ships).

**Known limitations, documented not fixed:** a locale code that itself
contains a hyphen (e.g. `zh-Hans`; WP normally uses `zh_CN`/`zh_TW`, so this
is uncommon) is misparsed as part of the textdomain. A catalog filename
with no hyphen at all (no resolvable locale, e.g. a bare `default.po`) is
skipped with a warning, not indexed.

**No module-level mutable state** — `discoverCatalogs(root)` builds and
returns a fresh object on every call, reading from disk each time. This is
the concurrency answer the phase brief asked for: two `index_project` runs
for two *different* projects (which the project-level
`pg_advisory_lock(project.id)` does NOT serialize against each other — only
same-project runs, per "Phase 1A-3" above) each call this with their own
`root` and get their own independent result; nothing is shared or cached
across projects or across runs.

**Resolution functions:**
- `resolveKey(catalogs, domain, msgctxt, msgid, preferredLocale)` — looks
  up one key against one known textdomain's catalogs only. Returns `null`
  only when that textdomain has **no catalogs discovered at all**; returns
  `{ translations: {}, resolvedText: null, ... }` (non-null, empty) when
  catalogs exist for that domain but this specific key isn't in any of
  them — this is EDGE-004's exact shape.
- `resolveKeyAnyDomain(catalogs, msgctxt, msgid, preferredLocale)` — the
  **only** place this phase does cross-domain matching, and only for a call
  site whose own `$domain` couldn't be determined at all (a dynamic
  expression). Searches every discovered textdomain; returns a result only
  when **exactly one** textdomain has this key — "only unique matches are
  linked", the same discipline `resolveHookGraph()`'s `LISTENS_TO`
  resolution already applies project-wide. A call site whose domain IS
  known but simply has no catalog on disk is **never** backfilled from a
  different domain's catalog — that domain's own absence of a catalog is
  the correct, attributable EDGE-004 state, not something another domain's
  translation should paper over.
- `pickPrimaryLocale(availableLocales, preferredLocale)` — deterministic
  tiebreak among the locales a key actually has a translation in: prefer
  `config.uiI18nLocale` (env `UI_I18N_LOCALE`, unset by default) when it has
  this key, else the lexicographically smallest locale code. There is no
  live-visitor-locale concept at static index time, so this is necessarily
  arbitrary — documented, not hidden. The **full per-locale map is always
  kept** on the `i18n_key` entity (`data.translations`) regardless of this
  pick, so a resolver that wants a different locale (e.g. 1A-7 matching a
  Vietnamese task phrase — EDGE-005) always has it.

### `i18n_key` entity — `kind = 'i18n_key'` (generic, no `ui_` prefix, per REQ-025/Q-018/D-UI-018)

**Like `hook`, keyed project-wide by identity, not per call site** — a
translation key is one shared concept referenced by every call site that
uses it. `natural_key = i18n:<project_name>:<textdomain-or-"unknown">:<fingerprint>`,
`fingerprint = sha256(msgctxt|msgid).slice(0,12)` (hashed, unlike `hook`'s
bare name, because a msgid can be long/contain characters unsafe to embed
raw in a key — same reasoning `element_id`/`screen_id`/etc already hash
their own content). `title = msgid`. `textdomain` in the key is the
**resolved** domain (the call site's own literal/defaulted domain, or the
unique cross-domain match, or the literal sentinel string `"unknown"` when
neither could be determined) — this is what a domain-blind (dynamic
`$domain`) call site that happens to share a msgid with a domain-explicit
call site does NOT collide with: they get different `i18n_key` entities
unless resolution actually converges them onto the same domain.

`data` (all fields always present):
```
{
  i18n_key_id,       // = natural_key, self-describing, same convention as element_id/hook_id
  framework: "php",
  textdomain,        // resolved domain string, or "unknown"
  msgid, msgctxt,    // msgctxt is null for every wrapper except _x/_ex
  translations,      // { locale: msgstr } -- EVERY locale a catalog had this key in, not just the primary pick
  resolved_locale,   // pickPrimaryLocale()'s pick among `translations`' keys, or null if none
  resolved_text,     // translations[resolved_locale], or null (EDGE-004: key exists, no catalog entry)
  catalog_source,    // array of catalog file paths that contributed a translation
}
```

Lifecycle: same "hook" precedent — upserted whenever any live
`i18n_call_site` (see below) references its (textdomain, msgctxt, msgid)
triple; tombstoned once no live call site references it anymore (not tied
to any one file's tombstone-by-`source_path` pass, since a key's liveness
depends on the whole project's current state). Recomputed in full every run
(delete + reinsert `TRANSLATION_OF`/`TRANSLATION_USED_AT`), same
cost/simplicity tradeoff `resolveHookGraph()` already made and documented.

### `i18n_call_site` — internal-only staging entity, NOT spec-facing

`kind = 'i18n_call_site'`, same status as `hook_site` — never returned by
any MCP operation, not part of REQ-025's fixed `entities.kind` list. Exists
purely so `resolveI18nGraph()`'s project-wide post-pass can see every
file's i18n call sites (including `$domain`/`$msgctxt`, which
`ui_element.data.i18n_key` never captured) without re-parsing PHP source on
every `index_project` run. 1A-6/1A-7/1A-8 should never read or expose it
directly, same rule as `hook_site`.

One row per recognized i18n wrapper call site. `natural_key =
i18nsite:<project_name>:php:<source_path>:<owner>:<fingerprint>` (same
per-callsite content-hash convention as `hook_site`/`ui_element`). `data`:
`{ source_path, owner, line, wrapper, msgid, msgctxt, domain }`. Same
tombstone-then-upsert-by-`source_path` lifecycle as `ui_element`/
`hook_site`; `dropFile()` now tombstones `i18n_call_site` alongside the
other five UI-adjacent kinds (`i18n_key` itself is deliberately NOT in that
list, same reasoning `hook` isn't — its tombstoning is driven entirely by
"no live call site references it anymore", computed in
`resolveI18nGraph()`, which naturally covers file deletion too since
`dropFile()` already retires the file's `i18n_call_site` rows).

### Relation shapes chosen for REQ-004 ("any of the three can be the query entry point")

Two relations, not one — "visible text" isn't a separate entity (it already
lives on the consuming entity's own `data.text`), so the graph only needs
to connect (a) that consuming entity and (b) the usage-site symbol, each to
the `i18n_key`:

- **`TRANSLATION_OF`**: `src` = the consuming `ui_element` entity, `dst` =
  the `i18n_key` entity. Reads naturally: "this element's text is a
  TRANSLATION_OF this key" — same src-verb-dst naming discipline as
  `LISTENS_TO`/`FIRED_BY`/`REGISTERED_AT`/`RENDERED_BY` elsewhere in this
  feature. Written only when a `ui_element` row's `data.i18n_key` uniquely
  matches exactly one `i18n_key` entity by (source_path, owner, msgid); an
  ambiguous match (two different call-site domains sharing the same
  source_path/owner/msgid) is left unlinked, no fabrication.
- **`TRANSLATION_USED_AT`**: `src` = the `i18n_key` entity, `dst` = the
  usage-site `symbol` entity (the function/method enclosing the call,
  in-file resolution only, Q-003-bounded, same discipline as
  `REGISTERED_AT`/`RENDERED_BY`/`FIRED_BY`). Written for **every** live
  call site, whether or not it's also tied to a `ui_element` — this is what
  makes a key backing a CLI message, an email, or an API error (REQ-004's
  own framing for why `i18n_key` is generic) queryable from its usage site
  even when there's no UI element at all. The `"@file"` owner sentinel (no
  enclosing symbol) is skipped — nothing to link, no fabrication.

Query-entry-point coverage: from **visible text**, query the `ui_element`
(has `data.text` directly, plus its `TRANSLATION_OF` edge). From **i18n_key**,
`entity_links` where `dst_id` = the key (relation `TRANSLATION_OF`) gives
every consuming element; where `src_id` = the key (relation
`TRANSLATION_USED_AT`) gives every usage-site symbol. From **usage site**
(a symbol), `entity_links` where `dst_id` = that symbol and relation =
`TRANSLATION_USED_AT` gives back the key(s) used there.

### Text-update heuristic (judgment call, documented)

1A-1/1A-2 already put the **raw msgid** into `ui_element.data.text` when
the whole literal fragment/argument was the i18n wrapper's first argument
(`text_source: "child_text"`, and in that case `data.text === data.i18n_key`
exactly — true for the dominant real-world idiom
`'<button>' . esc_html__('Save','td') . '</button>'`, and always true for
`submit_button()` per 1A-2's own note that its `textRes.value` and
`textRes.i18nKey` come from the same resolved argument). This phase
**only** overwrites `text`/`text_source` when `data.text === data.i18n_key`
holds exactly. When the literal fragment mixes real literal text with an
i18n call (`'Save ' . __('now','td') . '!'` → `text: "Save now!"`,
`i18n_key: "now"`), `text !== i18n_key` and this phase deliberately leaves
1A-1's reconstruction untouched — it does not attempt substring splicing on
an already-approximate probe string. Documented limitation, not a silent
guess; flagged for whichever later phase wants to improve on it.

- Catalog hit (`resolved_text` non-null): `text = resolved_text`,
  `text_source = "translated_catalog_value"` — this new tier is inserted
  above `"child_text"` in the REQ-011 precedence, exactly as "Fixed by the
  spec" already lists it (`resolved rendered text → translated catalog
  value → literal child text → ...`).
- Catalog miss (EDGE-004: key exists, no catalog entry; or the domain
  itself couldn't be resolved and no unique cross-domain match exists):
  `text = null`, `text_source = "translation_key"` — matches EDGE-004's
  wording exactly, and is `text_source`'s existing terminal tier in
  REQ-011's precedence ("...→ unresolved translation key").

### EDGE-005 — cross-language matching

No language-bridging logic of any kind was added. `i18n_key.data.translations`
stores every locale a catalog actually connects to this msgid; a downstream
resolver (1A-7, out of scope here) comparing a Vietnamese task phrase
against an English source label can look it up via a shared `i18n_key`
catalog entry. No fuzzy cross-language string matching and no LLM/machine
translation call was introduced anywhere in this phase, satisfying REQ-004's
explicit prohibition.

### Config

`config.uiI18nLocale` (`src/config.js`), env var `UI_I18N_LOCALE`, default
unset (`null`). Reuses `config.uiEnabled` for the gate (no separate on/off
flag for i18n specifically — same `lang === "php"` per-file gate, same
project-wide post-pass gate as `resolveHookGraph()`).

### Storage plane / concurrency

Verified by test: only `entities` (`kind IN ('i18n_key', 'i18n_call_site')`)
and `entity_links` (`relation IN ('TRANSLATION_OF', 'TRANSLATION_USED_AT')`)
are touched; `symbols`/`edges` untouched. Concurrency: no new primitive
needed — same `pg_advisory_lock(project.id)` single-writer guarantee
`resolveHookGraph()` already relies on for same-project serialization
(contracts.md "Phase 1A-3"), plus `i18nCatalog.js`'s explicit no-caching
design for the cross-project case (see above).

### What 1A-6/1A-7/1A-8 need to know

- `i18n_key`/`TRANSLATION_OF`/`TRANSLATION_USED_AT` are **already fully
  resolved project-wide** by the time 1A-6's own post-pass runs (1A-6
  depends on 1A-4 per the manifest) — no re-resolution needed, only
  consumption if 1A-6's own logic wants to reference i18n facts.
- A `ui_element`'s `data.text`/`data.text_source` may now already reflect a
  translated catalog value (`text_source: "translated_catalog_value"`) or a
  confirmed-unresolved key (`text_source: "translation_key"`, `text: null`)
  — 1A-7's REQ-011 precedence implementation should treat these as already
  applied for elements this phase touched, not re-derive them.
- Do not read or write `i18n_call_site` — internal-only, same rule as
  `hook_site`.
- The compound-literal limitation above (mixed literal + i18n text is never
  spliced) means a `ui_element` can have `data.i18n_key` set with `data.text`
  still being 1A-1's raw reconstruction, un-upgraded — 1A-6/1A-7 should not
  assume every non-null `i18n_key` implies an upgraded `text`.
- `i18n_key.data.translations` is the resource for EDGE-005 cross-language
  matching — 1A-7 should read it directly rather than re-parsing catalogs.

## Phase 1A-5 — Identity preflight in `index_project` (2026-08-28)

STATUS: DONE. Implements REQ-027 for Increment 1A. Resolves the
`UI_IDENTITY_INCOMPLETE` diagnostic-shape pending decision (removed from
"Pending cross-phase decisions" above).

### Pipeline position (confirms/refines the "Fixed by the spec" bullet above)

The preflight runs inside `runIndex()` in `src/indexer.js`, as a new
`runIdentityPreflight(project, log)` call immediately after
`const identity = await reconcileIdentity(project, retired, appeared, log);`
(current line ~567 — contracts.md's earlier line reference, 455, had already
drifted from 1A-1..1A-4 edits; expect further drift and re-resolve by
searching for `reconcileIdentity(` rather than trusting a cited line
number). Gated by `config.uiEnabled` (same gate `resolveHookGraph()`/
`resolveI18nGraph()` already use) and wrapped in its own try/catch — a bug
in the preflight itself must not fail the code index either, same
additive-subsystem contract as every other optional pass in this function.

**Correction to the phase brief's assumption:** `resolveHookGraph()` (1A-3)
and `resolveI18nGraph()` (1A-4) do **not** sit after `reconcileIdentity()` —
they're both called earlier, right after the existing namespace-edge
resolution block (lines ~502/523), which is *before* `reconcileIdentity()`
at line ~567. So they were never "post-pass precursors occupying the slot
after reconcileIdentity" the way the brief assumed; that slot was actually
empty. This phase's preflight is the first thing to occupy it. 1A-6's
implementer should verify this ordering afresh rather than trusting this
note, since it too will drift.

### Handoff shape (what 1A-6 reads)

`runIndex()`'s returned stats object now carries `identityPreflight`,
alongside the pre-existing `hooks`/`i18n`/`identity` fields:

```js
{
  complete: boolean,        // false => at least one symbol this run still
                             // lacks entity_id after the preflight ran (or
                             // the preflight itself threw)
  backfillRan: boolean,     // true iff backfillProjectIdentity() was invoked
                             // this run (identityBackfillStatus found >0
                             // unlinked before it)
  backfillResult: {files, symbols, entities} | null,  // backfillProjectIdentity()'s
                             // own return value when it ran without
                             // throwing; null if it never ran or threw
  diagnostics: [ /* UI_IDENTITY_INCOMPLETE shape, see below */ ],  // [] when complete
}
// or `null` when config.uiEnabled is false (preflight didn't run at all)
```

1A-6 (not yet built as of this phase) is expected to be the next thing added
right after this call site, in the same `runIndex()` function, and should
read the local `identityPreflight` variable directly rather than
re-deriving identity completeness itself. Treat `identityPreflight === null`
the same as `identityPreflight.complete === false` for gating purposes —
don't assume identity is complete unless `identityPreflight?.complete ===
true`. When incomplete, 1A-6's `DEFINED_BY`/`HANDLED_BY` writer must mark
the affected relation rows `unresolved` (REQ-027's own wording) rather than
omitting or retrying them, and may append its own more specific diagnostic
entries (same shape below, with a relation-specific `affected_feature`) to
its own result rather than mutating this one — this phase's `diagnostics`
array holds at most one project-level entry, since no specific relation is
known yet at preflight time.

### `UI_IDENTITY_INCOMPLETE` diagnostic shape — decision (resolves the
pending item)

**Decision: introduce the richer spec shape verbatim** —
`{code, severity, affected_feature, message, recommended_action}` — rather
than folding it into this codebase's existing `{error: e.message}`
additive-subsystem convention (used by docs/history/rules and by 1A-3/1A-4's
own `hooks`/`i18n` failure branches).

**Rationale:** REQ-027's text is prescriptive about the diagnostic's
content, not just "log something" — it requires the system to emit a
diagnostic "naming the affected feature and recommending
`waycontext backfill-identity`". `{error: e.message}` has no field for
either of those; it's a log-and-move-on breadcrumb for a human reading
indexer output, not a structured fact a later phase can branch on.
Folding REQ-027's requirement into `{error}` would mean either dropping
`affected_feature`/`recommended_action`/`severity`/`code` (directly
contradicts REQ-027's wording) or overloading `error` with a formatted
string those fields would have to be re-parsed out of — worse than just
having the fields. Introducing the richer shape as its own thing costs
nothing to the existing convention: every other additive subsystem in
`runIndex()` keeps its own `{error: e.message}` breadcrumb untouched
(`hooks = { error: e.message }` etc. is unchanged); this is additive, not a
replacement, and doesn't migrate `hooks`/`i18n`/`history`/`rules` onto the
richer shape — those failures have no "affected feature" of their own to
name and no remediation command to recommend, so REQ-027's specific
requirement doesn't generalize to them.

Shape, produced by `identityIncompleteDiagnostic(project, detail)` in
`src/indexer.js`:

```js
{
  code: "UI_IDENTITY_INCOMPLETE",
  severity: "warning",           // never fails the job -- REQ-027
  affected_feature: "ui_relations",  // fixed string at this phase: no
                                      // specific DEFINED_BY/HANDLED_BY
                                      // relation is known yet at preflight
                                      // time. 1A-6, once built, is where a
                                      // relation-specific value becomes
                                      // possible/expected.
  message: string,               // names the project and the unlinked-
                                  // symbol count or the backfill error
  recommended_action: "waycontext backfill-identity",
}
```

1A-6/1A-9 should test against exactly these five keys — `Object.keys(diag)
.sort()` is `["affected_feature","code","message","recommended_action",
"severity"]`.

### Behavior details

- `identityBackfillStatus(project.id)` returning no row at all (a project
  with zero symbols) is treated as trivially complete — `backfillRan:
  false`, no diagnostic. Same for a row with `unlinked === 0`.
- When `unlinked > 0`, `backfillProjectIdentity(project, { log })` is called
  exactly once per `index_project` job (not per file — it's called from the
  new post-file-loop step, same as `reconcileIdentity`/`resolveHookGraph`/
  `resolveI18nGraph`). Its own failure is caught locally; the preflight then
  **re-checks** `identityBackfillStatus` rather than trusting
  `backfillProjectIdentity`'s return value alone — a successful call can
  still leave rows unlinked (e.g. two symbol rows sharing a pre-existing,
  non-NULL `symbol_key` collide in `backfillProjectIdentity`'s single
  multi-row `INSERT ... ON CONFLICT DO UPDATE`, which Postgres rejects
  outright — "ON CONFLICT DO UPDATE command cannot affect row a second
  time" — leaving both still unlinked even though the call didn't touch
  every other pending row; verified end-to-end by test, not merely
  reasoned about).
- No new locking primitive — runs inside the same per-project
  `pg_advisory_lock(project.id)` `indexProject()` already holds around the
  whole `runIndex()` call, satisfying `backfillProjectIdentity`'s own
  documented precondition (`src/backfillIdentity.js:15`). Confirmed by
  re-reading `src/indexer.js:99-106`; no change needed there.

### Config / storage plane

No new config flag — reuses `config.uiEnabled` exactly as 1A-3/1A-4 gated
their own post-passes. No new tables/columns — this phase only calls the
pre-existing `identityBackfillStatus`/`backfillProjectIdentity`
(`src/backfillIdentity.js`, untouched by this phase) and adds a new field
to `runIndex()`'s in-memory return value; nothing new is written to the
database that `backfillProjectIdentity` wasn't already going to write.

### Tests

`test/identity.preflight.test.js` (four tests, all passing against the real
DB, no mocking): already-complete no-op, successful multi-file backfill in
one job (asserted both via `backfillResult.files` and via the preflight's
own log line appearing exactly once), a genuine backfill failure (via the
duplicate-`symbol_key` collision above) that leaves identity incomplete
while the overall `index_project` job still reports `failed: 0`, and
`config.uiEnabled = false` leaving `identityPreflight` `null` with no
backfill attempted. Full suite: 695 tests passing (691 pre-existing + 4
new), 0 failures.

### What 1A-6 needs to know (summary)

- Read `identityPreflight` (the local variable, once 1A-6's own call site is
  added right after it in the same function) — do not re-derive identity
  completeness by calling `identityBackfillStatus` again.
- `identityPreflight === null` (feature gate off) and
  `identityPreflight.complete === false` both mean "do not assume identity
  is complete" — gate on `identityPreflight?.complete === true` specifically.
- When incomplete, mark dependent `DEFINED_BY`/`HANDLED_BY` relations
  `unresolved` (REQ-027) rather than omitting or silently retrying them.
- The `UI_IDENTITY_INCOMPLETE` shape is fixed (five keys, listed above);
  1A-6 may emit its own additional diagnostics in the same shape with a
  more specific `affected_feature`, but should not alter this phase's
  project-level one.
- `resolveHookGraph()`/`resolveI18nGraph()` run *before* `reconcileIdentity()`
  and this preflight, not after — see "Correction to the phase brief's
  assumption" above if building on the assumption they're precursors sitting
  in this same post-identity slot.

## Phase 1A-6 — UI-specific post-pass orchestration (2026-08-28)

STATUS: DONE. THE checkpoint phase (Blast radius=2). Implements REQ-006,
REQ-013, REQ-015, REQ-019, REQ-020, REQ-021, REQ-022 for Increment 1A;
completes REQ-018's cross-file `do_settings_sections()` correlation 1A-2 left
open. Resolves EDGE-006 and the `resolution_status` enum (both removed from
"Pending cross-phase decisions" above).

### Pipeline position (verified fresh against real code, not trusted from
any prior phase's note)

`resolveUiRelations(project, identityPreflight, log)` is called in
`runIndex()` (`src/indexer.js`) immediately after the `identityPreflight`
block (right before `let history = null;`), confirming 1A-5's own note that
this slot was open and reserved for this phase. Gated by `config.uiEnabled`;
wrapped in its own outer try/catch (a bug in the whole function must not
fail the code index), and internally, every one of its 8 steps
(clear-stale-links, materialize-ui-component, classify-ownership, renders,
defined-by, handled-by, contains-screen-component, contains-settings,
rendered-on — 9 named steps total) is **independently** try/catch-wrapped
via a local `step(name, fn)` helper: one step throwing is logged and
recorded in `stats.uiRelations.errors[]`, the remaining steps still run
(REQ-021). `runIndex()`'s returned stats gained a new `uiRelations` field:
`{ componentCount, definedBy, handledBy, contains, renders, renderedOn,
errors: [{step, error}] }`, or `{ error: e.message }` if the whole function
threw outside a step, or `null` when `config.uiEnabled` is false.

### New staging entity: `settings_render_site` (closes a real gap the phase
brief didn't fully anticipate)

The brief assumed 1A-6 could "complete the cross-file `do_settings_sections()`
case" by reading something 1A-2 already staged. Re-reading 1A-2's own
contracts.md section and `writeUiWpPrimitives()` directly showed this isn't
true: 1A-2 only ever correlates `do_settings_sections($page)` against
`ui_settings_section`/`ui_settings_field` rows **in the same file**, and
silently drops the call site if nothing in-file matches — nothing is staged
for a later phase to read for the cross-file case (the dominant real-world
WP pattern: settings registered in an `admin_init` callback in one file,
rendered from a menu-page template in another).

To close this, 1A-6 adds a fifth sibling PHP extractor,
`src/ui/phpSettingsRender.js` (`extractPhpSettingsRenderSites(source) ->
{page, owner, line}[]`, literal `$page` only, exact same tree-sitter-php
sibling shape as `phpHooks.js`/`phpI18nCalls.js`), and a new **internal-only**
staging entity kind, `settings_render_site` (same non-spec-facing status as
`hook_site`/`i18n_call_site` — never returned by any MCP operation, not in
REQ-025's fixed `entities.kind` list). Written per-file in
`src/indexer.js`'s existing `config.uiEnabled && lang === "php"` block via
`writeUiSettingsRenderSites()`, same tombstone-then-upsert lifecycle as its
four siblings; `dropFile()`'s tombstone list now includes it too.
`natural_key = settingsrender:<project_name>:php:<source_path>:<owner>:<fingerprint>`,
`data: {source_path, owner, line, page}`.

This was scored, in the Gate step, as within the checkpoint's already-assumed
shape (an established, already-tested 4-times-precedented pattern, not a new
mechanism) rather than grounds to escalate — see plan.md "Gate" for the full
reasoning.

### `ui_component` — new node type (REQ-019/REQ-020), materialization rule

**One `ui_component` entity per distinct `(source_path, owner)` pair
referenced as `owner` by at least one live `ui_element`, `ui_screen`,
`ui_settings_section`, or `ui_settings_field` row — always materialized
(never gated on ">1 element sharing an owner"), EXCLUDING the `"@file"`
top-level sentinel.** Rationale: a uniform graph shape (every function-scoped
UI entity belongs to exactly one component) lets 1A-7/1A-8 write one
traversal instead of branching on cardinality; `"@file"` is excluded because
there is no function/class to represent as a component for bare top-level
markup — REQ-020's own `<component_identity>` slot already treats `"@file"`
as "no component" for `ui_element`, so `ui_component` follows the same
convention rather than fabricating one.

`kind = 'ui_component'`. `natural_key =
ui:<project_name>:php:<source_path>:<owner>:component` (REQ-020's fixed
format; the `<element_fingerprint>` slot is the literal string `component`
— no content hash needed since `(source_path, owner)` is already unique).
`title = owner`. `data` (all fields always present):
```
{ component_id,        // = natural_key, self-describing, same convention as element_id/hook_id/etc
  framework: "php", source_path, owner,
  ownership,            // "application" | "framework" -- REQ-013, see below
  defined_by_status,     // present only once DEFINED_BY has been attempted -- see "resolution_status" below
}
```
Lifecycle: recomputed in full every project-wide post-pass run (same
cost/simplicity tradeoff `resolveHookGraph()`/`resolveI18nGraph()` already
made) — upsert every currently-referenced `(source_path, owner)` pair,
tombstone any `ui_component` no live element/screen/settings row references
anymore. Not tied to any one file's per-file tombstone pass (a component's
liveness depends on the whole project's current UI-entity set, same
reasoning `hook`/`i18n_key` already established).

### Relations this phase writes

All five are recomputed in full on every run (delete this project's own
`DEFINED_BY`/`HANDLED_BY`/`CONTAINS`/`RENDERS`/`RENDERED_ON` links touching a
`ui_*` entity, then reinsert) — same tradeoff `resolveHookGraph()` already
made and documented. `RENDERED_BY`/`REGISTERED_AT`/`LISTENS_TO`/`FIRED_BY`/
`TRANSLATION_OF`/`TRANSLATION_USED_AT` (1A-2/1A-3/1A-4's own relations) are
never touched, cleared, or rewritten by this phase — only read.

- **`RENDERS`** (`ui_component → ui_element`): same `(source_path, owner)`.
  Direct string-keyed join, no ambiguity, always `resolution_status:
  "resolved"` when written.
- **`DEFINED_BY`** (`ui_element`/`ui_component → symbol` entity): the
  entity's own `owner`, resolved to that owner's `symbols.entity_id` in the
  **same file** (an owner is always in-file by construction — 1A-1/1A-2/1A-6
  all derive `owner` from the same per-file parse tree). `entity_links.data
  = {resolution_status: "resolved", ownership}` (`ownership` classifies the
  **target** symbol's file, per REQ-013 below).
- **`HANDLED_BY`** (`ui_component → symbol` entity): reuses 1A-3's
  already-resolved `LISTENS_TO` graph, no hook logic reimplemented. For
  component `C`: if a live `hook_site` shows `C`'s own `(source_path,
  owner)` **firing** a hook, and that hook already has a `LISTENS_TO` link
  (written by `resolveHookGraph()`) to some symbol `S`, write `C
  --HANDLED_BY--> S`. Reading: "this component's action is handled by S" —
  the concrete content for REQ-015's category (D) callout applied at the
  UI-component level. Distinct from `DEFINED_BY` ("who wrote this markup")
  — `HANDLED_BY` answers "who processes what this component does".
  Deliberately **sparse, no miss-tracking**: unlike `DEFINED_BY`/
  `RENDERED_ON`, most components never fire a hook at all, so an absent
  `HANDLED_BY` is the normal case, not a resolution failure worth annotating.
- **`CONTAINS`**:
  - `ui_screen → ui_component`: joined through the **shared target symbol
    entity_id** both sides already resolve to independently (the screen's
    1A-2-written `RENDERED_BY` link, the component's own `DEFINED_BY` link
    written by this phase) — sidesteps name-collision ambiguity entirely,
    no fresh string matching needed.
  - `ui_component → ui_settings_section`/`ui_settings_field`: via
    `settings_render_site` (see above) — when a live render site's
    `(source_path, owner)` matches a component, and a live section/field's
    `page` matches the render site's `page`, link `CONTAINS`. "Unique match
    only" discipline (skip on ambiguous multi-match — same rule
    `resolveHookGraph()`'s `LISTENS_TO` already applies).
  - `ui_screen → ui_settings_section`/`ui_settings_field` (flattened,
    one-hop convenience): written whenever the component-level link above
    exists AND that same component is also `CONTAINS`'d by a screen.
  - `ui_settings_section → ui_settings_field`: field's `(page, section)`
    matches section's `(page, section_id)`, project-wide, unique-match only.
- **`RENDERED_ON`** (`ui_element → ui_screen`): flattened from `ui_screen
  --CONTAINS--> ui_component --RENDERS--> ui_element` — REQ-006's own ask
  ("associated with the Screen(s) it belongs to, so a query can be scoped by
  screen") answered directly, without forcing every caller through a 2-hop
  traversal.

### EDGE-006 — RESOLVED: one entity, many `RENDERED_ON` links

A `ui_element`/`ui_component` reused across several screens (a shared
renderer function invoked by more than one `add_menu_page`/
`add_submenu_page()` registration) gets **one entity, multiple
`RENDERED_ON` links** — never a duplicated entity per screen. Reasons: (1)
`element_id`'s durable natural key (REQ-020) is `(source_path, owner,
fingerprint)`, independent of which screen(s) invoke the owning renderer —
duplicating the entity per screen would need a second, REQ-020-incompatible
key format. (2) `entity_links`' `UNIQUE(src_id, relation, dst_id)`
constraint already supports multiple `RENDERED_ON` rows from one `src_id`
to different `dst_id`s natively, zero extra schema work. (3) Any hook/i18n
links already attached to that one element's content stay singular and
correct. **1A-7/1A-8: a `ui_element`/`ui_component` may legitimately have 0,
1, or several `RENDERED_ON`/`CONTAINS`(as target) links — never assume
exactly one.**

### `resolution_status` — RESOLVED: five-value closed enum, two storage
locations

| value | where it lives | meaning |
|---|---|---|
| `resolved` | `entity_links.data.resolution_status` (on `RENDERS`/`DEFINED_BY`/`HANDLED_BY`/`CONTAINS`/`RENDERED_ON` rows) | target found via an exact, unambiguous signal (shared entity_id, or unique name/page match). What effectively every link 1A-6 writes carries — no relation this phase writes has a "write it anyway at lower confidence" path in Increment 1A's scope. |
| `partial` | `entity_links.data.resolution_status` | target found via a weaker heuristic where more than one interpretation existed but a best-effort pick was recorded as such. **Not produced by any relation 1A-6 writes.** Reserved for 1A-7/1B work already named elsewhere in the spec (EDGE-003/Q-013). |
| `unresolved` | the **source entity's own** `data` (field name is **relation-scoped**: `defined_by_status` for the `DEFINED_BY` attempt, `render_status` for the `RENDERED_ON` attempt — deliberately NOT one shared `resolution_status` key, since one entity can independently miss both for different reasons and a shared key would have the later-run step clobber the earlier one's note) | a relation conceptually applies but couldn't be completed because `identityPreflight?.complete !== true` for this run. **Never written as a relation row** — `entity_links.dst_id` is `NOT NULL` (schema constraint, `src/migrations/0006_identity_and_history.sql:78`), so there is no relation to "mark"; the gap is recorded on the entity that would have had the link instead. A later run, once identity is backfilled, recomputes in full and upgrades the field to `"resolved"` (verified end-to-end by test, not just reasoned about — see `test/indexer.uiRelations.test.js`'s REQ-027 test). |
| `unknown_render` | same as `unresolved` above (`defined_by_status` / `render_status`) | identity was complete (`identityPreflight.complete === true`) and resolution was attempted, but no candidate target exists anywhere in the current graph (e.g. an element's owning function is never used as any screen's renderer, or any settings render site's owner). Distinct from `unresolved`: not a transient identity gap, genuinely nothing to link. |
| `data_owned` | entity's own `data.resolution_status` (a **different**, unscoped field name — 1B-2's own entity-level field, not `defined_by_status`/`render_status`) | reserved, written only by 1B-2 (REQ-015 category C — persisted/dynamic content). **Not produced anywhere in this phase.** |

The gate for `unresolved` vs `unknown_render` is a single global flag per
run (`identityPreflight?.complete === true`), not a per-row diagnosis of
*why* a specific symbol lookup failed — when identity is known incomplete
project-wide, treating every miss that run as `unresolved` (rather than
trying to distinguish "this miss is identity's fault" from "this miss is
genuinely unfindable") is the conservative, correct call: a full recompute
on the very next run (once identity is fixed) naturally re-derives the true
answer either way.

### REQ-013 — ownership/framework classification

`classifyOwnership`, expressed once as a reusable SQL `CASE`/regex fragment
(`OWNERSHIP_CASE_SQL` in `src/indexer.js`) rather than per-row JS: `framework`
when the path contains `wp-admin/`, `wp-includes/`, or `vendor/` as a
`/`-bounded path segment, else `application` — exactly contracts.md's
"Fixed by the spec" heuristic. Applied to:
- every live `ui_element`/`ui_screen`/`ui_settings_section`/
  `ui_settings_field`'s own `data.ownership` (merged in, one `UPDATE` per
  run, not disturbing other fields);
- `ui_component.data.ownership` (computed inline at materialization time);
- every `DEFINED_BY`/`HANDLED_BY` link's own `data.ownership`, classifying
  the **target** symbol's file (not the source entity's file — for
  `DEFINED_BY` these are always the same file by construction, but
  `HANDLED_BY`'s target can be in a different file, so this is the
  meaningful case).

1A-8 (REQ-013's actual "point the agent at application source, report
framework as `not_relevant`" behavior) can read `ownership` directly off
whichever entity/link it's already traversing — no path re-derivation needed.

Context, not a design decision: `vendor/**` is already in `src/indexer.js`'s
`DEFAULT_IGNORES` for the project glob walk, so in practice very little
`vendor/`-owned code is ever indexed as symbols/UI entities to begin with —
the classifier still exists for `wp-admin/`/`wp-includes/` (not ignored by
default) and for a project whose own `.gitignore` doesn't exclude `vendor/`.

### REQ-015 — category A/B/D distinction

Not a separate mechanism, implicit in the above: category (A) code-owned =
`ownership: "application"` on the resolved `DEFINED_BY`/`HANDLED_BY` target;
category (B) framework-owned = `ownership: "framework"` there; category (D)
plugin-owned = fully covered by 1A-3's `LISTENS_TO`/`FIRED_BY` graph,
consumed (not rebuilt) via `HANDLED_BY`. Category (C) data-owned is
explicitly not attempted here — `resolution_status: "data_owned"` stays
reserved/unused by this phase.

### Storage plane / concurrency

Verified by test: only `entities` (`kind IN ('ui_component',
'settings_render_site')`, plus `data` merges on `ui_element`/`ui_screen`/
`ui_settings_section`/`ui_settings_field`) and `entity_links` (`relation IN
('DEFINED_BY','HANDLED_BY','CONTAINS','RENDERS','RENDERED_ON')`) are
touched; `symbols`/`edges` untouched (verified by test, and by the full
712-test suite passing unchanged). Concurrency: no new primitive — runs
inside the same per-project `pg_advisory_lock(project.id)` every other
project-wide pass already relies on; the new per-file `settings_render_site`
write runs inside the same per-file transaction the other four PHP UI
extractors already use.

### Tests

`test/ui.phpSettingsRender.test.js` (5 tests, pure extractor unit tests, no
DB). `test/indexer.uiRelations.test.js` (12 tests, real-DB end-to-end,
no mocking): component materialization, `RENDERS`+`DEFINED_BY`, `CONTAINS`
(screen→component via shared symbol, cross-file settings via
`settings_render_site`, section→field), `RENDERED_ON` (including the
`unknown_render` case), `HANDLED_BY` (reusing 1A-3's graph), REQ-013
ownership classification, `config.uiEnabled = false` full skip, REQ-027's
`unresolved` status end-to-end (a genuine, unmocked `backfillProjectIdentity`
collision failure, same technique `test/identity.preflight.test.js` uses),
storage-plane isolation, and full-recompute tombstone/restore for
`HANDLED_BY`. Full suite: 712 tests passing (695 pre-existing + 17 new), 0
failures.

### What 1A-7 needs to know

- `ui_component` is a real, queryable node — read it directly rather than
  re-deriving "which function owns this element" from `ui_element.data.owner`
  string matching.
- A `ui_element`/`ui_component` may have 0, 1, or several `RENDERED_ON`/
  `CONTAINS`(as target) links (EDGE-006) — never assume cardinality 1.
- `entity_links.data.resolution_status` is `"resolved"` on every relation
  1A-6 currently writes; `"partial"` is reserved but unused — 1A-7's own
  `match_score`/4-signal work is free to introduce the first real
  `"partial"` writer if it needs one, using this same enum.
- A `ui_element`/`ui_component` with `defined_by_status`/`render_status ===
  "unresolved"` means "re-check after `waycontext backfill-identity`", not
  "permanently unrenderable" — `"unknown_render"` means the opposite (stable
  fact, identity was complete when this was computed).
- `ownership` (`"application"`/`"framework"`) is precomputed on every
  UI-graph entity and on `DEFINED_BY`/`HANDLED_BY` links — REQ-013's
  "framework renderer is `not_relevant`" behavior can read this field
  directly.

### What 1A-8 needs to know

- Same points as 1A-7 above (1A-8 depends on 1A-7 which depends on this
  phase).
- `hook_site`/`i18n_call_site`/`settings_render_site` are all
  internal-only, never MCP-facing — same rule 1A-3/1A-4 already established,
  now extended to this phase's own staging kind.
- EDGE-010 (staleness) is still open — this phase didn't need to touch it
  (it writes relations at index time, not query-time output); 1A-8 is
  expected to be the phase that resolves it if it needs resolving at all.

### What 1B-2 needs to know

- `resolution_status: "data_owned"` is reserved specifically for you
  (REQ-015 category C) — write it directly on the entity's own
  `data.resolution_status` field (not `defined_by_status`/`render_status`,
  which are 1A-6's own relation-scoped field names for a different purpose).
  Nothing in 1A currently writes this value; you're the first.

## Phase 1A-7 — UI Reference Resolver + `match_score` (2026-08-28)

STATUS: DONE. Implements REQ-008, REQ-009, REQ-010, REQ-011 for Increment
1A. Pure query/scoring phase — no new `entities`/`entity_links` writes, no
MCP operation (that's 1A-8).

### REQ-009 judgment call: no server-side LLM provider was built

**Decision:** only the deterministic fallback path is implemented. No
outbound-call-capable "model provider" abstraction was added anywhere in
this codebase by this phase.

**Reasoning, for 1A-8/1A-9 and anyone revisiting this later:**
1. No chat/completion provider config exists anywhere in this codebase
   today — grepped `src/config.js` and every `src/*.js`: the only
   provider-shaped config (`config.embeddingProvider`, `config.voyage`,
   `config.openai`) is scoped to *embeddings* for vector search, unrelated
   to NL parsing. Building a new provider abstraction (HTTP client, API key
   config, retry/timeout/error handling) from scratch would have been new
   infra + new security surface well beyond a phase scored total-risk=2 —
   exactly the escalation trigger the orchestrator's own brief named.
2. REQ-009's text — "By default, natural-language parsing happens in the
   calling agent, not inside WayContext" and "Enabling server-side
   provider-based parsing REQUIRES explicit configuration" — reads as a
   forward-looking allowance for some later increment, not a mandate for
   1A. No spec text names a specific provider, config key, or endpoint to
   wire up even if it were in scope.
3. `task_text` therefore never leaves the process, by construction (no
   network client exists to send it anywhere) — trivially satisfying
   REQ-009's "task_text MUST NOT leave the machine by default" without
   needing a runtime guard.

If a later phase (or a human) decides to build server-side provider-based
parsing, that is new work requiring its own risk score — this phase
deliberately left no partial scaffolding for it to avoid an
easy-to-miss half-built provider path.

### `src/ui/referenceResolver.js` — new module

Sibling to the existing `src/ui/*.js` extractors (phpElements.js,
phpHooks.js, phpI18nCalls.js, phpWpPrimitives.js, phpSettingsRender.js,
i18nCatalog.js), same "pure where possible" convention — except this module
is allowed to touch the DB directly (`pool`/`getProject` from `src/db.js`),
since its whole job is a read-only query, not an extraction into
`entities`/`entity_links`.

#### `extractQueryFields(taskText, hints)` — REQ-008/REQ-009, pure, no I/O

Returns `{screen, element_type, visible_text, viewport, problem_type}`.

- `hints` (Q-009's three named fields: `screen`, `text`, `role`) bypass
  extraction for the field they cover and are treated as authoritative —
  never second-guessed against what free-text extraction would have found.
  `hints.text` → `visible_text`. `hints.role` → `element_type` (run through
  `canonicalElementType()`, but an unrecognized hint value passes through
  normalized rather than being dropped — a hint is a fact from the caller,
  not a guess this module is entitled to reject).
- Free-text extraction (used only for fields not covered by a hint) is
  entirely regex/keyword-based, deterministic, documented as
  heuristic/non-exhaustive (same style as `i18nCatalog.js`'s own discovery
  heuristic doc comment) — no ML, no LLM, no fuzzy matching at this layer:
  - `visible_text`: first quoted substring (`"..."`/`'...'`) in the text, or
    `null` if none — the only unambiguous way to pull a literal phrase out
    of free text without guessing at sentence structure.
  - `screen`: `/(?:on|in|at|under) the <words> (?:page|screen|tab|section|panel|menu)/i`,
    or `null`.
  - `element_type`: a ~30-entry phrase→canonical table (`button`, `link`,
    `textbox`, `heading`, `select`, `checkbox`, `radio`, `label`, `image`,
    `menu`, `menuitem`, `tab`, `option`, `summary`, `legend`, `caption`),
    longest-phrase-first so `"text field"` matches before a bare
    `"field"` would. Exported as `canonicalElementType()` for reuse by the
    scorer (below) and by 1A-8 if it wants to canonicalize a raw hint
    before calling this module.
  - `viewport`: `mobile`/`tablet`/`desktop` keyword table, or `null`.
  - `problem_type`: `missing`/`incorrect_text`/`disabled`/`broken`/`styling`
    keyword table, or `null`. Not consumed by `scoreCandidate` at all (no
    REQ-011 signal maps to it) — carried through purely for 1A-8/a future
    phase's own informational use (e.g. `trace_ui_action`).
  - No field is ever guessed when nothing matches — every extractor returns
    `null` on a miss, same no-fabrication discipline as every prior phase's
    extractors (REQ-026's spirit, even though REQ-026 is nominally about
    relation targets).

#### `scoreCandidate(candidate, queryFields)` — REQ-011, pure

`candidate = {data, screens}`: `data` is a `ui_element.data` blob (1A-1/
1A-4 shape, read verbatim); `screens` is an array (length 0, 1, or many —
EDGE-006) of `ui_screen.data` blobs reached via the element's `RENDERED_ON`
links. `queryFields` is `extractQueryFields()`'s output, **plus an optional
`taskText`** (the raw free-text string — only the context signal needs raw
prose rather than an already-extracted field; omitting it just zeroes that
one signal's contribution).

Returns `{match_score, evidence}`. Weights (`SIGNAL_WEIGHTS`, exported,
fixed): `text: 0.40, route: 0.30, role: 0.20, context: 0.10`.

- **text (0.40)**: `textSimilarity(data.text, queryFields.visible_text)` —
  reads the already-resolved `data.text`/`data.text_source` **verbatim**,
  never re-derived from raw attrs (per contracts.md "What 1A-7 needs to
  know", Phase 1A-6/1A-1/1A-4). `textSimilarity()` (exported) is a small
  deterministic function: exact match (post-normalization) → 1, substring
  containment either direction → 0.85, else Jaccard token overlap, else 0
  if either side is empty. No ML, no LLM — REQ-009's determinism mandate is
  read as applying to this whole resolver, not only field extraction.
- **route (0.30)**: `textSimilarity` between `queryFields.screen` and each
  screen's `route|menu_slug|page_title|menu_title` (space-joined), **max**
  across all of the candidate's screens — never assumes cardinality 1
  (EDGE-006). 0 if the candidate has no `RENDERED_ON` links or no `screen`
  query field.
- **role (0.20)**: canonicalized **exact** match only (`data.type`,
  fallback `data.role`, vs `queryFields.element_type`) — role is a discrete
  category, so no partial credit the way text/route get it.
- **context (0.10)**: token-recall overlap between `queryFields.taskText`
  and the owning component's identity — `data.owner` (skipped for the
  `"@file"` sentinel) plus the `source_path` basename, both split on
  `::`/`_`/`-`/camelCase boundaries into tokens. **Judgment call**: REQ-011
  names "surrounding/component context" as a signal but does not define an
  algorithm — this is the interpretation chosen. It deliberately reuses
  `data.owner` directly (already present on every `ui_element` row) rather
  than a second `ui_component` query, since `owner` already *is* the
  component identity per 1A-6. This is the one signal of the four not
  otherwise fully determined by contracts.md; the other three (text,
  route, role) have no comparable ambiguity. A later phase is free to
  redefine this signal's algorithm without touching the other three or the
  weights.

`evidence` lists contributing signal names (component score > 0) in fixed
order `["text","route","role","context"]`, matching REQ-011's own example
ordering (`["text","route","role"]`).

**Important interaction for callers/testers**: the floor (0.45, see below)
is *higher* than the single largest signal weight (0.40) — a candidate can
never cross the floor on an exact text match alone. At least one more
signal (role, route, or context) must also contribute. This is a direct,
intentional consequence of REQ-010's floor combined with REQ-011's weights,
not a bug — a single-signal match is corroboration-free by construction.

#### `resolveUiReference({project, taskText, hints, log})` — REQ-010, DB-backed

`project`: project name (string), resolved via `getProject()`; throws
`Error("Project not found: <name>")` if it doesn't resolve — same "caller's
job to pass a valid project name" contract every other query function in
this codebase assumes.

Returns `{enabled, queryFields, candidates}`:
- `enabled: false` (`queryFields: null`, `candidates: []`) when
  `config.uiEnabled` is off — checked **before any DB query**, never throws
  for this reason. This is a judgment call, not a copy of an existing
  convention: `docsEnabled`/`rulesEnabled` gate *indexing* only
  (`src/indexer.js`), not query-time operations (`src/operations.js` has
  zero references to any `Enabled` flag) — a query op with the flag off
  today just naturally returns empty results because nothing was ever
  written. This phase introduces an explicit disabled signal instead,
  since the orchestrator's brief specifically asked this module to
  "respect" the flag itself. 1A-8 should surface `enabled: false`
  distinctly from "found zero candidates" in whatever shape
  `resolve_ui_reference`'s MCP response takes.
- Otherwise `candidates` is at most `MAX_CANDIDATES` (exported, `= 5`,
  REQ-010) entries, each with `match_score >= MIN_MATCH_SCORE` (exported,
  `= 0.45`, REQ-010's floor — inclusive, "exclude any candidate scoring
  **below** 0.45"), sorted by `match_score` descending, ties broken by
  `element_id` string for determinism. Both constants are **not**
  caller-configurable parameters — hardcoded so no caller (1A-8 included)
  can accidentally violate REQ-010's hard cap/floor.

Each candidate:
```js
{
  element_id,      // data.element_id, falls back to natural_key
  title,
  match_score, evidence, text_source,
  visible_text,    // data.text, verbatim
  role, type,       // data.role, data.type, verbatim
  source_path, owner, line, ownership,
  screens: [ { screen_id, route, menu_slug, page_title, menu_title }, ... ],  // 0..n, EDGE-006
}
```
This is deliberately a superset of what any one MCP response is likely to
need — 1A-8 can trim/reshape it rather than this module needing to know
`resolve_ui_reference`'s exact wire format.

Query mechanics: a single bounded pool fetch (`kind = 'ui_element' AND
deleted_at IS NULL`, `ORDER BY id LIMIT 500` — `CANDIDATE_POOL_LIMIT`, not
exported, internal-only), then one batched `RENDERED_ON` join across all
fetched ids (avoids N+1), then in-process scoring/filter/sort/cap. No
full-text-search SQL (`ILIKE`/`to_tsvector`) was introduced — none exists
anywhere else in this codebase (checked), and building one was judged out
of this phase's scope/risk budget; the 500-row cap is a documented,
unmeasured scaling limitation, logged via the `log()` callback when hit, left
for 1A-9 to revisit if it proves to matter on a real large project.

### No `"partial"` resolution_status — explicit non-decision

Contracts.md's "Phase 1A-6" section noted `"partial"` is reserved but
unused, and that 1A-7 "is free to introduce the first real `'partial'`
writer if it needs one." This phase does not. `resolution_status` lives on
`entity_links` rows, and this phase writes **zero** `entity_links` (or any
other) rows — it's a pure query/scoring phase, per the orchestrator's own
scope boundary ("No new database writes"). There is nothing for this phase
to mark `"partial"` on. Recorded here explicitly so 1A-8 doesn't wonder why
it wasn't used — the enum is still open for whichever future phase
introduces its first DB-writing use, if any.

### Config / storage plane

No new config key — reuses `config.uiEnabled` exactly as every prior UI
phase gated its own work; checked directly by `resolveUiReference()` itself
(see above), not just inherited from upstream index-time gating. No schema
changes. No new tables/columns. No writes of any kind — verified by the
absence of any `INSERT`/`UPDATE`/`DELETE` in `src/ui/referenceResolver.js`
(read-only `SELECT`s only).

### Tests

`test/ui.referenceResolver.test.js` (17 tests): 11 pure unit tests (no DB)
covering `extractQueryFields` (free-text extraction, hint bypass, hint
precedence over text, no-guess-on-miss), `canonicalElementType`,
`textSimilarity`, and `scoreCandidate` (full weighted sum + evidence
ordering, EDGE-006 zero/multi-screen cases, zero-signal case); 6 real-DB
end-to-end tests (via a real `indexProject()` run over a tmp PHP fixture,
no mocking, same convention as `test/indexer.uiRelations.test.js`) covering
ranking + floor exclusion, the 5-candidate cap, `text_source` passthrough
for both `child_text` and `aria_label` tiers, unknown-project rejection,
and the `config.uiEnabled = false` short-circuit. Full suite: 729 tests
passing (712 pre-existing + 17 new), 0 failures.

### What 1A-8 needs to know

- Call `resolveUiReference({project, taskText, hints, log})` directly from
  `resolve_ui_reference`'s MCP operation handler — no further scoring or
  filtering is needed on 1A-8's side; the candidates array already honors
  REQ-010's cap/floor.
- `enabled: false` means the feature is off project-wide
  (`config.uiEnabled`) — surface this distinctly from "zero candidates
  found" in whatever response shape `resolve_ui_reference` settles on.
- `queryFields` (REQ-008's extracted/hint-merged fields) is returned
  alongside `candidates` — useful for 1A-8 to echo back to the caller so
  it's clear what was actually searched for (e.g. "matched on text='Save
  Changes', screen=null" helps a caller debug a bad match).
- A `resolveUiReference` call throws on an unknown project name — 1A-8's
  MCP handler should catch and translate that into whatever error
  convention the rest of `src/operations.js` uses for a bad `project`
  argument (this phase didn't touch `src/operations.js`, so didn't need to
  match that convention itself, but 1A-8 will).
- `canonicalElementType`, `textSimilarity`, `SIGNAL_WEIGHTS`,
  `MIN_MATCH_SCORE`, `MAX_CANDIDATES` are all exported from
  `src/ui/referenceResolver.js` if 1A-8 (or `find_ui_element`, which shares
  REQ-010's ranking rules per the manifest) wants to reuse any of them
  directly rather than re-deriving.
- REQ-009's provider question: still open for real server-side
  provider-based parsing, deliberately unimplemented (see judgment call
  above). If 1A-8 or a later phase wants to add it, treat that as new
  scope requiring its own risk score — nothing in this phase assumes it
  will never exist, but nothing here scaffolds it either.
- The floor/weight interaction noted above (a lone exact text match can't
  cross 0.45 alone) is a real, spec-derived property of this scoring
  scheme — worth remembering when writing 1A-8's own integration tests, so
  a "text-only" test fixture doesn't look like a bug when it correctly
  returns zero candidates.

## Phase 1A-8 — Five MCP operations (2026-08-28)

STATUS: DONE. Implements REQ-012 for Increment 1A. Resolves EDGE-010.
Pure query/composition phase — no new `entities`/`entity_links` writes, no
new scoring/ranking logic (all of that stays 1A-7's), no new call-graph
traversal primitive (reuses `src/graph.js`'s `getSubgraph` unmodified).

### New module: `src/ui/uiQueries.js`

Sibling to `src/ui/referenceResolver.js` (1A-7), same "DB-aware query
function, not an extractor" convention. Exports the five operation
functions (`resolveUiReferenceOp`, `findUiElementOp`, `getUiContextOp`,
`traceUiActionOp`, `findUiSourceOp`) plus private query helpers. `pool`/
`getProject` imported from `src/db.js`; `getSubgraph` imported from
`src/graph.js` (unmodified); `resolveUiReference` imported from
`referenceResolver.js` (unmodified). `requireProject()` is duplicated
locally (three lines) rather than imported from `src/graph.js`, extending
the module-boundary precedent every `src/ui/*.js` sibling since 1A-2 has
already established ("a few duplicated lines beats adding new exports to a
frozen, already-reviewed file").

`element_id` lookup (`requireUiEntity()`) resolves against
`entities.natural_key` directly — every self-describing id
(`element_id`/`screen_id`/`settings_id`/`component_id`) already **equals**
`natural_key`, established since 1A-1/1A-2/1A-6, so no separate
`data->>'element_id'` fallback is needed. Scoped to `kind IN ('ui_element',
'ui_component', 'ui_screen', 'ui_settings_section', 'ui_settings_field')`
— the five spec-facing UI kinds; the internal-only staging kinds
(`hook_site`, `i18n_call_site`, `settings_render_site`) and the two generic
kinds (`hook`, `i18n_key`) are never resolvable as an `element_id` by any
of these five operations. An unresolvable `element_id` **throws** — see
"Error convention" below.

### Wiring: `src/operations.js` + `src/completion.js`

Five new registry entries, `readOnly: true`, each with a full `cli.args`
list (every input field reachable from the CLI, per
`test/operations.test.js`'s existing invariant) and a short alias
(`ui-resolve`/`ui-find`/`ui-context`/`ui-trace`/`ui-source`). Registering a
new operation also requires an `OP_HELP` entry + section in
`src/completion.js` (an existing, generic invariant —
`test/completion.test.js`) — missed on the first pass, caught by the full
suite, fixed by adding a new `SECTIONS` entry (`ui`, "WordPress UI
(Increment 1A)") and five glosses, then regenerating
`test/fixtures/help.txt`. **1A-9/1B-anyone adding a new operation**: budget
for this — it's not optional, the help/completion tests fail loudly if
skipped.

### Judgment call: `readOnly`

**Decision: `true` for all five.** No source states this (NOTE [MISSING]
in the spec); every one of these five operations is a pure read over
already-indexed data (verified: `src/ui/uiQueries.js` contains no
`INSERT`/`UPDATE`/`DELETE`), matching the existing, unambiguous convention
every other read-only operation in `src/operations.js` already follows
(`search_code`, `get_callers`, etc. — 20 of the pre-existing 24 operations
are `readOnly: true`; only the four operations that actually write are
`false`). `src/mcpServer.js` derives `annotations.readOnlyHint`
mechanically from `op.readOnly`, so this also determines whether an MCP
client auto-approves the tool without a permission prompt.

### Judgment call: Authorization

Left unaddressed. NOTE [MISSING] in the spec, and **no operation in
`src/operations.js` declares any authorization/access-control field at
all** — not `index_project`, not `remember`, nothing that writes either.
This phase does not invent a first instance of a mechanism that doesn't
exist anywhere else in the registry; if/when this codebase gets an
authorization layer, it will apply uniformly to the registry, not be
bolted onto these five operations alone.

### Error convention: two different rules for two different kinds of input

- **`resolve_ui_reference`/`find_ui_element`** (a *search*, can legitimately
  find nothing): follows 1A-7's own established convention exactly —
  unknown `project` throws (via `requireProject()`, in this module's own
  wording, not `resolveUiReference`'s slightly different "Project not
  found: X" wording — this module validates the project **before** ever
  calling `resolveUiReference`, so its internal check never actually
  fires); missing `task_text`/hint combination throws (bad tool-call shape,
  a real caller error, not a search result); "nothing matched" is
  `status: "not_found"` in a 200-shaped response (Q-015).
- **`get_ui_context`/`trace_ui_action`/`find_ui_source`** (a *keyed lookup*
  by a specific `element_id` the caller is asserting exists): follows
  `src/graph.js`'s `requireSymbol()`/`requireFile()` convention instead —
  an unresolvable `element_id` **throws** ("No UI element ... Pass an
  element_id returned by resolve_ui_reference or find_ui_element."), the
  same as an unresolvable symbol/file path throws elsewhere in this
  codebase. This is a deliberate split, not an inconsistency: a search
  tool legitimately returns zero results; a get-by-id tool given a bad id
  is the caller's mistake, exactly `requireSymbol`'s own reasoning
  ("the difference between 'safe to change' and 'you typed the name
  wrong'").

### `resolve_ui_reference` / `find_ui_element` — candidate enrichment

1A-7's own candidate shape (`element_id, title, match_score, evidence,
text_source, visible_text, role, type, source_path, owner, line,
ownership, screens[]`) is enriched, not replaced, into REQ-012's
per-candidate shape:

```
{
  ...(1A-7's own fields, kept — screens[] included as a superset beyond the
      spec table's singular `screen`, see "screen singular vs screens[]"
      below),
  resolution_status?: "unresolved" | "unknown_render" | "data_owned",
                       // omitted (not present as a key) when fully resolved
                       // -- "partial" is still unused anywhere in this
                       // feature, per 1A-7's own note.
  limitations?: string[],   // omitted when empty
  source: { path, line, component },
  application_source: { path, line, component } | null,   // set iff ownership === "application"
  not_relevant?: { path, line, reason },                   // present iff ownership === "framework"
  handler: null,            // always -- see below
  api: null,                // always -- no data source in Increment 1A
  styles: [],               // always -- no data source in Increment 1A
}
```

**`resolution_status`/`limitations` source**: one small batched query
(bounded by `MAX_CANDIDATES = 5`, never the 500-row pool) reads each
candidate's raw `ui_element.data` for `resolution_status`/
`defined_by_status`/`render_status`/`has_dynamic_text` — fields 1A-7's own
candidate shape trims away. `application_source`/`not_relevant` need **no**
extra query at all — `ownership` is already on 1A-7's candidate object.

**`handler`/`api`/`styles` are always `null`/`[]` in this phase's
implementation — a deliberate scope-limiting judgment call, not an
oversight.** Populating `handler` for every one of up to 5 candidates on
every `resolve_ui_reference`/`find_ui_element` call means running the same
component/hook-chain queries `trace_ui_action` does, five times, on a tool
whose whole point is a fast ranked list. A caller that wants the handler
chain calls `trace_ui_action(element_id)` on the candidate it picks after
looking at the ranked list; one that wants the full one-hop graph calls
`get_ui_context`. `api`/`styles` have no data source anywhere in Increment
1A regardless — that chain (element → handler → mutation/service →
API endpoint → ...) is explicitly Increment 2 scope; `null`/`[]` here is
honest absence, not a stub for future wiring.

**`screen` singular vs. `screens[]` — a deliberate deviation from the
spec's literal table.** § 6.2.3's candidate shape names a singular
`screen` field; this phase does **not** implement a singular field, because
EDGE-006 (1A-6) established a `ui_element` may sit on 0, 1, or several
screens, and collapsing that to one field would either fabricate a "the"
screen or silently drop information for a multi-screen element. Instead,
1A-7's own `screens: [...]` array (already present on every candidate) is
kept verbatim — a superset of the literal spec table, in the same spirit
1A-7 itself used ("deliberately a superset... 1A-8 can trim/reshape rather
than this module needing to know the exact wire format"). 1A-9/anyone
auditing AC coverage against the literal spec table should expect
`screens[]`, not `screen`.

### `status: "ok" | "not_found" | "partial_match"` — judgment call

No source defines "ok" vs. "partial_match" beyond the three enum names.
Rule chosen, in `classifyStatus()`: zero candidates → `not_found`; one
candidate → `ok` (nothing to disambiguate); two or more candidates → `ok`
only when the top `match_score` clears the runner-up by **>= 0.15**,
otherwise `partial_match` (a genuine ambiguity the caller must resolve).
**The 0.15 threshold is this phase's own choice, not derived from
`SIGNAL_WEIGHTS`/`MIN_MATCH_SCORE`/anything else in contracts.md** —
recorded here explicitly so a later phase can retune it without hunting
for where it lives (`classifyStatus()` in `src/ui/uiQueries.js`).

`enabled: false` (1A-7's own gate signal, `config.uiEnabled` off) is
surfaced as a **separate boolean field**, per 1A-7's own instruction to
"surface this distinctly from zero candidates found" — rather than as a
fourth `status` value, since the spec's own table fixes `status` to
exactly three values. When disabled: `{ enabled: false, status:
"not_found", candidates: [] }`.

### `get_ui_context` — output shape (spec NOTE [AMBIGUOUS], resolved)

Spec's own words: "By analogy with the worked example it would carry
component, parent, handler, API and tests; the source does not say so for
this tool specifically" — item 13's set is named for a different,
out-of-scope IDE-sidebar surface, not this tool.

**Decision**: compose the element's own data with what 1A-6's post-pass
already resolved **one hop out** — no deeper. Chosen because (a) "tests"/
"API" have no data source anywhere in Increment 1A (fabricating them would
violate this whole feature's no-fabrication discipline, REQ-026's spirit),
and (b) stopping at one hop is what keeps this tool distinct from
`trace_ui_action`, which explicitly walks further (onward through the call
graph) — composing the full chain here too would make the two tools
redundant.

Shape:
```
{
  element: { element_id, kind, title, type, role, text, text_source,
             source_path, line, owner, ownership },
  component: { component_id, owner, source_path, ownership,
               defined_by_status } | null,
  defined_by: { symbol, kind, path, line } | null,
  screens: [ { screen_id, route, menu_slug, page_title, menu_title }, ... ],  // 0..n, EDGE-006
  handled_by: [ { symbol: { name, kind, path, line }, hook: string|null }, ... ],
  i18n: { key, msgid, textdomain, translations, resolved_locale, resolved_text } | null,
}
```

Resolution: `component` — for a `ui_element`, the incoming `RENDERS` link's
source; for a `ui_settings_section`/`ui_settings_field`, the incoming
`CONTAINS` link's source (kind-filtered to `ui_component`); a
`ui_component` entity is its own component. `defined_by` — the entity's own
`DEFINED_BY` target, falling back to the component's if the entity itself
has none. `screens` — a `ui_element`'s own outgoing `RENDERED_ON`; a
settings kind's incoming `CONTAINS` from `ui_screen` (the flattened
one-hop convenience 1A-6 already wrote). `handled_by` — the component's
outgoing `HANDLED_BY`, each entry's `hook` name filled in **best-effort**
via `firedHooksBySymbol()` (below) on the component's own `DEFINED_BY`
target — not always guaranteed to align 1:1 if a component fires more than
one hook, but correct for the common single-hook case this feature's own
1A-6 fixture exercises. `i18n` — the element's `TRANSLATION_OF` target, if
`data.i18n_key` is set.

**Primary intended input is `ui_element`/`ui_component`** (secondarily
`ui_settings_section`/`ui_settings_field`); calling it on a `ui_screen`
still resolves (its own data always comes back in `element`), but
`component`/`handled_by`/`i18n` come back null/empty since a screen
doesn't participate in those relations directly — documented, not a bug.

### `trace_ui_action` — Increment 1A chain only

Chain implemented, matching the spec's own Increment-1A-scoped wording
exactly: **element → hook (`LISTENS_TO`/`FIRED_BY`, via the component's
already-resolved `HANDLED_BY`) OR Settings Field/Section `RENDERED_BY` →
callback symbol → onward through the existing call graph.** Increment 2's
fuller chain (handler → mutation/service call → API endpoint → backend
controller/service → tests) is **not built toward** — no scaffolding, no
placeholder fields for it.

"Onward through the existing call graph" is `getSubgraph(projectName,
handlerSymbolName, 2)` — `src/graph.js`'s own BFS, at its own existing
default depth (2, same as `get_graph`'s own default), completely
unmodified. This is a direct reuse, not a new traversal primitive.

Shape:
```
{
  element_id, kind,
  handler: { via: "hook_handled_by" | "settings_rendered_by", hook: string|null,
             symbol: { name, kind, path, line } } | null,
  call_graph: { root, nodes: [...], edges: [...] } | null,   // getSubgraph()'s own shape, verbatim
  status: "resolved" | "no_handler_found",
}
```

For `ui_settings_section`/`ui_settings_field`: `handler` is the entity's
own `RENDERED_BY` target directly (already resolved by 1A-2/1A-6 — no hook
logic involved for this path). For `ui_element`/`ui_component`: resolves
the owning component, reads its `HANDLED_BY` target (1A-6's own resolution
of 1A-3's `LISTENS_TO` graph — not reimplemented), and best-effort names
the hook via the component's `DEFINED_BY` symbol's `FIRED_BY` links (see
below). No handler resolvable at all (e.g. a component that never fires a
hook) → `status: "no_handler_found"`, `handler: null`, `call_graph: null`
— a real, expected outcome for most components, not an error.

### `find_ui_source` — REQ-013's user-facing `not_relevant` signal

Shape:
```
{
  element_id, kind,
  source: { path, line, component },
  ownership: "application" | "framework" | null,
  application_source: { path, line, component } | null,   // iff ownership === "application"
  not_relevant: { path, line, reason } | null,             // iff ownership === "framework"
  created_via: string | null,   // "submit_button" | "literal_html" | "echo_concat" |
                                 // "add_menu_page" | "add_submenu_page" |
                                 // "add_settings_section" | "add_settings_field" | null
  registered_at: { path, line, symbol } | null,
  entry_hooks: string[],   // hook name(s) this REGISTERED_AT/DEFINED_BY symbol LISTENS_TO
}
```

`created_via` reads `data.extraction` (`ui_element`, mapping
`"wp_primitive"` → the literal string `"submit_button"` since that's the
only WP primitive 1A-2 currently emits as a `ui_element`, per contracts.md
"Phase 1A-2") or `data.registration_fn` (`ui_screen`/settings kinds) — both
already recorded at index time, no new derivation.

`registered_at`/`entry_hooks` resolve the entity's `REGISTERED_AT` target
first (screens/settings kinds), falling back to `DEFINED_BY`
(elements/components, which never have `REGISTERED_AT`) — never both at
once, since a kind only ever has one of the two relations.

**`entry_hooks` uses `LISTENS_TO`, not `FIRED_BY` — the opposite direction
from `get_ui_context`/`trace_ui_action`'s `handled_by` hook naming, and
worth being explicit about since it's easy to get backwards (this phase
did, initially, and caught it before finalizing tests):**
- **`entry_hooks` (`find_ui_source`)** asks "is the registering/owning
  symbol **itself a callback** for some hook?" (e.g. is `boot()`, which
  calls `add_menu_page()`, itself wired to `admin_menu` via
  `add_action('admin_menu', ...)`?) — that's `LISTENS_TO` (`src` = callback
  symbol, `dst` = hook), read via `listensToHooksBySymbol()`.
- **`handled_by`'s hook naming (`get_ui_context`/`trace_ui_action`)** asks
  "does this symbol **fire** a hook that something else listens to?" (e.g.
  does `render_page()` call `do_action('my_plugin_saved')`, which
  `Save_Handler::handle_save` listens to?) — that's `FIRED_BY` (`src` =
  hook, `dst` = firing symbol), read via `firedHooksBySymbol()`.

Both are public (`hook`/`FIRED_BY`/`LISTENS_TO` are 1A-3's own
already-resolved graph, never the internal-only `hook_site`), cheap
(bounded, indexed lookups), and correctly distinct — conflating them was
this phase's own near-miss, documented here so a later phase doesn't
repeat it.

### EDGE-010 — RESOLVED: stay silent

**Decision: no staleness signal of any kind is added to any of the five
operations' output.** `find_ui_source`/`trace_ui_action`'s line numbers
carry exactly the same "the index may be stale relative to the working
tree" hazard `search_code`/`get_symbol`/`get_callers`/every other
line-number-returning operation in this codebase already carries, and none
of them flags it — there is no existing convention (a `stale: boolean`
field, a timestamp, a warning) anywhere in `src/graph.js` or
`src/operations.js` to extend. Adding one only for UI results would be an
isolated, unrequested embellishment inconsistent with the rest of the
query surface, not a fix for a UI-specific problem — the hazard is generic
to "the index runs behind the working tree," not particular to this
feature. If this codebase ever adds a staleness signal, it should be added
uniformly (e.g. a last-indexed timestamp surfaced once, project-wide),
not five times over for UI alone.

### Tests

`test/operations.uiQueries.test.js` (19 tests, real DB, a real
`indexProject()` run over a tmp PHP fixture extending 1A-6's own fixture
pattern with an `add_action('admin_menu', ...)`-wrapped registration
function — needed to exercise `find_ui_source`'s `LISTENS_TO`-based
`entry_hooks`, which 1A-6's own fixture had no coverage for): registry
wiring; `resolve_ui_reference` (task_text resolution + `understood`,
missing-input rejection, unknown-project rejection, framework-owned
`not_relevant`, `not_found` status, `enabled: false` distinctness);
`find_ui_element` (structured-hint-only, missing-text rejection);
`get_ui_context` (full component/screen/handled_by/hook composition for a
real submit_button element; a handler-less element resolving cleanly;
unknown-element_id rejection); `trace_ui_action` (element → hook →
callback → onward call graph, asserting the onward graph actually reaches
the callback's own callee — i.e. `getSubgraph` genuinely ran, not a stub;
settings-field `RENDERED_BY` path; `no_handler_found` as a real non-error
outcome); `find_ui_source` (submit_button `created_via` + registration +
entry hook; `ui_screen`'s `add_menu_page` + `admin_menu` entry hook;
framework-owned `not_relevant`; unknown-element_id rejection). Full suite:
748 tests passing (729 pre-existing + 19 new), 0 failures.

`test/completion.test.js`/`test/fixtures/help.txt` updated (new `ui`
section + 5 `OP_HELP` glosses) as a mechanical consequence of registering
five new operations — see "Wiring" above.

### Storage plane / concurrency

Verified by reading the file: `src/ui/uiQueries.js` contains zero
`INSERT`/`UPDATE`/`DELETE` statements. No schema changes. No new
`entities`/`entity_links` rows of any kind. No new concurrency primitive —
every query is a single `SELECT` (or a small batch of them per operation
call), no transaction, no lock — consistent with every other pure-read
operation already in `src/operations.js`.

### What 1A-9 needs to know

- **Every one of the five operations is exposed and read-only** — REQ-012
  is fully implemented for Increment 1A. `resolve_ui_reference`,
  `find_ui_element`, `get_ui_context`, `trace_ui_action`, `find_ui_source`
  are all reachable by name (and by their `ui-*` CLI aliases) via
  `findOperation()`.
- **`resolve_ui_reference`/`find_ui_element` candidates carry `screens[]`,
  not a singular `screen`** — a deliberate deviation from § 6.2.3's literal
  table (EDGE-006-driven, see above). If 1A-9's AC verification checks the
  literal spec table field-by-field, expect this specific, documented
  divergence rather than treating it as a miss.
- **`handler`/`api`/`styles` are always `null`/`[]`** on
  `resolve_ui_reference`/`find_ui_element` candidates, by design (see
  above) — not a bug, not partial implementation. `trace_ui_action`/
  `get_ui_context` are where the real handler/hook data lives.
- **`status: "ok"` vs `"partial_match"`** uses an unscored 0.15-gap
  threshold (`classifyStatus()` in `src/ui/uiQueries.js`) — this phase's
  own judgment call, not a spec-derived number. If AC verification expects
  specific behavior here, check against this threshold, not an assumption.
- **Authorization is still unaddressed** everywhere in `src/operations.js`,
  not just these five operations — this phase did not introduce a gap
  relative to the rest of the registry, but did not close the spec's own
  NOTE [MISSING] either.
- **EDGE-010 is resolved as "stay silent"** — do not expect (or add,
  without a project-wide reason) a staleness field on these five
  operations' output.
- **`find_ui_source`'s `entry_hooks` uses `LISTENS_TO`;
  `get_ui_context`/`trace_ui_action`'s `handled_by`/`handler.hook` naming
  uses `FIRED_BY`** — opposite relation directions for two conceptually
  different questions (see above). Easy to get backwards; this phase did,
  once, and fixed it before finalizing tests. Worth re-verifying directly
  against `src/ui/uiQueries.js` rather than trusting a paraphrase if AC
  verification touches this.
- **No WordPress fixture project exists in this repo** beyond this phase's
  own small synthetic tmp-dir fixture (and 1A-6's, which this phase's test
  file extends with an `admin_menu`-registered `boot()`) — the
  "Pending cross-phase decisions" item asking for a real WP fixture is
  still open, explicitly reserved for 1A-9.

## Phase 1A-9 — Increment 1A hardening/verification (2026-09-03)

STATUS: DONE. Verifies AC-001 through AC-014, AC-018, AC-019 against real,
indexed projects (no mocking). Found and fixed two real, narrowly-scoped
bugs (below); found and documented one real, non-bug spec-level tension
(the REQ-010/Q-005 floor/weight interaction). Escalated nothing — the Gate
re-check found no dimension had moved to "high" after Locate (see
`context/phase-1A-9/plan.md`).

### Fixture: `test/fixtures/wordpress-ui/` — finished, not rebuilt

A previous, interrupted dispatch of this phase had already built six of the
eight files, correctly and coherently (verified by reading every file's
actual PHP content, not trusting its doc comment). This phase finished it
rather than starting over:

```
test/fixtures/wordpress-ui/
  wp-content/plugins/waycontext/waycontext.php              AC-001, AC-002, AC-004
  wp-content/plugins/waycontext/includes/members-screen.php AC-005
  wp-content/plugins/waycontext/includes/settings.php       AC-006
  wp-content/plugins/waycontext/includes/malformed.php      AC-012 (added by 1A-9)
  wp-content/plugins/waycontext/languages/waycontext-vi.po  AC-003 (added by 1A-9)
  wp-content/plugins/cart-plugin/cart-plugin.php            AC-011 (callback side)
  wp-content/themes/storefront/functions.php                AC-011 (firing side)
  wp-includes/core-widgets.php                               REQ-013 framework-owned
```

This is the fixture **1B-3 should reuse** for its own AC-015/016/017
regression checks, rather than building a second one — add shortcode/block
fixture files alongside the existing plugin/theme structure rather than a
parallel project.

**One fixture bug found and fixed**: `members-screen.php`'s submenu was
originally registered under slug `waycontext-members` (the previous
dispatch's own choice). 1A-7's route signal (`textSimilarity` against each
screen's joined `route|menu_slug|page_title|menu_title`) scores via
substring containment, and `waycontext-members` contains the top-level
`waycontext` slug as a literal prefix — so a `screen: "WayContext"` hint
meant to isolate the top-level screen for AC-005's own disambiguation test
scored *identically* (via containment, not exact match) against the
*other* screen too, defeating the test. Changed the slug to `wc-members`.
Not a system bug — a fixture-naming collision with 1A-7's own documented
containment-scoring behavior. 1B-3/anyone adding more screens to this
fixture should keep new slugs from prefix-colliding with `waycontext`.

**AC-012's fixture, and why it isn't the obvious "malformed PHP" choice**:
the natural first idea — an unreasonably long `.`-concatenation chain
inside an `echo` (to overflow `phpElements.js`'s `reconstructEchoProbe()`
recursive walk, EDGE-009) — was tried first and **rejected after testing**:
it also overflows `src/parser.js`'s own generic recursive AST walk (which
also visits arbitrarily-deep `binary_expression` trees for the ordinary
code index), so `parseFile()` itself throws and the *whole file* fails
(`stats.failed++`, `continue`) before any UI adapter even runs — this
would have demonstrated the wrong thing (a pre-existing, general parser
limitation unrelated to UI Intelligence, out of this phase's scope) rather
than AC-012's actual claim (isolated per-adapter failure). Verified
empirically (`parseFile("php", ...)` on the same content throws
`RangeError: Maximum call stack size exceeded` regardless of whether the
chain sits in an echo, a plain assignment, a `return`, or a function-call
argument — it's generic, not UI-specific).

The fixture that actually works: **~4,000 levels of nested `<div>` tags
inside literal PHP-emitted HTML** (`malformed.php`). This overflows
`phpElements.js`'s own **second, independent** tree-sitter-html sub-parse
(`extractFromFragment()`'s `getHtmlParser().parse(fragment)`), which throws
`Error: Invalid argument` from the native `tree-sitter` binding at this
input size/depth — while the base tree-sitter-php parse succeeds normally,
because it never recurses into the literal-HTML blob at all (it's one
opaque `text` node to the PHP grammar). Verified end-to-end via a real
`indexProject()` run: `stats.failed === 0`, the file's own ordinary symbol
(`render_broken()`) indexes normally, and exactly one log line appears:
`UI adapter "phpElements" extraction skipped for
wp-content/plugins/waycontext/includes/malformed.php: Error: Invalid
argument` — naming the adapter, the file, the error class, and the message,
exactly as AC-012 and the pre-existing per-file try/catch in
`src/indexer.js` (lines ~328-390, unchanged by this phase — it already had
this per-file isolation for all five UI adapters before this phase
started) require.

**Left in the shared fixture deliberately** (not a disposable one-off): a
real, standing regression guard for adapter-failure isolation on every
future index of this project. 1B-3, if it indexes this same fixture for
its own AC-015/016/017 checks, will see this exact log line every time —
expected, not a new failure.

### Bug #1 (fixed): identity-preflight backfill couldn't unblock
`LISTENS_TO`/`FIRED_BY`/`HANDLED_BY` within the same `index_project` run

**What AC-018 requires**: "`backfillProjectIdentity` runs at most once...
before the UI relation post-pass... And `DEFINED_BY`/`HANDLED_BY` links
depending on the previously-NULL `entity_id` resolve normally afterward" —
all within one `index_project` call (the AC's own `Given/When/Then` is a
single-run scenario).

**What was actually true before this phase**: `resolveHookGraph()` (1A-3)
and `resolveI18nGraph()` (1A-4) ran in `runIndex()` **before**
`reconcileIdentity()`/the identity preflight (1A-5) — a pipeline position
established by 1A-3/1A-4 before 1A-5 even existed, and never revisited
since (1A-5's own contracts.md note already flagged that these two
post-passes are *not* "after `reconcileIdentity()`" the way the phase
brief assumed, but didn't re-examine what runs *before* them). Both
`LISTENS_TO` and `TRANSLATION_USED_AT` resolution require
`symbols.entity_id IS NOT NULL` on their target. For a symbol in a file
**reprocessed this run**, `entity_id` is always already set by the normal
per-file symbol-write step, so order relative to identity preflight never
mattered in the common case. But for a symbol in a file **not reprocessed
this run** (unchanged hash) whose `entity_id` predates the identity plane,
the *only* thing that can set it is the identity preflight's project-wide
`backfillProjectIdentity()` call — which ran **after** `resolveHookGraph()`/
`resolveI18nGraph()` had already finished. So a same-run backfill success
could never be reflected in that run's own `LISTENS_TO`/`FIRED_BY`
(and therefore `HANDLED_BY`, which reuses `LISTENS_TO` — 1A-6's own design)
— only on the *following* run.

**Reproduced for real** (not just reasoned about) before fixing: indexed a
component whose fired hook is listened to by a symbol in another file;
NULLed that listener symbol's `entity_id` (simulating a legacy/unreprocessed
symbol) while leaving its `symbol_key` valid; re-ran `index_project`.
Confirmed `identityPreflight.backfillRan === true` and `.complete === true`
(the backfill genuinely succeeded), yet `HANDLED_BY` had **0** rows for the
firing component — the bug, reproduced.

**Fix**: moved the `resolveHookGraph()`/`resolveI18nGraph()` call sites in
`runIndex()` (`src/indexer.js`) to run **after** `reconcileIdentity()` and
the identity preflight, immediately before `resolveUiRelations()` — no
change to either function's own internals, gating, or try/catch, only
where in the pipeline they're invoked. After the fix, the same reproduction
shows `HANDLED_BY` resolving with **1** row, in the same run, pointing at
the now-relinked symbol's `entity_id`. Full 765-test suite (748 pre-existing
+ 17 new) passes, run twice for stability — no other test depended on the
old ordering.

**Pipeline order in `runIndex()`, current and final** (re-verify by
searching for these call sites directly if building on this — line numbers
drift):
```
per-file loop (symbols/edges/UI-adapter staging writes)
  -> edges resolution (namespace/method-suffix passes)
  -> doc -> symbol mention resolution (if config.docsEnabled)
  -> reconcileIdentity()
  -> identity preflight (1A-5, if config.uiEnabled)
  -> resolveHookGraph() (1A-3, if config.uiEnabled)        <- moved here by 1A-9
  -> resolveI18nGraph() (1A-4, if config.uiEnabled)        <- moved here by 1A-9
  -> resolveUiRelations() (1A-6, if config.uiEnabled)
  -> git history / docs embedding / rules / derived-intelligence
```
**1B-1/1B-2/anyone touching `runIndex()`'s post-file-loop sequence**: hook
graph and i18n graph resolution are no longer "right after edges
resolution" — they're right before the UI relation post-pass now. If you
add a new project-wide post-pass that also joins against
`symbols.entity_id`, put it after the identity preflight too, for the same
reason.

### Bug #2 (fixed): AC-007's own worked example didn't extract a `problem_type`

The spec's own canonical AC-007 task text — "...is badly positioned on
mobile" — matched none of 1A-7's `PROBLEM_TYPE_PATTERNS`
(`src/ui/referenceResolver.js`), so `queryFields.problem_type` came back
`null` for the spec's own example. Added `\bposition(?:ed|ing)?\b` to the
existing `styling` pattern (already covers `misaligned`/`overlap`/`layout`)
— a one-line addition to an already-non-exhaustive, already-documented
regex table, not a new mechanism. Verified: `problem_type` now resolves to
`"styling"` for AC-007's exact text; all 17 pre-existing
`test/ui.referenceResolver.test.js` tests still pass unchanged (none of
them exercised the word "position").

### Non-bug finding (documented, not fixed): the REQ-010/Q-005 floor/weight
interaction blocks AC-002/AC-003's own literal `find_ui_element(text)` calls

Spec decision Q-005 (spec.md L1683-1685) fixes both the floor (0.45) and
the weights (text 0.40, route 0.30, role 0.20, context 0.10) — 1A-7 already
flagged in its own contracts.md note that "a candidate can never cross the
floor on an exact text match alone... not a bug." This phase confirms that
consequence lands directly on two of the spec's own worked acceptance
criteria: **AC-002** ("`find_ui_element` is called with text 'Sync
members'") and **AC-003** ("`find_ui_element` is called with text 'Đồng bộ
thành viên'") both call `find_ui_element` with **only** the `text`
argument — no `screen`, no `role`. A bare exact-text match scores exactly
`0.40` (`1.0 * SIGNAL_WEIGHTS.text`), strictly below `MIN_MATCH_SCORE`
(0.45), so **`find_ui_element(text)` alone, with no corroborating hint, can
never return a single candidate — for any project, any text, no matter how
exact the match.** Verified directly: `findUiElementOp(PROJECT, "Sync
members")` with no screen returns `candidates: []`.

This is a genuine tension in the spec's own text (its own worked ACs assume
a capability its own fixed scoring formula cannot deliver), not an
implementation bug in 1A-7/1A-8 — the floor and every weight are
individually spec-fixed, already load-bearing for ~36 passing 1A-7/1A-8
tests, and not this hardening phase's to retune. **Not fixed.** This
phase's own AC-002/AC-003 tests demonstrate the real underlying
capabilities (aria-label-tier matching; catalog-translated-text matching)
by adding the one corroborating hint each scenario has naturally available
(the element's own screen) — the same workaround 1A-8's own
`test/operations.uiQueries.test.js` already had to use for an analogous
case (adding a `role` hint to its framework-owned-candidate test). **1B-1/
a human**: if `find_ui_element`/`resolve_ui_reference` ever need to support
a genuinely bare, single-signal exact-text lookup, that requires revisiting
Q-005's fixed floor/weights (e.g., a floor lower than the max single-signal
weight, or a "single strong signal" exemption) — out of this phase's scope
to decide unilaterally.

### AC-by-AC verification table

| AC | Result | Notes |
|---|---|---|
| AC-001 | PASS | `data.type` (computed classification) is `"button"`; `data.role` (raw `role=` attribute) is `null` — `submit_button()` sets no explicit ARIA role. `i18n_key` carries the authored msgid `"Sync members"`; `data.text` itself is legitimately upgraded to the `.po` translation (see AC-003) — checked ownership `"application"`, path, line. |
| AC-002 | PASS (with a documented caveat) | Aria-label-tier matching genuinely works; a bare `find_ui_element(text)` call can't surface it (floor/weight finding above) — verified with a `screen` hint. |
| AC-003 | PASS (same caveat) | Catalog-resolved candidate exposes `i18n.{msgid,textdomain,resolved_text,catalog_source}` exactly as required. |
| AC-004 | PASS | Exact literal match on every field REQ-017/AC-004 name. |
| AC-005 | PASS | After the fixture slug fix above; top candidate correctly differs per screen hint. |
| AC-006 | PASS | `trace_ui_action` + `find_ui_source` both resolve correctly; onward call graph genuinely reaches `render_api_key()`'s own callee. |
| AC-007 | PASS (after Bug #2 fix) | All 5 `understood` keys present; `visible_text` stays `null` for this exact unquoted sentence — a real, documented, non-exhaustive-heuristic characteristic (Q-009), not a bug. |
| AC-008 | PASS | No LLM/outbound-call code exists in `referenceResolver.js` (grepped); every candidate's `source.path`/`source.line` verified byte-for-byte against the entity's own stored `data`. |
| AC-009 | PASS | Ranked descending, capped at 5, all `>= 0.45`, `evidence[]` non-empty, `text_source` present, `confidence` field absent. |
| AC-010 | PASS | Verified via a real in-process MCP `Client`/`Server` pair over `InMemoryTransport` (not just a registry-array check) — all five tools present in a live `listTools()` response. |
| AC-011 | PASS | `trace_ui_action` on the theme's element resolves `handler.symbol.path` to the *other* plugin's file. |
| AC-012 | PASS (fixture redesigned, see above) | Isolated per-adapter crash, real and reproducible; rest of project/file unaffected. |
| AC-013 | PASS | Dedicated no-UI PHP project: `ui_elements = 0`, no UI-related warning/error, ordinary symbols still index. |
| AC-014 | PASS | Checked both directly (entity `natural_key` before/after re-index) and via `find_ui_element` (with a screen hint, same floor/weight reasoning as AC-002). |
| AC-018 | PASS (after Bug #1 fix) | `backfillProjectIdentity` ran exactly once, before `resolveUiRelations()`; `HANDLED_BY` now resolves in the same run. |
| AC-019 | PASS | Backfill failure (real collision, not mocked): code index + UI entities complete, `DEFINED_BY` marked `unresolved` (no fabricated link), `UI_IDENTITY_INCOMPLETE` present with all 5 required keys. |
| § 15 regression: `test/parser.test.js:154-161` | PASS | Line numbers unchanged, still exact. |
| § 15 regression: `project_overview`/`get_callers`/`get_callees` | PASS | Output shape unaffected — both read only `files`/`symbols`/`edges`, never touch `entities`/`entity_links` (storage-plane isolation holds by construction, confirmed by reading `src/graph.js` and running them against the UI-populated fixture). |

### Files changed by this phase

- `src/indexer.js` — pipeline reorder (Bug #1 fix, see above). No schema,
  no new config, no new relation/entity kind.
- `src/ui/referenceResolver.js` — one regex alternation added to
  `PROBLEM_TYPE_PATTERNS` (Bug #2 fix).
- `test/fixtures/wordpress-ui/` — finished (added `languages/waycontext-vi.po`,
  `includes/malformed.php`; fixed `members-screen.php`'s submenu slug).
- `test/uiIntelligence.acceptance.test.js` — new, 17 tests (one per AC
  above, plus the combined § 15 regression check).

No new `entities`/`entity_links` kinds, relations, or MCP operations —
this was a verification/hardening phase, per its own scope.

### What 1B-1 needs to know

- The pipeline order in `runIndex()` has changed since 1A-6's own
  contracts.md section was written (`resolveHookGraph()`/`resolveI18nGraph()`
  moved after the identity preflight) — re-verify fresh against
  `src/indexer.js` rather than trusting 1A-3/1A-4/1A-5/1A-6's own call-order
  prose, all of which now describes the *pre-1A-9* order. See "Pipeline
  order in `runIndex()`, current and final" above.
- `test/fixtures/wordpress-ui/` is the shared fixture project — reuse it
  (1B-1's shortcode work, 1B-2's block work, 1B-3's regression checks)
  rather than building a new one. It already contains a deliberately-broken
  file (`includes/malformed.php`) that always logs one
  `UI adapter "phpElements" extraction skipped` line on every index — this
  is expected, not a signal something is newly broken.
- The REQ-010/Q-005 floor/weight tension (above) applies equally to any
  future search-style operation that scores a single signal alone — keep it
  in mind if 1B-1/1B-2 add their own `find_*`-style lookups reusing
  `scoreCandidate()`.
- Everything else in 1A-1 through 1A-8's own contracts.md sections was
  verified accurate as documented; no other correction needed.

## Phase 1B-1 — Shortcode recognition (2026-09-03)

STATUS: DONE. Implements REQ-023 for Increment 1B. Resolves AC-015.

### `src/ui/phpShortcodes.js` — sixth sibling PHP extractor

Same pattern as `phpHooks.js`/`phpI18nCalls.js`/`phpSettingsRender.js`:
independent tree-sitter-php walk, pure/DB-free, `stripQuotes`/
`resolveCallable`/`positionalArgs` duplicated locally rather than imported
(module-boundary precedent, contracts.md "Phase 1A-2"/"Phase 1A-3").
`extractPhpShortcodes(source) -> {tag, callback, owner, line}[]`.

- Recognizes **only** `add_shortcode(tag, callback)` — deliberately NOT
  `do_shortcode()`. REQ-023's own text names no "firing" side the way
  REQ-014 named both `add_action`/`do_action` for hooks; inventing one would
  be scope creep. Confirmed by test
  (`test/ui.phpShortcodes.test.js`: "do_shortcode() is not recognized").
- `tag` is literal-string-only (identical rule to `phpHooks.js`'s
  `literalHookName()`): a call site whose tag argument isn't a literal is
  skipped entirely — no entity, no relation for that call site (REQ-026's
  spirit).
- `callback` resolved via the same `resolveCallable()` rule set as every
  other sibling extractor (`'literal_name'`, `array($this,'method')` inside
  a class body, `array(__CLASS__,'method')`, `array('LiteralClass',
  'method')`; anything else -> `null`, never fabricated).
- Deliberately NOT `src/parser.js`'s `WP_REGISTER` set, which already
  recognizes `add_shortcode` under the generic `REGISTERS_HOOK` edge
  relation (conflating hooks and shortcodes — the exact reason 1A-3 left
  `add_shortcode` out of `phpHooks.js`, contracts.md "Phase 1A-3"). This
  phase builds the new, correct `entities`/`entity_links`-plane `shortcode`
  graph from scratch; `src/parser.js`/the old `edges`
  `REGISTERS_HOOK`/`dst_name = "hook:<tag>"` pseudo-target is completely
  untouched (confirmed: `src/parser.js` was not modified at all, and the
  full pre-existing 765-test suite passes unchanged).

### `shortcode` entity — `kind = 'shortcode'` (generic, no `ui_` prefix, per REQ-025/Q-018/D-UI-018)

**Keyed project-wide by tag, not per call site — follows `hook`'s
precedent (contracts.md "Phase 1A-3"), not the per-callsite
`ui:<project>:php:<path>:<owner>:<fingerprint>` format every `ui_*` kind
uses.** WordPress allows only one callback per shortcode tag (a second
`add_shortcode()` call for the same tag simply overwrites the first at
runtime), so a shortcode tag is one shared concept referenced by every file
that registers it — exactly `hook`'s own reasoning. 1B-2/anyone building on
this: do not expect a `shortcode` entity's `natural_key` to embed a source
path, line, or owner.

`natural_key = shortcode:<project_name>:<tag>`. `title = tag`. `data` (all
fields always present):
```
{ shortcode_id, tag, framework: "php" }
```
`shortcode_id` = `natural_key`, self-describing, same convention as
`hook_id`/`element_id`/etc.

Lifecycle: upserted whenever any live `shortcode_site` (see below)
references its tag; tombstoned once no live `shortcode_site` references it
anymore — same "whole-project liveness, not one file's tombstone pass"
treatment as `hook`.

### `shortcode_site` — internal-only staging entity, NOT spec-facing

`kind = 'shortcode_site'`, same status as `hook_site`/`i18n_call_site`/
`settings_render_site` — not one of REQ-025's fixed `entities.kind` values,
never returned by any MCP operation. Exists purely so
`resolveShortcodeGraph()` can see every file's shortcode call sites (and
resolve the entity's own project-wide lifecycle) without re-parsing PHP
source on every `index_project` run.

One row per `add_shortcode()` call site. `natural_key =
shortcodesite:<project_name>:php:<source_path>:<owner>:<fingerprint>` (same
per-callsite content-hash convention as `hook_site`/`i18n_call_site`).
`data: {source_path, owner, line, tag, callback}`. Same
tombstone-then-upsert-by-`source_path` lifecycle as its siblings;
`dropFile()`'s tombstone list now includes it too.

### `REGISTERED_AT` / `RENDERED_BY` — same-file-only, a deliberate divergence from `hook`'s `LISTENS_TO`

**Design decision, made explicitly per the orchestrator's brief and
verified against the real `resolveHookGraph()` SQL rather than assumed**:
unlike `hook`'s `LISTENS_TO` (project-wide, exact-`symbols.name` match, per
EDGE-012's explicit cross-file requirement), `shortcode`'s
`REGISTERED_AT`/`RENDERED_BY` resolve **same-file only** — following 1A-2's
precedent for these exact two relation names (`ui_screen`/
`ui_settings_section`/`ui_settings_field`'s own `REGISTERED_AT`/
`RENDERED_BY`), not 1A-3's `LISTENS_TO` precedent.

Reasoning: REQ-023's own text and AC-015's own worked example
(`add_shortcode('members', 'render_members')`) name no cross-file scenario,
unlike EDGE-012 which explicitly named a cross-plugin hook-handling case
that drove `LISTENS_TO`'s project-wide scope. A shortcode's registration
call and its render callback are overwhelmingly declared in the same file
in real WordPress plugin code (unlike settings sections/fields, commonly
split across an `admin_init` registration file and a separate render-time
file — the exact reason 1A-6 needed `settings_render_site` for a
project-wide correlation). No spec text or WP convention was found
suggesting a cross-file shortcode-callback pattern is common enough to
justify the added complexity/ambiguity a project-wide unique-match join
would introduce.

Implemented in `resolveShortcodeGraph(project, log)` (`src/indexer.js`), a
project-wide post-pass structurally mirroring `resolveHookGraph()` — but its
`REGISTERED_AT`/`RENDERED_BY` INSERT queries mirror `resolveHookGraph()`'s
own **`FIRED_BY`** SQL shape specifically (join through `files f ON f.path =
scs.data->>'source_path'` then `symbols sym ON sym.file_id = f.id`), **not**
its `LISTENS_TO` shape (project-wide, no file join, "only unique matches"
discipline) — that discipline doesn't apply here since each call site's
owner/callback resolution is already unambiguous once scoped to its own
file. When nothing matches in-file (the owner/callback name isn't a symbol
in that same file, the owner is the `"@file"` sentinel, or `callback` is
`null`), no relation is written — REQ-026/Q-018's no-fabrication rule, same
as everywhere else in this feature. Verified end-to-end by test
(`test/indexer.uiShortcodes.test.js`, cross-file case): a shortcode whose
`add_shortcode()` call and render callback sit in different files gets
`REGISTERED_AT` (same file as the call) but explicitly NOT `RENDERED_BY`.

Both relations are recomputed in full on every run (delete existing
`REGISTERED_AT`/`RENDERED_BY` touching this project's `shortcode` entities,
then reinsert), same cost/simplicity tradeoff `resolveHookGraph()` already
made and documented.

### Why a project-wide post-pass is still needed despite same-file-only relations

A shortcode entity being project-wide-keyed by tag (not per callsite) means
its own upsert/tombstone lifecycle needs to see every file's live call
sites at once — it cannot be a pure per-file write the way `ui_screen`/
`ui_settings_section` are (contracts.md "Phase 1A-2": tombstone-by-
`data->>'source_path'` only works when the entity itself belongs to one
file). This is the "hybrid" the orchestrator's brief flagged as the likely
right call: entity lifecycle needs `hook`'s project-wide staging-entity +
post-pass mechanism, but relation *resolution* stays same-file-only like
1A-2's simpler precedent — the post-pass exists for the former, not because
the latter needed it.

### Pipeline position

`resolveShortcodeGraph()` is called in `runIndex()` (`src/indexer.js`)
right after `resolveI18nGraph()`, before `resolveUiRelations()` — i.e. in
the same "project-wide post-pass" slot `resolveHookGraph()`/
`resolveI18nGraph()` occupy, **after** the identity preflight. This was a
deliberate choice, not an accident: 1A-9's own contracts.md section (Bug #1)
documents that any project-wide post-pass joining against
`symbols.entity_id` must run after the identity preflight, or a same-run
identity backfill can't be reflected in that run's own relations. Verified
fresh against `src/indexer.js` directly (per 1A-9's own warning not to trust
older phase notes about call order) rather than assumed from an earlier
phase's prose.

### Storage plane / concurrency

Verified by test: only `entities` (`kind IN ('shortcode', 'shortcode_site')`)
and `entity_links` (`relation IN ('REGISTERED_AT', 'RENDERED_BY')`) are
touched; `symbols`/`edges` untouched (verified by test, and by the full
pre-existing 765-test suite passing unchanged). `src/parser.js` was not
modified at all. Concurrency: no new primitive — runs inside the same
per-project `pg_advisory_lock(project.id)` every other project-wide pass
already relies on; the new per-file `shortcode_site` write runs inside the
same per-file transaction the other five PHP UI extractors already use.
`runIndex()`'s returned stats object gained a `shortcodes` field (`{
shortcodeCount, registeredAt, renderedBy }`, or `{error}`, or `null` when
`config.uiEnabled` is false), alongside the pre-existing `hooks`/`i18n`
fields.

### Config

No new config flag — reuses `config.uiEnabled` (`UI_ENABLED`) exactly as
every prior UI phase gated its own work; `lang === "php"` per-file gate
unchanged.

### Fixture

`test/fixtures/wordpress-ui/wp-content/plugins/waycontext/includes/members-screen.php`
(reused per 1A-9's own instruction, not a new fixture project) now also
carries AC-015's own worked example almost verbatim:
`add_shortcode('members', 'render_members')`, wrapped in a named
`waycontext_register_shortcodes()` function (registered via
`add_action('init', ...)`) so `REGISTERED_AT` resolves to a real symbol
rather than the `"@file"` sentinel — same reasoning
`waycontext_register_members_menu()`/`add_action('admin_menu', ...)` already
establishes in this same file for `add_menu_page()`. `render_members()`
returns a plain string (no `submit_button()`/UI-element call inside it) —
deliberately kept minimal so this fixture addition doesn't introduce
unrelated `ui_element`/`ui_component` churn into the shared fixture other
ACs already depend on.

### Tests

`test/ui.phpShortcodes.test.js` (7 tests, pure extractor unit tests, no
DB). `test/indexer.uiShortcodes.test.js` (6 tests, real-DB end-to-end, no
mocking): AC-015's own worked example end-to-end; orphan callback (not in
the indexed project) gets no `RENDERED_BY`, never a placeholder (REQ-026);
same-file-only scope proven directly (a cross-file callback resolves
`REGISTERED_AT` but not `RENDERED_BY`); storage-plane isolation;
tombstone/restore lifecycle; `config.uiEnabled = false` full skip.
`test/uiIntelligence.acceptance.test.js` (+1 test, AC-015 against the shared
`wp_ui_fixture` project). Full suite: **779 tests passing (765 pre-existing
+ 14 new), 0 failures**.

### What 1B-2 needs to know

- `resolution_status`/generic-kind naming precedent (`kind = 'block'`, no
  `ui_` prefix) applies identically to your own work per REQ-024/Q-018 — see
  "Fixed by the spec" at the top of this file.
- **Re-examine the entity-keying question fresh for `block` rather than
  assuming this phase's "project-wide by tag" answer transfers.** A
  Gutenberg block is registered by `register_block_type()` naming a
  `block.json` file (or an inline args array) — unlike a shortcode tag,
  which is purely a runtime-registration fact with no accompanying file, a
  block's identity is arguably **already** file-scoped via `block.json`
  itself (REQ-024 also names a `DEFINED_IN` relation to `block.json`, which
  no `shortcode` relation has an analog for). Whether `block`'s
  `natural_key` should mirror `hook`/`shortcode`'s project-wide-by-name
  convention or something closer to `block.json`'s own path is this phase's
  own judgment call to make, not something to inherit unexamined from here.
- If you need the same "project-wide entity lifecycle + same-file-only (or
  otherwise scoped) relation resolution" hybrid this phase used, the
  pattern is: a per-callsite staging entity (this phase's `shortcode_site`)
  written per-file, plus a project-wide post-pass
  (`resolveShortcodeGraph()`) that both materializes/tombstones the shared
  entity AND writes the relations — reuse this shape rather than inventing
  a third one, but only if `block`'s own keying question (above) actually
  lands on "project-wide by name."
- `resolveShortcodeGraph()`'s call-site position (`src/indexer.js`, right
  after `resolveI18nGraph()`, before `resolveUiRelations()`, after the
  identity preflight) is the established slot for any further project-wide
  post-pass that joins `symbols.entity_id` — reuse it rather than
  re-deriving the ordering constraint from 1A-9's Bug #1 note again.
- No MCP operation exposes `shortcode` entities yet (out of scope for this
  phase, confirmed against REQ-023's own text — it names no query-surface
  requirement). If `block` has the same gap, that's a decision for 1B-2 or a
  later phase to make explicitly, not to inherit silently.

## Phase 1B-2 — Gutenberg static block registration (2026-09-03)

STATUS: DONE. Implements REQ-024 for Increment 1B. Resolves AC-016. Resolves
AC-017 by verification (no new writer added — see below). Resolves EDGE-014's
"static registration only" half; the persisted-instance half stays out of
scope, as REQ-024/EDGE-014 both require.

### `block` entity keying — RESOLVED: project-wide by namespace, not per callsite

1B-1 deliberately left this open ("re-examine fresh for `block`"). Decision:
**project-wide by namespace** (block.json's own `name` field, e.g.
`"waycontext/pricing"`), following `hook`/`shortcode`'s precedent — **not**
the per-callsite `ui:<project>:php:<path>:<owner>:<fingerprint>` format every
`ui_*` kind uses. Reasoning: WordPress's own block registry is
namespace-unique at runtime (registering the same namespace twice simply
overwrites the first registration) — the identical "one canonical
registration, referenced by name, not by call site" shape a shortcode tag
already has, explicitly confirmed by the orchestrator's own brief before
this phase started. `natural_key = block:<project_name>:<namespace>`,
`title = block.json's title, or the namespace if absent`. `data` (all fields
always present):
```
{ block_id, namespace, title, category, textdomain, framework: "php" }
```
`block_id` = `natural_key`, self-describing, same convention as
`shortcode_id`/`hook_id`/etc. `title`/`category`/`textdomain` are carried
through from **one arbitrary contributing `block_site`** when more than one
live call site references the same namespace (a `DISTINCT ON` +
deterministic-but-arbitrary `id DESC` tiebreak) — a documented limitation,
not a design gap: the namespace identity itself is never ambiguous, only
which block.json's *metadata* wins in the unusual case of two different
block.json files declaring the same namespace.

### `DEFINED_IN`'s target — RESOLVED: a new `block_manifest` entity representing block.json itself

`entity_links.dst_id` is `NOT NULL REFERENCES entities(id)`
(`src/migrations/0006_identity_and_history.sql:75-85`) — there is no
mechanism anywhere in this schema to link to a raw file path. Two readings
were considered:
1. Skip writing an actual `entity_links` row for `DEFINED_IN`, keeping only
   `block.json`'s path as informational data on the `block` entity.
   Rejected: REQ-024's own text and AC-016's own worked example both name a
   `DEFINED_IN` *relation*, not a data field — downgrading it would leave
   REQ-024 only partially implemented for no real complexity savings.
2. **Give `block.json` an entity of its own, so `DEFINED_IN` can be a real
   relation.** Chosen. This is not a new idea in this codebase:
   `entities(kind='document')` (`src/migrations/0007_documents.sql`) is the
   existing, already-shipped precedent for exactly this situation — that
   migration's own doc comment explicitly frames it as an exception ("a
   file is not an entity in this schema, so the only available link target
   would be every symbol in the file... `documents` is the deliberate
   exception"). `block_manifest` mirrors that exception at a much lighter
   weight — no chunking, no embeddings, no `docsEnabled` gate, no `doc_type`
   classification — since block.json is plain JSON metadata, not
   ADR/README/guide prose.

`kind = 'block_manifest'` — **generic, no `ui_` prefix**, same reasoning
`document` itself gets (a JSON metadata file isn't "inherently about a
rendered UI surface" any more than a markdown file is; REQ-025's fixed
prefixed list — `ui_screen`/`ui_component`/`ui_element`/`ui_text`/
`ui_settings_section`/`ui_settings_field` — has no file-representing member
at all). **Keyed project-wide by path**, not per callsite (mirrors
`document`'s own `(project_id, path)` identity): `natural_key =
block_manifest:<project_name>:<path>`, `title = path`. `data`:
```
{ block_manifest_id, path, framework: "php" }
```
1B-3/anyone building on this: `block_manifest` is, like `hook_site`/
`i18n_call_site`/`settings_render_site`/`shortcode_site`, **not** one of
REQ-025's fixed spec-facing kinds and **not** internal-only either — it sits
in a third category of its own (a real, durable, generic entity that exists
*only* so `DEFINED_IN` has somewhere to point; nothing else references it,
and no MCP operation exposes it yet — same "not wired to any query surface"
status `block`/`shortcode`/`hook` themselves currently have, see below).

### `block_site` — internal-only staging entity, NOT spec-facing

`kind = 'block_site'`, same status as `hook_site`/`i18n_call_site`/
`settings_render_site`/`shortcode_site`: never returned by any MCP
operation, not part of REQ-025's fixed `entities.kind` list. One row per
`register_block_type()` call site **whose block.json actually resolved** —
unlike every prior staging-entity sibling, this one requires a successful
*second-file* read (see below) before a row is even written; a call site
whose block.json can't be found/parsed produces no `block_site` row at all,
same "no fabrication" treatment `phpShortcodes.js`'s unresolvable-tag case
already gets. `natural_key =
blocksite:<project_name>:php:<source_path>:<owner>:<fingerprint>` (same
per-callsite content-hash convention as its four siblings). `data`:
```
{
  source_path, owner, line,
  namespace, title, category, textdomain,  // from block.json
  block_json_path,                          // project-root-relative
  render_callback,                          // resolveCallable()'s output, or null
}
```
Same tombstone-then-upsert-by-`source_path` lifecycle as its siblings;
`dropFile()`'s tombstone list now includes it too.

### Resolving block.json: the one filesystem read in this feature that isn't the file already being parsed

Every prior sibling PHP extractor (`phpElements.js` through
`phpShortcodes.js`) is pure and DB-free, reading only the one PHP source
string already handed to it. `phpBlocks.js` follows the same discipline —
`extractPhpBlocks(source)` resolves `register_block_type()`'s first argument
down to a literal **path fragment** only (a bare string literal, `__DIR__`
alone resolving to the empty-string fragment, or `.`-concatenation of the
two — anything else, e.g. `plugin_dir_path(__FILE__) . 'build'`, is
unresolvable and the call site is skipped entirely, no partial
reconstruction, same rule `phpShortcodes.js`'s `literalTag()` already
applies to a shortcode tag). It never touches a filesystem and never knows
its own file's path.

Turning that fragment into an actual `block.json` read is `src/indexer.js`'s
job (`writeUiBlockSites()`), via a new module, **`src/ui/blockManifest.js`**
(`readBlockManifest(absolutePath) -> {name, title, category, textdomain} |
null`) — same "no module-level cache, fresh read every call" discipline
`i18nCatalog.js`'s `discoverCatalogs()` already established for this
feature's other on-disk metadata source (contracts.md "Phase 1A-4"). A
missing file, invalid JSON, or a missing/non-string `name` field all return
`null`, never throw — the per-file try/catch around `extractPhpBlocks()`
itself still exists for a genuine parser crash, but a merely-absent
block.json is an ordinary, expected outcome, not an adapter failure.

Path resolution (`writeUiBlockSites()`): the call site's file directory
(`path.posix.dirname(rel)`) joined with the resolved `dirArg` fragment,
normalized; if the joined path already ends in `.json` it's used directly
as the block.json path (covers `register_block_type(__DIR__ .
'/build/block.json', ...)`), otherwise `/block.json` is appended (covers
AC-16's own directory form).

**Security note — a new filesystem-read surface, mitigated, not a design
gap.** This is the one place in the whole UI Intelligence feature where
parsed *source text* drives a read of a *second* file rather than data
already sitting in a table. A crafted `dirArg` (e.g. many `../` segments)
could otherwise walk the resolved path outside the project root. Mitigation:
after normalizing, a call site whose resolved `block.json` path starts with
`../` is skipped entirely — no `block_site` row, same treatment as a
missing file. Verified end-to-end by test (`test/indexer.uiBlocks.test.js`,
"root-boundary check"): a real, valid `block.json` was placed **outside**
the project root at the exact resolved target and confirmed **never read**,
proving the check actually fires rather than merely coinciding with a
missing file. This was flagged and re-scored at Gate time (plan.md) and
judged a contained, cheap mitigation — not grounds to escalate.

### `DEFINED_IN` / `RENDERED_BY` resolution (`resolveBlockGraph()`)

Both recomputed in full on every run (delete existing `DEFINED_IN`/
`RENDERED_BY` touching this project's `block` entities, then reinsert) —
same cost/simplicity tradeoff `resolveHookGraph()`/`resolveShortcodeGraph()`
already made and documented.

- **`DEFINED_IN`** (`block -> block_manifest`): **project-wide**, but
  "unique match only" — a namespace links to its block_manifest only when
  every live `block_site` referencing that namespace agrees on exactly one
  `block_json_path`. A namespace declared (unusually) by more than one
  distinct block.json path across different call sites gets no `DEFINED_IN`
  at all rather than an arbitrary pick — same "only unique matches are
  linked" discipline `resolveHookGraph()`'s `LISTENS_TO` already applies
  (REQ-026/Q-018).
- **`RENDERED_BY`** (`block -> render-callback symbol`): **same-file only**
  — mirrors `resolveShortcodeGraph()`'s own `RENDERED_BY` SQL shape exactly
  (join through the call site's own file, then that file's own symbols),
  **not** `hook`'s project-wide `LISTENS_TO` shape. Same reasoning 1B-1
  already applied to `shortcode`: REQ-024's own text and AC-016's own worked
  example name no cross-file scenario, and a block's registration and its
  render callback are overwhelmingly declared in the same file in real
  WordPress code. Verified end-to-end by test (cross-file case): a block
  whose `register_block_type()` call and render callback sit in different
  files gets `DEFINED_IN` (block.json was still found, in-file) but
  explicitly NOT `RENDERED_BY`.

### AC-017 / `resolution_status = "data_owned"` — verified reading: no writer exists, by construction

The orchestrator's brief flagged AC-017's own "(if any)" as deliberately
soft and asked this phase to verify, not assume, that nothing in the
existing `ui_element`/`ui_component` extraction path could accidentally
surface a persisted block instance. Verified directly:

- This indexer has **no data source for `wp_posts.post_content` at all** —
  it walks static source files under the project root only (confirmed by
  reading `src/indexer.js`'s file-walk and every `src/ui/*.js` extractor:
  none accepts or queries anything resembling a WordPress database
  connection). A `<!-- wp:button -->` HTML comment sitting in a database
  row is structurally unreachable from any code path in this feature, not
  merely unhandled.
- `phpElements.js`/`phpWpPrimitives.js` (the only `ui_element`-producing
  extractors) walk **PHP source AST + a second literal-HTML sub-parse of
  PHP-emitted markup** — never JSON, never database content, never a
  Gutenberg block-instance comment.
- Therefore: **no writer for `data.resolution_status = "data_owned"` is
  added by this phase.** `find_ui_element`/`resolve_ui_reference` simply
  return `status: "not_found"`, zero candidates, for any text that would
  only ever appear inside a persisted block instance — not because of a
  special case, but because nothing was ever indexed for it. This is
  REQ-026's "no fabrication" discipline applying naturally, not a new
  mechanism. Verified end-to-end by test
  (`test/uiIntelligence.acceptance.test.js`, AC-017): both entry points
  named in the AC return empty results, and a project-wide scan confirms
  zero entities anywhere carry `data.resolution_status = "data_owned"`.
- `resolution_status: "data_owned"` (reserved for this phase by 1A-6's own
  contracts.md note, "Phase 1A-6" → "What 1B-2 needs to know") **stays
  reserved and unused** — this phase is not the one that writes its first
  instance. Whichever future phase builds Increment 3's runtime/data
  collector is still the first real writer.

### Pipeline position

`resolveBlockGraph()` is called in `runIndex()` (`src/indexer.js`) right
after `resolveShortcodeGraph()`, before `resolveUiRelations()` — the
established "another project-wide post-pass joining `symbols.entity_id`"
slot (1A-9's Bug #1 fix note; 1B-1's own position note), verified fresh
against `src/indexer.js` directly rather than trusted from any prior
phase's prose, per 1A-9's own warning. Current full order, re-verify
yourself rather than trusting this list if it's been a while:
```
... reconcileIdentity() -> identity preflight (1A-5) -> resolveHookGraph()
(1A-3) -> resolveI18nGraph() (1A-4) -> resolveShortcodeGraph() (1B-1)
-> resolveBlockGraph() (1B-2) <- this phase -> resolveUiRelations() (1A-6)
-> git history / docs / rules / derived
```

### Storage plane / concurrency

Verified by test: only `entities` (`kind IN ('block', 'block_manifest',
'block_site')`) and `entity_links` (`relation IN ('DEFINED_IN',
'RENDERED_BY')`) are touched; `symbols`/`edges` untouched. `src/parser.js`
was not modified at all. Concurrency: no new primitive — runs inside the
same per-project `pg_advisory_lock(project.id)` every other project-wide
pass already relies on; the new per-file `block_site` write (including its
block.json read) runs inside the same per-file transaction the other six
PHP UI extractors already use. `runIndex()`'s returned stats object gained
a `blocks` field (`{ blockCount, definedIn, renderedBy }`, or `{error}`, or
`null` when `config.uiEnabled` is false), alongside the pre-existing
`hooks`/`i18n`/`shortcodes` fields.

### Config

No new config flag — reuses `config.uiEnabled` (`UI_ENABLED`) exactly as
every prior UI phase gated its own work; `lang === "php"` per-file gate
unchanged.

### Scope explicitly not covered (documented, not a gap)

Matching AC-016's own required minimum (the two-positional-argument PHP-
array form) and no further:
- `register_block_type_from_metadata()` — a different function name, not
  recognized at all.
- block.json's own `"render"` field (a template-file render path, distinct
  from a PHP `render_callback`) — not read, not linked.
- A bare `namespace/block-name` single-argument registration (referencing a
  block already declared elsewhere) — no block.json reference exists at
  that call site to resolve `DEFINED_IN` against regardless, so this form
  wouldn't produce a useful entity even if recognized.
- `do_shortcode()`-style "firing" concept — REQ-024 names no such thing for
  blocks (rendering happens through the `render_callback`/block.json
  mechanism itself, already covered by `RENDERED_BY`).

### Fixture

`test/fixtures/wordpress-ui/wp-content/plugins/waycontext/` (reused per
1A-9/1B-1's own instruction, not a new fixture project) now also carries:
- `build/block.json` — AC-016's own worked example almost verbatim,
  declaring `"name": "waycontext/pricing"`.
- `includes/blocks.php` — `register_block_type(__DIR__ . '/../build', ...)`,
  AC-016's own worked example adapted only for living in `includes/` rather
  than the plugin root (`includes/` and `build/` are siblings under the
  plugin root, so the call site needs the extra `/..` to reach it).

Namespace `waycontext/pricing` was checked against 1B-1's own collision
concern (route/text-search substring containment on the `waycontext` slug)
and found **not applicable**: `block`/`block_manifest` are not exposed to
any MCP operation, any `find_ui_element`/`resolve_ui_reference` scoring
signal, or any route text this phase touches — same "unexposed, so the
collision concern doesn't transfer" status 1B-1 already noted for
`shortcode`.

### Tests

`test/ui.phpBlocks.test.js` (12 tests, pure extractor unit tests, no DB):
AC-16's own worked example; short-array (`[...]`) syntax; `__DIR__` alone;
a bare string literal directory; `array($this,'method')`/`array(__CLASS__,
...)`/`array('LiteralClass', ...)` callback resolution; a dynamic first
argument skipped entirely; `plugin_dir_path(__FILE__)`-style unresolvable
concatenation skipped; a missing `render_callback` key; an unresolvable
`render_callback` value; `register_block_type_from_metadata()` correctly
NOT recognized; line numbers.

`test/indexer.uiBlocks.test.js` (8 tests, real-DB end-to-end, no mocking):
AC-016's full chain (block + block_manifest + DEFINED_IN + RENDERED_BY,
including asserting `resolution_status` stays absent); cross-file
render_callback (DEFINED_IN resolves, RENDERED_BY doesn't); a missing
block.json produces zero entities; the direct-block.json-path form; the
root-boundary security check (see above); storage-plane isolation;
tombstone/restore lifecycle for both `block` and `block_manifest`;
`config.uiEnabled = false` full skip.

`test/uiIntelligence.acceptance.test.js` (+2 tests): AC-016 against the
shared `wp_ui_fixture` project; AC-017 (both named entry points return
empty, zero `data_owned` entities anywhere in the project).

Full suite: **801 tests passing (779 pre-existing + 22 new), 0 failures.**

### What 1B-3 needs to know

- `block`/`block_manifest`/`block_site` follow the exact same "not spec-
  facing, not MCP-exposed" status `shortcode`/`hook`/their own staging
  siblings already have. No MCP operation exposes any of them — confirmed
  against REQ-024's own text, which names no query-surface requirement, same
  as REQ-023 for `shortcode`. If 1B-3 or a later phase wants to expose
  `block`/`shortcode` via `find_ui_element`/a new operation, that's a
  decision for that phase to make explicitly.
- **AC-017 has no artifact to "verify" beyond what this phase already
  checked** — there is no persisted-block-instance code path anywhere in
  this codebase to regression-test against; 1B-3's own AC-017 pass can
  reasonably just re-run/trust this phase's own AC-017 test rather than
  inventing a new scenario, unless 1B-3 finds a code path this phase missed
  (re-verify the "no `wp_posts` access anywhere" claim fresh rather than
  trusting this note, per every prior phase's own standing caution about
  trusting prior prose).
- `block`'s namespace-uniqueness assumption (one block.json's `name` maps to
  one canonical block.json path project-wide) is enforced via "unique match
  only" for `DEFINED_IN`, not via a hard uniqueness constraint — a project
  that genuinely declares the same namespace from two different block.json
  files gets a `block` entity with no `DEFINED_IN` link at all, not an
  error. Worth knowing if 1B-3's regression checks construct an adversarial
  fixture.
- The root-boundary filesystem-read check (`writeUiBlockSites()` in
  `src/indexer.js`) is this phase's own addition, not a pre-existing
  codebase convention — if a later phase adds another "read a second file
  based on parsed source text" mechanism, it should get its own boundary
  check too, not assume one already exists generically.
- Pipeline order: `resolveBlockGraph()` sits right after
  `resolveShortcodeGraph()`, before `resolveUiRelations()`, after the
  identity preflight — the established slot for any further project-wide
  post-pass joining `symbols.entity_id`. Re-verify fresh against
  `src/indexer.js` rather than trusting this note, per 1A-9's own standing
  warning (line numbers and even ordering have drifted before).

## Phase 1B-3 — Increment 1B hardening / final verification (2026-09-03)

STATUS: DONE. **This is the closing phase of the whole UI Intelligence /
UI Graph spec — all 12 phases (1A-1 through 1B-3) are now `done`.**
Re-verified AC-015/016/017 and the two §15 regressions against the real,
indexed shared fixture (no mocking); did the light-touch final sanity pass
named in the phase brief. Found no bugs, escalated nothing — the Gate
re-check (`context/phase-1B-3/plan.md`) found every risk dimension
unchanged from the upfront score after Locate.

### Why no new tests were written

`test/uiIntelligence.acceptance.test.js` already contains real, DB-backed
(no mocking), non-tautological tests for AC-015 (L474-501), AC-016
(L507-546), and AC-017 (L548-576) — written by 1B-1/1B-2 themselves, in
this same file, against this same shared `wp_ui_fixture` project. Each
asserts specific facts (exact `dst_id` values cross-checked against
`symbols.entity_id`, the `block_manifest.data.path`, the literal absence
of `resolution_status`/`data_owned` project-wide), not mere existence
checks. Per the phase brief's own instruction ("actually run it, don't
just read 1B-1's test and assume it's still accurate"), this phase's
verification was: (a) read every one of these tests line-by-line to
confirm they test what they claim to, (b) run the full suite twice
end-to-end against the real DB and confirm both AC tests pass, and (c)
independently re-derive the two claims 1B-2 asked this phase to
re-verify from first principles rather than trusting its prose (below).
Writing a second, near-identical scenario against the same fixture would
have added maintenance surface without adding verification value —
disproportionate to a Blast=1, non-checkpoint phase.

### AC-by-AC verification table

| AC | Result | How verified |
|---|---|---|
| AC-015 | PASS | Ran `test/uiIntelligence.acceptance.test.js`'s own AC-015 test against the real, indexed `wp_ui_fixture` project: exactly one `kind='shortcode'` entity for tag `'members'`, `REGISTERED_AT` and `RENDERED_BY` both present, `RENDERED_BY.dst_id` cross-checked byte-for-byte against `render_members()`'s own `symbols.entity_id` in `members-screen.php`. |
| AC-016 | PASS | Same file's AC-016 test: exactly one `kind='block'` entity for namespace `'waycontext/pricing'`, `DEFINED_IN`/`RENDERED_BY` both present, `DEFINED_IN.dst_id` resolves to a `block_manifest` entity whose `data.path` is exactly `wp-content/plugins/waycontext/build/block.json`, `RENDERED_BY.dst_id` cross-checked against `waycontext_render_pricing_block()`'s `symbols.entity_id`, and `block.data.resolution_status` is asserted `undefined` (no persisted-instance resolution attempted). |
| AC-017 | PASS | Independently re-verified the "no code path reads persisted content" claim from first principles rather than trusting 1B-2's prose: `grep -rniE "wp_posts\|post_content\|wpdb\|mysqli" src/` returns zero real hits — only two comment lines in `src/indexer.js` stating no DB access exists. Both entry points named in the AC (`find_ui_element`, `resolve_ui_reference`) return `status: "not_found"`/zero candidates for text that would only appear in a persisted block instance, and a project-wide scan confirms zero entities anywhere carry `data.resolution_status = "data_owned"` — exactly as the existing AC-017 test (L548-576) already asserts and this phase re-ran clean. |
| §15 regression: `test/parser.test.js:154-161` ("tsx: components parse as ordinary declarations") | PASS | Line range matches exactly, still passing, unchanged content. |
| §15 regression: `project_overview`/`get_callers`/`get_callees` output shape | PASS | `test/uiIntelligence.acceptance.test.js`'s own regression test (L727-754) asserts the exact key sets for all three operations' output rows against the fixture carrying the full, final set of all 12 `entity_links` relations this feature introduced — still an exact match, storage-plane isolation holds (these three read only `files`/`symbols`/`edges`, never `entities`/`entity_links`). |

### Independent re-verification of two claims 1B-2 explicitly asked this phase to re-check

- **Pipeline order in `runIndex()`** (`src/indexer.js`): re-derived fresh
  by grepping for every `resolveHookGraph`/`resolveI18nGraph`/
  `resolveShortcodeGraph`/`resolveBlockGraph`/`resolveUiRelations`/
  `reconcileIdentity`/`identityPreflight` call site rather than trusting
  any prior phase's prose (per 1A-9's own standing warning that line
  numbers and even ordering have drifted before). Result: **matches
  contracts.md's documented order exactly**, no drift found this time:
  `... reconcileIdentity() -> identity preflight (1A-5) ->
  resolveHookGraph() (1A-3) -> resolveI18nGraph() (1A-4) ->
  resolveShortcodeGraph() (1B-1) -> resolveBlockGraph() (1B-2) ->
  resolveUiRelations() (1A-6) -> git history / docs / rules / derived`.
- **"No `wp_posts`/persisted-content access anywhere in `src/`" (AC-017's
  underlying claim)**: re-grepped the whole `src/` tree (not just
  `src/ui/`) for `wp_posts`/`post_content`/`wpdb`/`mysqli` — zero real
  hits, confirming 1B-2's claim fresh rather than inheriting it.
- **`shortcode`/`block` MCP exposure**: grepped `src/operations.js` and
  `src/ui/uiQueries.js` for the literal kind names `shortcode`/`block` —
  zero hits (only the staging/manifest kinds `shortcode_site`,
  `block_site`, `block_manifest` appear, and only inside `src/indexer.js`).
  Confirms neither generic kind is reachable from any MCP operation, so
  the REQ-010/Q-005 floor/weight tension (1A-9's own documented,
  unfixed finding about a bare `find_ui_element(text)` call) does not
  apply anywhere in this phase's scope — `find_ui_element`/
  `resolve_ui_reference` never score a `shortcode`/`block` candidate at
  all.

### Final light-touch sanity pass

- **Full test suite, run twice for stability** (1A-9's own convention):
  **804/804 passing, 0 failures, both runs**, no flakiness observed.
- **`src/parser.js` genuinely untouched across the whole feature**:
  `git diff --stat -- src/parser.js` is empty and `git status --porcelain`
  does not list the file — confirmed by tooling, not by re-reading 1A-3's
  own claim.
- **Manifest / context directories**: all 11 prior phase directories
  under `docs/specs/ui-intelligence/context/phase-*/` have both `plan.md`
  and `review.md` present. This phase's own row is set to `done` below.
- **Config-flag documentation**: `UI_ENABLED`/`UI_I18N_LOCALE` are not
  documented in `README.md` — checked, and this is **not** a UI
  Intelligence-specific gap: `DOCS_ENABLED`/`RULES_ENABLED`/
  `HISTORY_ENABLED` (the pre-existing analogues this feature's own gate
  pattern was modeled on) aren't documented there either. Not flagged as
  a closing inconsistency since it's consistent with this codebase's
  existing (undocumented) convention, not something this feature
  introduced unevenly.
- No contradiction found between any two phases' contracts.md sections,
  and no other glaring inconsistency surfaced during this pass.

### Increment 1A/1B complete — final inventory (for a human reading this contracts.md without re-reading all 12 sections)

**Spec-facing `entities.kind` values** (REQ-025's fixed prefixed list, plus
the generic kinds this feature introduced):
- UI-specific (`ui_` prefix): `ui_element`, `ui_screen`, `ui_component`,
  `ui_settings_section`, `ui_settings_field`. (`ui_text` was named in
  REQ-025's fixed list but no phase in this run produced a standalone
  `ui_text` entity — visible text lives on the consuming entity's own
  `data.text` instead, per 1A-4's own design; not a gap, just an unused
  slot in the fixed enum.)
- Generic (no `ui_` prefix, per REQ-025/Q-018/D-UI-018): `hook`,
  `i18n_key`, `shortcode`, `block`.
- Generic, not in REQ-025's fixed list, existing purely as a relation
  target (the `document`-entity precedent applied at lighter weight):
  `block_manifest`.
- Internal-only staging kinds, never MCP-facing, never returned by any
  operation: `hook_site`, `i18n_call_site`, `settings_render_site`,
  `shortcode_site`, `block_site`.

**`entity_links.relation` values this feature introduced** (12 total):
`LISTENS_TO`, `FIRED_BY`, `TRANSLATION_OF`, `TRANSLATION_USED_AT`,
`REGISTERED_AT`, `RENDERED_BY`, `RENDERS`, `DEFINED_BY`, `HANDLED_BY`,
`CONTAINS`, `RENDERED_ON`, `DEFINED_IN`.

**MCP operations added** (5, all `readOnly: true`, Increment 1A only):
`resolve_ui_reference`, `find_ui_element`, `get_ui_context`,
`trace_ui_action`, `find_ui_source`. `shortcode`/`block` (Increment 1B)
remain unexposed to any MCP operation — a decision each of 1B-1/1B-2 left
explicit and open for a later phase, not silently inherited.

**Config**: `config.uiEnabled` (`UI_ENABLED`, default on) gates the entire
feature, index-time and query-time both; `config.uiI18nLocale`
(`UI_I18N_LOCALE`, default unset) is the only other new config surface.
No schema migration was required for the whole feature (Q-001) —
`entities`/`entity_links` absorbed everything.

**New dependency**: `gettext-parser` (^9.1.1), added by 1A-4, used only by
`src/ui/i18nCatalog.js`.

**Shared fixture**: `test/fixtures/wordpress-ui/` (built by 1A-9, extended
by 1B-1/1B-2), 10 files across two plugins, one theme, and a
`wp-includes/` framework-owned file — reused end-to-end by every phase
from 1A-9 onward, including this one.

**Final test count**: **804 tests passing, 0 failures**, run twice for
stability by this phase. (Phase-by-phase cumulative counts recorded in
each phase's own contracts.md section top out at 801 as of 1B-2; the
current 804 reflects the full, final state of every test file — no
discrepancy investigated further since the suite is green both ways and
no phase reported a shrinking count.)

**Everything named in this run's own manifest (`manifest.md`) is now
`done`** — Increment 1A (phases 1A-1 through 1A-9) and Increment 1B
(phases 1B-1 through 1B-3). Increment 2/3/4 remain explicitly out of
scope for this run, per the manifest's own "Phase boundary note".

