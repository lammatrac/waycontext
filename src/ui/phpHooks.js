import Parser from "tree-sitter";
import PHP from "tree-sitter-php";

/**
 * Increment 1A UI recognition, phase 1A-3: WordPress hook wiring as
 * first-class entities -- REQ-014 (`hook` entities, `LISTENS_TO`/
 * `FIRED_BY`), REQ-026/EDGE-012 (project-wide resolution, no fabricated
 * relation targets).
 *
 * A third sibling extractor to src/ui/phpElements.js and
 * src/ui/phpWpPrimitives.js: another independent tree-sitter-php walk over
 * the same source, recognizing exactly four WordPress hook functions --
 * `add_action`/`add_filter` (registration -> a LISTENS_TO candidate) and
 * `do_action`/`apply_filters` (firing -> a FIRED_BY candidate).
 *
 * Deliberately NOT src/parser.js's WP_REGISTER/WP_FIRE sets, which also
 * include add_shortcode/do_shortcode under the same REGISTERS_HOOK/
 * FIRES_HOOK edge relation -- that conflates hooks with shortcodes (a
 * distinct concept, REQ-023/phase 1B-1's territory) in a way this phase's
 * `hook` entities must not inherit. See contracts.md "Phase 1A-3" for why
 * src/parser.js/`edges` are read here not at all, left completely untouched,
 * rather than reused as the source of hook call sites.
 *
 * `stripQuotes`/`resolveCallable`/`positionalArgs` are duplicated from
 * phpWpPrimitives.js rather than imported -- same isolation reasoning as
 * 1A-2's duplication of phpElements.js's I18N_WRAPPERS/stripQuotes
 * (contracts.md "Phase 1A-2 module boundary"): a few duplicated lines beats
 * adding new exports to a frozen, already-reviewed file whose only other
 * consumer would be this one.
 *
 * Pure and DB-free, like its two siblings: returns plain per-file records.
 * src/indexer.js owns writing them (as `hook_site` staging entities) and
 * owns the project-wide resolution post-pass (`resolveHookGraph()`) that
 * turns them into `hook` entities and LISTENS_TO/FIRED_BY entity_links --
 * this module only ever sees one file, so it cannot do that resolution
 * itself (REQ-014 requires project-wide, not per-file, matching).
 */

let phpParser = null;
function getPhpParser() {
  if (!phpParser) {
    phpParser = new Parser();
    phpParser.setLanguage(PHP.php);
  }
  return phpParser;
}

const LISTEN_FNS = new Set(["add_action", "add_filter"]);
const FIRE_FNS = new Set(["do_action", "apply_filters"]);

