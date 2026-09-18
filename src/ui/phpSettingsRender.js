import Parser from "tree-sitter";
import PHP from "tree-sitter-php";

/**
 * Increment 1A UI recognition, phase 1A-6: `do_settings_sections($page)`
 * call sites, project-wide (REQ-018 completion -- see contracts.md "Phase
 * 1A-2" for why this phase's project-wide post-pass, not 1A-2, owns
 * completing the cross-file case).
 *
 * A fifth sibling extractor to phpElements.js/phpWpPrimitives.js/
 * phpHooks.js/phpI18nCalls.js: another independent tree-sitter-php walk over
 * the same source, recognizing exactly one WordPress function --
 * `do_settings_sections()`.
 *
 * Why this file exists at all: 1A-2's `writeUiWpPrimitives()` already
 * recognizes `do_settings_sections()` calls, but only correlates them
 * against `ui_settings_section`/`ui_settings_field` rows **in the same
 * file** (Q-003's bound at that phase) -- a `do_settings_sections($page)`
 * call with no in-file match is silently dropped, nothing is staged for a
 * later phase to read. Since most real WordPress plugins register settings
 * in one file (an `admin_init` hook callback) and render the page from a
 * different one (a menu-callback template), 1A-6's project-wide post-pass
 * needs its own record of every `do_settings_sections()` call site in the
 * project to complete that cross-file correlation -- hence this extractor,
 * staged the same way `phpHooks.js`/`phpI18nCalls.js` stage their own call
 * sites (`hook_site`/`i18n_call_site`) for a project-wide pass to consume.
 *
 * Pure and DB-free, like its four siblings: returns plain per-file records.
 * `src/indexer.js` owns writing them (as `settings_render_site` staging
 * entities, internal-only, never MCP-facing -- same status as `hook_site`/
 * `i18n_call_site`) and owns the project-wide resolution
 * (`resolveUiRelations()`) that consumes them.
 */

let phpParser = null;
function getPhpParser() {
  if (!phpParser) {
    phpParser = new Parser();
    phpParser.setLanguage(PHP.php);
  }
  return phpParser;
}

function stripQuotes(s) {
  return s.replace(/^['"`]|['"`]$/g, "");
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
 * Literal `$page` resolution only (Q-003-bounded, same discipline as
 * `phpHooks.js`'s hook-name resolution) -- a call site whose `$page`
 * argument isn't a literal string is skipped entirely, no fabrication.
 */
function literalPage(node, text) {
  if (!node) return null;
  if (node.type === "string" || node.type === "encapsed_string") return stripQuotes(text(node));
  return null;
}

/**
 * Extract `do_settings_sections($page)` call sites from one PHP source file.
 *
 * @param {string} source
 * @returns {{ page: string, owner: string, line: number }[]}
 */
export function extractPhpSettingsRenderSites(source) {
  const tree = getPhpParser().parse(source, null, { bufferSize: source.length + 1024 });
  const text = (node) => source.slice(node.startIndex, node.endIndex);

  const sites = [];

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
        if (fnName === "do_settings_sections") {
          const [pageNode] = positionalArgs(node);
          const page = literalPage(pageNode, text);
          if (page) {
            sites.push({ page, owner, line: node.startPosition.row + 1 });
          }
        }
        break;
      }
    }
    for (const c of node.namedChildren) walk(c, owner, className);
  }

  walk(tree.rootNode, "@file", null);
  return sites;
}
