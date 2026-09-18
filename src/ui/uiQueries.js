import { pool, getProject } from "../db.js";
import { getSubgraph } from "../graph.js";
import { resolveUiReference } from "./referenceResolver.js";

/**
 * Phase 1A-8 (REQ-012, § 6.2.3): the five MCP-facing UI query operations --
 * `resolve_ui_reference`, `find_ui_element`, `get_ui_context`,
 * `trace_ui_action`, `find_ui_source`. Wired into src/operations.js.
 *
 * Every query here reads the already-resolved graph 1A-1..1A-7 wrote
 * (`entities`/`entity_links`) -- no new scoring, no new relations, no
 * writes. `resolveUiReference()`/`scoreCandidate()` (1A-7) own all
 * ranking; this module only shapes their output for the MCP wire and adds
 * the graph traversals (component/screen/handler/i18n lookups) those two
 * operations don't need but the other three do.
 *
 * `hook_site`/`i18n_call_site`/`settings_render_site` are internal-only
 * staging kinds (1A-3/1A-4/1A-6) and are never queried here -- every hook
 * fact this module surfaces (the "entry hook" naming below) comes from the
 * public `hook`/`FIRED_BY`/`LISTENS_TO`/`HANDLED_BY` graph instead.
 */

// entities.kind values this module will resolve an `element_id` against.
// Internal staging kinds (hook_site, i18n_call_site, settings_render_site)
// and the generic hook/i18n_key kinds are deliberately excluded -- REQ-012's
// five tools all take an *element_id*, i.e. a natural_key from one of these
// five UI-graph kinds.
const UI_ENTITY_KINDS = [
  "ui_element", "ui_component", "ui_screen", "ui_settings_section", "ui_settings_field",
];

// Same "caller's job to pass a valid project name" convention src/graph.js's
// own requireProject() uses -- duplicated rather than imported, extending
// the module-boundary precedent every src/ui/*.js sibling already follows
// ("a few duplicated lines beats adding new exports to a frozen file").
async function requireProject(name) {
  const p = await getProject(name);
  if (!p) throw new Error(`Project "${name}" not found. Run index_project first.`);
  return p;
}

/**
 * Resolves an `element_id` (== the target entity's own natural_key, per
 * REQ-020 -- element_id/screen_id/settings_id/component_id are all
 * self-describing and equal to natural_key, established since 1A-1) to its
 * live entities row. Throws when nothing matches -- same "bad specific
 * identifier is a real error" convention src/graph.js's requireSymbol()/
 * requireFile() use, not resolve_ui_reference's own "a search can
 * legitimately find nothing" status-field convention: this is a keyed
 * lookup, not a search.
 */
async function requireUiEntity(project, elementId) {
  const res = await pool.query(
    `SELECT id, kind, natural_key, title, data
       FROM entities
      WHERE project_id = $1 AND kind = ANY($2) AND natural_key = $3 AND deleted_at IS NULL
      LIMIT 1`,
    [project.id, UI_ENTITY_KINDS, elementId]
  );
  if (!res.rows.length) {
    throw new Error(
      `No UI element "${elementId}" in project "${project.name}". ` +
      `Pass an element_id returned by resolve_ui_reference or find_ui_element.`
    );
  }
  return res.rows[0];
}

/** Outgoing entity_links from `entityId` whose target is a `kind='symbol'`
 * entity, joined through to that symbol's actual name/file/line. */
async function outgoingSymbolLinks(entityId, relation) {
  const res = await pool.query(
    `SELECT e.id AS entity_id, s.name, s.kind AS symbol_kind, s.start_line, f.path
       FROM entity_links el
       JOIN entities e ON e.id = el.dst_id AND e.kind = 'symbol' AND e.deleted_at IS NULL
       JOIN symbols s ON s.entity_id = e.id
       JOIN files f ON f.id = s.file_id
      WHERE el.src_id = $1 AND el.relation = $2
      LIMIT 5`,
    [entityId, relation]
  );
  return res.rows;
}