function stripQuotes(s) {
  return s.replace(/^['"`]|['"`]$/g, "");
}

/**
 * Literal hook-name resolution (REQ-014, Q-003-bounded). Only a plain string
 * literal counts -- unlike EDGE-009's dynamic *text*, a hook name is an
 * identifier, not prose, so there is no useful "partial reconstruction" of a
 * dynamic one; a call site whose hook-name argument isn't a literal is
 * skipped entirely (no entity, no relation -- REQ-026's spirit). A
 * double-quoted string with variable interpolation is treated as its raw
 * source text (quotes stripped, not evaluated) -- the same documented
 * approximation phpElements.js/phpWpPrimitives.js already make for string
 * literals elsewhere (contracts.md "known limitation").
 */
function literalHookName(node, text) {
  if (!node) return null;
  if (node.type === "string" || node.type === "encapsed_string") return stripQuotes(text(node));
  return null;
}

/**
 * Resolve a WP-style callable argument to the same owner-identity string
 * phpElements.js/phpWpPrimitives.js/src/parser.js already use ("fnName" or
 * "Class::method"), so it matches `symbols.name` with no translation.
 * Identical rule set to phpWpPrimitives.js's resolveCallable() -- see its
 * doc comment for the full case-by-case rationale. Q-003-bounded: only
 * forms resolvable from syntax alone; anything else (a variable object, a
 * Closure, a first-class callable, a dynamic method name, ...) -> null,
 * never fabricated.
 */
function resolveCallable(node, text, className) {
  if (!node) return null;
  if (node.type === "string" || node.type === "encapsed_string") return stripQuotes(text(node));
  if (node.type !== "array_creation_expression") return null;

  const items = node.namedChildren.filter((c) => c.type === "array_element_initializer");
  if (items.length !== 2) return null; // not a plain [obj, 'method'] pair
  const [first, second] = items;
  if (first.namedChildren.length !== 1 || second.namedChildren.length !== 1) return null; // key=>value form
  const objNode = first.namedChildren[0];
  const methodNode = second.namedChildren[0];
  if (methodNode.type !== "string" && methodNode.type !== "encapsed_string") return null;
  const method = stripQuotes(text(methodNode));

  if (objNode.type === "variable_name" && text(objNode) === "$this") {
    return className ? `${className}::${method}` : null;
  }
  if (objNode.type === "name" && text(objNode) === "__CLASS__") {
    return className ? `${className}::${method}` : null;
  }
  if (objNode.type === "string" || objNode.type === "encapsed_string") {
    return `${stripQuotes(text(objNode))}::${method}`;
  }
  return null;
}

/** Positional argument expression nodes of a `function_call_expression`, PHP-8-named-arg-tolerant. */
function positionalArgs(callNode) {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return [];
  return argsNode.namedChildren
    .filter((a) => a.type === "argument")
    .map((a) => a.namedChildren[a.namedChildren.length - 1]);
}

/**
 * Extract WordPress hook registration/firing call sites from one PHP source
 * file (REQ-014).
 *
 * @param {string} source
 * @returns {{ listens: object[], fires: object[] }}
 *   `listens[i]`: { hookName, registrationFn, callback, owner, line }
 *     `callback` is the resolved callable string, or null if unresolvable
 *     from syntax alone (never fabricated).
 *   `fires[i]`: { hookName, firingFn, owner, line }
 *     `owner` is the enclosing function/method of the do_action/
 *     apply_filters call -- the firing symbol itself, always resolvable
 *     in-file (no callable-argument resolution needed for this direction).
 */
export function extractPhpHooks(source) {
  const tree = getPhpParser().parse(source, null, { bufferSize: source.length + 1024 });
  const text = (node) => source.slice(node.startIndex, node.endIndex);

  const listens = [];
  const fires = [];

  // Owner tracking: identical convention to phpElements.js/phpWpPrimitives.js
  // -- nearest enclosing function/method, qualified as Class::method inside
  // a class body, else the file-level sentinel "@file".
  function walk(node, owner, className) {
    switch (node.type) {
      case "class_declaration":
      case "trait_declaration": {
        const nameNode = node.childForFieldName("name");
        const cls = nameNode ? text(nameNode) : className;
        for (const c of node.namedChildren) walk(c, owner, cls);
        return;
      }
      case "function_definition":
      case "method_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        const fnOwner = className ? `${className}::${text(nameNode)}` : text(nameNode);
        for (const c of node.namedChildren) walk(c, fnOwner, className);
        return;
      }
      case "function_call_expression": {
        const fnNode = node.childForFieldName("function");
        const fnName = fnNode ? text(fnNode) : "";
        const line = node.startPosition.row + 1;
        if (LISTEN_FNS.has(fnName)) {
          const [hookNode, callbackNode] = positionalArgs(node);
          const hookName = literalHookName(hookNode, text);
          if (hookName) {
            listens.push({
              hookName,
              registrationFn: fnName,
              callback: resolveCallable(callbackNode, text, className),
              owner,
              line,
            });
          }
        } else if (FIRE_FNS.has(fnName)) {
          const [hookNode] = positionalArgs(node);
          const hookName = literalHookName(hookNode, text);
          if (hookName) {
            fires.push({ hookName, firingFn: fnName, owner, line });
          }
        }
        break;
      }
    }
    for (const c of node.namedChildren) walk(c, owner, className);
  }

  walk(tree.rootNode, "@file", null);
  return { listens, fires };
}
