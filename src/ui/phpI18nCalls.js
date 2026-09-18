import Parser from "tree-sitter";
import PHP from "tree-sitter-php";

/**
 * Increment 1A UI recognition, phase 1A-4 (REQ-003/REQ-004): WordPress
 * gettext i18n call sites -- `__`, `_e`, `esc_html__`, `esc_html_e`,
 * `esc_attr__`, `esc_attr_e`, `_x`, `_ex`.
 *
 * A fourth sibling extractor to phpElements.js/phpWpPrimitives.js/
 * phpHooks.js: another independent tree-sitter-php walk over the same
 * source, same pure/DB-free/plain-records contract. `stripQuotes` is
 * duplicated a fourth time rather than imported, extending the
 * module-boundary precedent from 1A-2/1A-3 (contracts.md).
 *
 * Unlike 1A-1's `reconstructEchoProbe()` (which this module does NOT reuse
 * or re-run), this walk does not care whether a call sits inside an
 * echo/literal-HTML fragment, a plain assignment, a function argument, or
 * anywhere else a PHP expression can appear -- it just finds every
 * `function_call_expression` whose function name is a recognized i18n
 * wrapper and reads its own arguments directly. This is what lets 1A-4
 * recover `$domain` (and `$msgctxt` for `_x`/`_ex`), which 1A-1 never
 * captured (see contracts.md "Phase 1A-4" for why: 1A-1's `data.i18n_key`
 * only ever recorded the first/msgid argument).
 *
 * Because it walks unconditionally, it also naturally covers the call sites
 * 1A-1/1A-2 already staged as `ui_element.data.i18n_key` (the msgid argument
 * of an i18n wrapper embedded in literal HTML, or `submit_button()`'s `$text`
 * argument) -- no separate pass is needed to "see" those; `resolveI18nGraph()`
 * in src/indexer.js matches them back up by (source_path, owner, msgid).
 */

let phpParser = null;
function getPhpParser() {
  if (!phpParser) {
    phpParser = new Parser();
    phpParser.setLanguage(PHP.php);
  }
  return phpParser;
}

// Same set 1A-1/1A-2 recognize (contracts.md "Phase 1A-1" EDGE-009).
const I18N_WRAPPERS = new Set(["__", "_e", "esc_html__", "esc_html_e", "esc_attr__", "esc_attr_e", "_x", "_ex"]);
// _x/_ex take (msgid, msgctxt, domain); every other wrapper takes (msgid, domain).
const CONTEXT_WRAPPERS = new Set(["_x", "_ex"]);

function stripQuotes(s) {
  return s.replace(/^['"`]|['"`]$/g, "");
}

/** A literal string argument's text, or null if the node isn't a literal (never fabricated). */
function literalOf(node, text) {
  if (!node) return null;
  if (node.type === "string" || node.type === "encapsed_string") return stripQuotes(text(node));
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
 * Extract WordPress gettext i18n call sites from one PHP source file
 * (REQ-003/REQ-004).
 *
 * @param {string} source
 * @returns {object[]} `{ wrapper, msgid, msgctxt, domain, owner, line }[]`
 *   - `msgid` literal-only; a call whose first argument isn't a string
 *     literal is skipped entirely (no entity, no relation -- same
 *     no-fabrication rule `phpHooks.js` applies to hook names).
 *   - `msgctxt` is the literal `_x`/`_ex` context argument, or `null` for
 *     every other wrapper (and for `_x`/`_ex` when that argument isn't a
 *     literal).
 *   - `domain` is `"default"` (WP core's own documented default) when the
 *     domain argument is omitted entirely -- the same "stable, public,
 *     compile-time-constant fact about WP core's own function signature"
 *     reasoning 1A-2 already applied to `submit_button()`'s omitted args
 *     (contracts.md "Phase 1A-2"). When the argument IS present but isn't a
 *     literal (a variable, a constant, a function call), `domain` is `null`
 *     -- unresolvable, never defaulted.
 */
export function extractPhpI18nCalls(source) {
  const tree = getPhpParser().parse(source, null, { bufferSize: source.length + 1024 });
  const text = (node) => source.slice(node.startIndex, node.endIndex);

  const calls = [];

  // Owner tracking: identical convention to every other sibling extractor in
  // this feature -- nearest enclosing function/method, qualified as
  // Class::method inside a class body, else the file-level sentinel "@file".
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
        if (I18N_WRAPPERS.has(fnName)) {
          const args = positionalArgs(node);
          const [msgidNode, secondNode, thirdNode] = args;
          const msgid = literalOf(msgidNode, text);
          if (msgid !== null) {
            const isContext = CONTEXT_WRAPPERS.has(fnName);
            const msgctxt = isContext ? literalOf(secondNode, text) : null;
            const domainNode = isContext ? thirdNode : secondNode;
            const domainOmitted = domainNode === undefined;
            const domain = domainOmitted ? "default" : literalOf(domainNode, text);
            calls.push({
              wrapper: fnName, msgid, msgctxt, domain,
              owner, line: node.startPosition.row + 1,
            });
          }
        }
        break;
      }
    }
    for (const c of node.namedChildren) walk(c, owner, className);
  }

  walk(tree.rootNode, "@file", null);
  return calls;
}