/** Outgoing entity_links from `entityId` to entities of a specific UI kind. */
async function outgoingEntityLinks(entityId, relation, kind) {
  const res = await pool.query(
    `SELECT e.id, e.kind, e.natural_key, e.title, e.data
       FROM entity_links el
       JOIN entities e ON e.id = el.dst_id AND e.kind = $3 AND e.deleted_at IS NULL
      WHERE el.src_id = $1 AND el.relation = $2
      LIMIT 20`,
    [entityId, relation, kind]
  );
  return res.rows;
}

/** Incoming entity_links into `entityId` from entities of a specific UI kind. */
async function incomingEntityLinks(entityId, relation, kind) {
  const res = await pool.query(
    `SELECT e.id, e.kind, e.natural_key, e.title, e.data
       FROM entity_links el
       JOIN entities e ON e.id = el.src_id AND e.kind = $3 AND e.deleted_at IS NULL
      WHERE el.dst_id = $1 AND el.relation = $2
      LIMIT 20`,
    [entityId, relation, kind]
  );
  return res.rows;
}

/**
 * `hook` entities that FIRED_BY-target the given symbol entity -- i.e. hooks
 * this symbol fires. Used only to *name* a hook already implied by an
 * already-resolved HANDLED_BY/RENDERED_BY chain; never a substitute for
 * 1A-3's own LISTENS_TO resolution (HANDLED_BY, read via
 * outgoingSymbolLinks above, still owns which callback is "the" handler).
 */
async function firedHooksBySymbol(symbolEntityId) {
  const res = await pool.query(
    `SELECT e.natural_key, e.title, e.data
       FROM entity_links el
       JOIN entities e ON e.id = el.src_id AND e.kind = 'hook' AND e.deleted_at IS NULL
      WHERE el.dst_id = $1 AND el.relation = 'FIRED_BY'
      LIMIT 10`,
    [symbolEntityId]
  );
  return res.rows;
}

/**
 * `hook` entities that the given symbol entity LISTENS_TO -- i.e. hooks
 * whose callback *is* this symbol, distinct from firedHooksBySymbol() above
 * (which asks the opposite direction: hooks this symbol *fires*). Used by
 * find_ui_source's "entry hook" -- the hook under which a registration
 * function (e.g. the one calling add_menu_page()) itself runs, which is
 * only knowable if that function was itself registered via add_action().
 */
async function listensToHooksBySymbol(symbolEntityId) {
  const res = await pool.query(
    `SELECT e.natural_key, e.title, e.data
       FROM entity_links el
       JOIN entities e ON e.id = el.dst_id AND e.kind = 'hook' AND e.deleted_at IS NULL
      WHERE el.src_id = $1 AND el.relation = 'LISTENS_TO'
      LIMIT 10`,
    [symbolEntityId]
  );
  return res.rows;
}

function screenShape(sd) {
  sd = sd || {};
  return {
    screen_id: sd.screen_id ?? null,
    route: sd.route ?? null,
    menu_slug: sd.menu_slug ?? null,
    page_title: sd.page_title ?? null,
    menu_title: sd.menu_title ?? null,
  };
}

// ---------------------------------------------------------------------------
// resolve_ui_reference / find_ui_element -- shared candidate enrichment.
// ---------------------------------------------------------------------------

/**
 * REQ-012's per-candidate output shape needs a few fields 1A-7's own
 * candidate object doesn't carry (`resolution_status`, `limitations`,
 * `source`, `application_source`/`not_relevant`, plus placeholders for
 * `handler`/`api`/`styles`). This does one small batched query (bounded by
 * MAX_CANDIDATES=5, never the 500-row pool) to read each candidate's raw
 * `ui_element.data` for the fields 1A-7's candidate shape trims away, then
 * shapes the rest from fields already on the candidate (ownership, in
 * particular, needs no extra query at all).
 *
 * `handler`/`api`/`styles` are deliberately always `null`/`[]` here --
 * populating `handler` for every one of up to 5 candidates on every search
 * call means the same component/hook-chain queries `trace_ui_action` does,
 * times 5, on a call whose whole point is a fast ranked list. A caller that
 * wants the handler chain calls `trace_ui_action(element_id)` on the
 * candidate it picks; one that wants the full graph calls `get_ui_context`.
 * `api`/`styles` have no data source anywhere in Increment 1A (that chain is
 * explicitly Increment 2 scope) and stay `null`/`[]` for that reason alone.
 */
