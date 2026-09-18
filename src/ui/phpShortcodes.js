import Parser from "tree-sitter";
import PHP from "tree-sitter-php";

/**
 * Increment 1B UI recognition, phase 1B-1: WordPress shortcode registration
 * as a first-class entity -- REQ-023 (generic `shortcode` entity, not
 * `ui_shortcode`, per REQ-025/Q-018/D-UI-018), AC-015.
 *
 * A sibling extractor to src/ui/phpHooks.js (and phpElements.js/
 * phpWpPrimitives.js/phpI18nCalls.js/phpSettingsRender.js before it):
 * another independent tree-sitter-php walk over the same source,
 * recognizing exactly one WordPress function -- `add_shortcode(tag,
 * callback)`.
 *
 * Deliberately does NOT recognize `do_shortcode()` -- REQ-023 only names
 * registration (`add_shortcode`), unlike REQ-014's hook graph, which
 * explicitly named both a "listen" and a "fire" side. There is no "firing"
 * concept named for shortcodes in this REQ; inventing one would be scope
 * creep (see contracts.md "Phase 1B-1").
 *
 * Also deliberately NOT src/parser.js's WP_REGISTER set, which already
 * recognizes `add_shortcode` under the generic REGISTERS_HOOK edge relation
 * (conflating hooks and shortcodes) -- see contracts.md "Phase 1A-3" for why
 * that plane is read nowhere by this UI Intelligence feature. This module
 * builds the new, correct `entities`/`entity_links`-plane `shortcode` graph
 * from scratch, exactly mirroring the hook-graph precedent.
 *
 * `stripQuotes`/`resolveCallable`/`positionalArgs` are duplicated from
 * phpHooks.js rather than imported -- same isolation reasoning documented
 * there and in contracts.md "Phase 1A-2 module boundary": a few duplicated
 * lines beats adding new exports to a frozen, already-reviewed file whose
 * only other consumer would be this one.
 *
 * Pure and DB-free, like every sibling extractor: returns plain per-file
 * records. src/indexer.js owns writing them (as `shortcode_site` staging
 * entities) and owns the project-wide resolution post-pass
 * (`resolveShortcodeGraph()`) that turns them into `shortcode` entities and
 * REGISTERED_AT/RENDERED_BY entity_links -- this module only ever sees one
 * file, so it cannot do that resolution itself (a shortcode tag is a
 * project-wide concept, one entity per tag, same precedent as `hook`).
 */

let phpParser = null;
function getPhpParser() {
  if (!phpParser) {
    phpParser = new Parser();
    phpParser.setLanguage(PHP.php);
  }
  return phpParser;
}

const REGISTER_FN = "add_shortcode";

function stripQuotes(s) {
  return s.replace(/^['"`]|['"`]$/g, "");
}

/**
 * Literal shortcode-tag resolution (REQ-023, Q-003-bounded). Only a plain
 * string literal counts -- a tag is an identifier, not prose, so there is no
 * useful "partial reconstruction" of a dynamic one; a call site whose tag
 * argument isn't a literal is skipped entirely (no entity, no relation --
 * REQ-026's spirit). Identical rule to phpHooks.js's literalHookName().
 */
function literalTag(node, text) {
  if (!node) return null;
  if (node.type === "string" || node.type === "encapsed_string") return stripQuotes(text(node));
  return null;
}

/**
 * Resolve a WP-style callable argument to the same owner-identity string
 * every sibling extractor already uses ("fnName" or "Class::method"), so it
 * matches `symbols.name` with no translation. Identical rule set to
 * phpHooks.js's/phpWpPrimitives.js's resolveCallable() -- see their doc
 * comments for the full case-by-case rationale. Q-003-bounded: only forms
 * resolvable from syntax alone; anything else -> null, never fabricated.
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
 * Extract WordPress shortcode registration call sites from one PHP source
 * file (REQ-023).
 *
 * @param {string} source
 * @returns {{ tag: string, callback: string|null, owner: string, line: number }[]}
 *   `callback` is resolveCallable()'s output, or null if unresolvable from
 *   syntax alone (never fabricated).
 */
export function extractPhpShortcodes(source) {
  const tree = getPhpParser().parse(source, null, { bufferSize: source.length + 1024 });
  const text = (node) => source.slice(node.startIndex, node.endIndex);

  const shortcodes = [];

  // Owner tracking: identical convention to every other sibling extractor --
  // nearest enclosing function/method, qualified as Class::method inside a
  // class body, else the file-level sentinel "@file".
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
        if (fnName === REGISTER_FN) {
          const [tagNode, callbackNode] = positionalArgs(node);
          const tag = literalTag(tagNode, text);
          if (tag) {
            shortcodes.push({
              tag,
              callback: resolveCallable(callbackNode, text, className),
              owner,
              line: node.startPosition.row + 1,
            });
          }
        }
        break;
      }
    }
    for (const c of node.namedChildren) walk(c, owner, className);
  }

  walk(tree.rootNode, "@file", null);
  return shortcodes;
}