async function enrichCandidates(project, candidates) {
  if (!candidates.length) return candidates;
  const ids = candidates.map((c) => c.element_id);
  const res = await pool.query(
    `SELECT id, natural_key, data FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND natural_key = ANY($2) AND deleted_at IS NULL`,
    [project.id, ids]
  );
  const byId = new Map(res.rows.map((r) => [r.natural_key, r.data || {}]));

  // AC-003: a candidate whose visible text resolved through a .po/.mo
  // catalog must expose the gettext key/textdomain and the catalog entry it
  // resolved through, not just the translated text_source tier. One small
  // batched query (bounded by MAX_CANDIDATES=5, same discipline as the rest
  // of this function), joined through 1A-4's already-resolved TRANSLATION_OF
  // graph -- no re-parsing of any catalog.
  const pkById = new Map(res.rows.map((r) => [r.natural_key, r.id]));
  const numericIds = res.rows.map((r) => r.id);
  const i18nRes = numericIds.length
    ? await pool.query(
        `SELECT el.src_id, e.natural_key AS key, e.data
           FROM entity_links el
           JOIN entities e ON e.id = el.dst_id AND e.kind = 'i18n_key' AND e.deleted_at IS NULL
          WHERE el.src_id = ANY($1) AND el.relation = 'TRANSLATION_OF'`,
        [numericIds]
      )
    : { rows: [] };
  const i18nBySrcId = new Map(i18nRes.rows.map((r) => [r.src_id, r]));

  return candidates.map((c) => {
    const d = byId.get(c.element_id) || {};
    const pk = pkById.get(c.element_id);
    const i18nRow = pk != null ? i18nBySrcId.get(pk) : null;
    const kd = i18nRow?.data || {};
    const i18n = i18nRow
      ? {
          key: i18nRow.key,
          msgid: kd.msgid ?? null,
          textdomain: kd.textdomain ?? null,
          resolved_locale: kd.resolved_locale ?? null,
          resolved_text: kd.resolved_text ?? null,
          catalog_source: kd.catalog_source ?? [],
        }
      : undefined;

    let resolution_status;
    if (d.resolution_status === "data_owned") resolution_status = "data_owned";
    else if (d.defined_by_status === "unresolved" || d.render_status === "unresolved") resolution_status = "unresolved";
    else if (d.render_status === "unknown_render") resolution_status = "unknown_render";

    const limitations = [];
    if (d.has_dynamic_text) limitations.push("text was partially reconstructed from dynamic content (has_dynamic_text)");
    if (c.text_source === "translation_key") limitations.push("translation key has no catalog value for the resolved locale");
    if (resolution_status === "unresolved") {
      limitations.push("identity was incomplete when this was indexed -- re-run index_project or waycontext backfill-identity");
    }

    const source = { path: c.source_path, line: c.line, component: c.owner };

    return {
      ...c,
      resolution_status,
      limitations: limitations.length ? limitations : undefined,
      source,
      application_source: c.ownership === "application" ? source : null,
      not_relevant: c.ownership === "framework"
        ? { path: c.source_path, line: c.line, reason: "WordPress core/framework renderer, not application source" }
        : undefined,
      i18n,
      handler: null,
      api: null,
      styles: [],
    };
  });
}

/**
 * REQ-012's `status` field is a judgment call -- no source defines "ok" vs
 * "partial_match" beyond the enum names. Chosen rule, deterministic and
 * cheap: zero candidates is `not_found`; a single candidate is `ok` (nothing
 * to disambiguate); two or more candidates are `ok` only when the top score
 * clears the runner-up by a real margin (>= 0.15) -- otherwise the caller
 * has a genuine ambiguity to resolve, `partial_match`. 0.15 is not derived
 * from anything in contracts.md; it is this phase's own threshold, recorded
 * here so a later phase can retune it without hunting for where it lives.
 */
function classifyStatus(candidates) {
  if (!candidates.length) return "not_found";
  if (candidates.length === 1) return "ok";
  const gap = candidates[0].match_score - candidates[1].match_score;
  return gap >= 0.15 ? "ok" : "partial_match";
}

/** `resolve_ui_reference(project, task_text?, screen?, text?, role?)`. */
export async function resolveUiReferenceOp(projectName, { taskText, screen, text, role } = {}, log = () => {}) {
  const project = await requireProject(projectName);
  const hints = { screen, text, role };
  const hasHint = Boolean(screen || text || role);
  if (!taskText && !hasHint) {
    throw new Error(
      "resolve_ui_reference requires task_text or at least one of screen/text/role"
    );
  }

  const result = await resolveUiReference({ project: projectName, taskText: taskText || "", hints, log });
  if (!result.enabled) {
    return { enabled: false, understood: undefined, status: "not_found", candidates: [] };
  }

  const candidates = await enrichCandidates(project, result.candidates);
  return {
    enabled: true,
    understood: taskText ? result.queryFields : undefined,
    status: classifyStatus(candidates),
    candidates,
  };
}

/** `find_ui_element(project, text, screen?)` -- resolve_ui_reference
 * restricted to structured hints, no free-text NL parsing (REQ-012). */
export async function findUiElementOp(projectName, text, screen, log = () => {}) {
  const project = await requireProject(projectName);
  if (!text) throw new Error("find_ui_element requires text");

  const result = await resolveUiReference({ project: projectName, taskText: "", hints: { text, screen }, log });
  if (!result.enabled) {
    return { enabled: false, status: "not_found", candidates: [] };
  }

  const candidates = await enrichCandidates(project, result.candidates);
  return { enabled: true, status: classifyStatus(candidates), candidates };
}

// ---------------------------------------------------------------------------
// get_ui_context -- REQ-012, output shape NOTE [AMBIGUOUS] in the spec.
// ---------------------------------------------------------------------------

/**
 * `get_ui_context(project, element_id)`.
 *
 * Ambiguity resolution (spec: "By analogy with the worked example it would
 * carry component, parent, handler, API and tests; the source does not say
 * so for this tool specifically" -- item 13's set is named for a different,
 * out-of-scope IDE-sidebar surface): this composes the element's own data
 * with what 1A-6's post-pass already resolved one hop out -- its owning
 * `ui_component` (via RENDERS), the screen(s) it renders on (via
 * RENDERED_ON/CONTAINS), its component's HANDLED_BY hook-callback (named via
 * the public FIRED_BY graph, not by reading hook_site), and its i18n key
 * (via TRANSLATION_OF) -- rather than "tests"/"API", which have no data
 * source in Increment 1A (that chain is Increment 2 scope) and would be
 * fabricated if included. This deliberately stops at the first-hop graph;
 * it does not walk onward through the call graph the way `trace_ui_action`
 * does -- that's what keeps the two tools distinct rather than redundant.
 *
 * Primary intended input is a `ui_element`/`ui_component` (or, secondarily,
 * a `ui_settings_section`/`ui_settings_field`); calling it on a `ui_screen`
 * still resolves (the screen's own data is always returned in `element`),
 * but `component`/`handled_by`/`i18n` come back null/empty since a screen
 * doesn't participate in those relations directly -- documented, not a bug.
 */
export async function getUiContextOp(projectName, elementId) {
  const project = await requireProject(projectName);
  const entity = await requireUiEntity(project, elementId);
  const d = entity.data || {};

  let component = entity.kind === "ui_component" ? entity : null;
  if (!component && entity.kind === "ui_element") {
    component = (await incomingEntityLinks(entity.id, "RENDERS", "ui_component"))[0] || null;
  }
  if (!component && (entity.kind === "ui_settings_section" || entity.kind === "ui_settings_field")) {
    component = (await incomingEntityLinks(entity.id, "CONTAINS", "ui_component"))[0] || null;
  }

  let definedBy = (await outgoingSymbolLinks(entity.id, "DEFINED_BY"))[0] || null;
  if (!definedBy && component && component.id !== entity.id) {
    definedBy = (await outgoingSymbolLinks(component.id, "DEFINED_BY"))[0] || null;
  }

  let screens = [];
  if (entity.kind === "ui_element") {
    screens = (await outgoingEntityLinks(entity.id, "RENDERED_ON", "ui_screen")).map((r) => screenShape(r.data));
  } else if (entity.kind !== "ui_screen") {
    const src = component || entity;
    screens = (await incomingEntityLinks(src.id, "CONTAINS", "ui_screen")).map((r) => screenShape(r.data));
  }

  let handledBy = [];
  if (component) {
    const handled = await outgoingSymbolLinks(component.id, "HANDLED_BY");
    let hookNames = [];
    if (definedBy) {
      hookNames = (await firedHooksBySymbol(definedBy.entity_id)).map((h) => h.title ?? h.data?.name).filter(Boolean);
    }
    handledBy = handled.map((h) => ({
      symbol: { name: h.name, kind: h.symbol_kind, path: h.path, line: h.start_line },
      hook: hookNames[0] ?? null,
    }));
  }

  let i18n = null;
  if (entity.kind === "ui_element" && d.i18n_key) {
    const rows = await outgoingEntityLinks(entity.id, "TRANSLATION_OF", "i18n_key");
    if (rows[0]) {
      const kd = rows[0].data || {};
      i18n = {
        key: rows[0].natural_key,
        msgid: kd.msgid ?? null,
        textdomain: kd.textdomain ?? null,
        translations: kd.translations ?? {},
        resolved_locale: kd.resolved_locale ?? null,
        resolved_text: kd.resolved_text ?? null,
      };
    }
  }

  return {
    element: {
      element_id: entity.natural_key,
      kind: entity.kind,
      title: entity.title,
      type: d.type ?? null,
      role: d.role ?? null,
      text: d.text ?? null,
      text_source: d.text_source ?? null,
      source_path: d.source_path ?? null,
      line: d.line ?? null,
      owner: d.owner ?? null,
      ownership: d.ownership ?? null,
    },
    component: component ? {
      component_id: component.natural_key,
      owner: component.data?.owner ?? null,
      source_path: component.data?.source_path ?? null,
      ownership: component.data?.ownership ?? null,
      defined_by_status: component.data?.defined_by_status ?? null,
    } : null,
    defined_by: definedBy ? {
      symbol: definedBy.name, kind: definedBy.symbol_kind, path: definedBy.path, line: definedBy.start_line,
    } : null,
    screens,
    handled_by: handledBy,
    i18n,
  };
}

// ---------------------------------------------------------------------------
// trace_ui_action -- REQ-012, Increment 1A chain only.
// ---------------------------------------------------------------------------

/**
 * `trace_ui_action(project, element_id)`.
 *
 * Increment 1A chain (Increment 2's fuller chain -- handler -> mutation/
 * service call -> API endpoint -> backend controller/service -> tests -- is
 * explicitly out of scope, not built toward):
 *   element -> hook (LISTENS_TO/FIRED_BY, via the component's already-
 *   resolved HANDLED_BY) OR Settings Field/Section RENDERED_BY -> callback
 *   symbol -> onward through the existing call graph.
 *
 * "Onward through the existing call graph" reuses `getSubgraph()`
 * (src/graph.js, the same BFS `get_graph` already exposes) at its own
 * default depth (2) rather than reimplementing traversal -- this is
 * read-only and additive, not a new primitive.
 */
export async function traceUiActionOp(projectName, elementId) {
  const project = await requireProject(projectName);
  const entity = await requireUiEntity(project, elementId);

  let handlerSymbol = null;
  let via = null;
  let hookName = null;

  if (entity.kind === "ui_settings_section" || entity.kind === "ui_settings_field") {
    handlerSymbol = (await outgoingSymbolLinks(entity.id, "RENDERED_BY"))[0] || null;
    if (handlerSymbol) via = "settings_rendered_by";
  } else {
    let component = entity.kind === "ui_component" ? entity : null;
    if (!component && entity.kind === "ui_element") {
      component = (await incomingEntityLinks(entity.id, "RENDERS", "ui_component"))[0] || null;
    }
    if (component) {
      handlerSymbol = (await outgoingSymbolLinks(component.id, "HANDLED_BY"))[0] || null;
      if (handlerSymbol) {
        via = "hook_handled_by";
        const definedBy = (await outgoingSymbolLinks(component.id, "DEFINED_BY"))[0] || null;
        if (definedBy) {
          const hooks = await firedHooksBySymbol(definedBy.entity_id);
          hookName = hooks[0]?.title ?? hooks[0]?.data?.name ?? null;
        }
      }
    }
  }

  let callGraph = null;
  if (handlerSymbol?.name) {
    callGraph = await getSubgraph(projectName, handlerSymbol.name, 2);
  }

  return {
    element_id: entity.natural_key,
    kind: entity.kind,
    handler: handlerSymbol ? {
      via,
      hook: hookName,
      symbol: {
        name: handlerSymbol.name, kind: handlerSymbol.symbol_kind,
        path: handlerSymbol.path, line: handlerSymbol.start_line,
      },
    } : null,
    call_graph: callGraph,
    status: handlerSymbol ? "resolved" : "no_handler_found",
  };
}

// ---------------------------------------------------------------------------
// find_ui_source -- REQ-012, REQ-013's user-facing "not_relevant" signal.
// ---------------------------------------------------------------------------

/**
 * `find_ui_source(project, element_id)`. File/line/component, "created via"
 * (the WP primitive/extractor that produced this entity), how the screen/
 * field was registered and the entry hook (named via the public LISTENS_TO
 * graph -- the hook the registering symbol is itself a callback for, not
 * FIRED_BY, which names the opposite direction used by trace_ui_action/
 * get_ui_context's HANDLED_BY chain), and an explicit `not_relevant` entry
 * naming the WordPress core renderer when `ownership === "framework"`
 * (REQ-013 -- `ownership` is precomputed by 1A-6, read directly, never
 * re-derived).
 */
export async function findUiSourceOp(projectName, elementId) {
  const project = await requireProject(projectName);
  const entity = await requireUiEntity(project, elementId);
  const d = entity.data || {};
  const ownership = d.ownership ?? null;
  const source = { path: d.source_path ?? null, line: d.line ?? null, component: d.owner ?? null };

  let created_via = null;
  if (entity.kind === "ui_element") {
    created_via = d.extraction === "wp_primitive" ? "submit_button" : (d.extraction ?? null);
  } else if (entity.kind === "ui_screen" || entity.kind === "ui_settings_section" || entity.kind === "ui_settings_field") {
    created_via = d.registration_fn ?? null;
  }

  // REGISTERED_AT (screens/settings) tried first; DEFINED_BY (elements/
  // components) is the fallback -- REGISTERED_AT is simply absent for those
  // two kinds, so this never masks a real REGISTERED_AT result.
  let ownerSymbol = (await outgoingSymbolLinks(entity.id, "REGISTERED_AT"))[0] || null;
  if (!ownerSymbol && (entity.kind === "ui_element" || entity.kind === "ui_component")) {
    ownerSymbol = (await outgoingSymbolLinks(entity.id, "DEFINED_BY"))[0] || null;
  }

  let registeredAt = null;
  let entryHooks = [];
  if (ownerSymbol) {
    registeredAt = { path: ownerSymbol.path, line: ownerSymbol.start_line, symbol: ownerSymbol.name };
    entryHooks = (await listensToHooksBySymbol(ownerSymbol.entity_id)).map((h) => h.title ?? h.data?.name).filter(Boolean);
  }

  return {
    element_id: entity.natural_key,
    kind: entity.kind,
    source,
    ownership,
    application_source: ownership === "application" ? source : null,
    not_relevant: ownership === "framework"
      ? { path: source.path, line: source.line, reason: "WordPress core/framework renderer, not application source" }
      : null,
    created_via,
    registered_at: registeredAt,
    entry_hooks: entryHooks,
  };
}
