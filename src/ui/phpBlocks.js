import Parser from "tree-sitter";
import PHP from "tree-sitter-php";

/**
 * Increment 1B UI recognition, phase 1B-2: Gutenberg static block
 * registration as a first-class entity -- REQ-024 (generic `block` entity,
 * not `ui_block`, per REQ-025/Q-018/D-UI-018), AC-016. Resolves EDGE-014's
 * "static registration only" half.
 *
 * Same pattern as src/ui/phpShortcodes.js: a sibling PHP extractor, pure and
 * DB-free, recognizing exactly one WordPress function --
 * `register_block_type($blockTypeOrDir, $args)`. `stripQuotes`/
 * `resolveCallable`/`positionalArgs` are duplicated rather than imported --
 * same module-boundary precedent (contracts.md "Phase 1A-2"/"Phase 1A-3").
 *
 * Scope (a deliberate minimum, matching AC-016's own worked example, not a
 * gap): only the two-positional-argument PHP-array form is recognized --
 * `register_block_type($dirOrPath, ['render_callback' => ...])`. NOT
 * recognized, out of scope for this phase: `register_block_type_from_metadata()`
 * (a different function name), block.json's own `"render"` field (a
 * template-file render path, not a PHP callback), and a bare
 * `namespace/block-name` single-arg form (registering an already-declared
 * block by name -- no block.json reference at that call site at all, so
 * REQ-024's own DEFINED_IN target wouldn't exist there regardless).
 *
 * This module resolves the first argument down to a literal *path fragment*
 * only -- it never touches the filesystem (pure, like every sibling
 * extractor). Turning that fragment into an actual block.json path (relative
 * to the registering file's own directory, which only the caller knows) and
 * reading it is src/indexer.js's job, via src/ui/blockManifest.js -- see
 * that module's own doc comment for why the split exists.
 */

let phpParser = null;
function getPhpParser() {
  if (!phpParser) {
    phpParser = new Parser();
    phpParser.setLanguage(PHP.php);
  }
  return phpParser;
}

const REGISTER_FN = "register_block_type";

function stripQuotes(s) {
  return s.replace(/^['"`]|['"`]$/g, "");
}

/**
 * Resolve a WP-style callable argument to the same owner-identity string
 * every sibling extractor already uses ("fnName" or "Class::method").
 * Identical rule set to phpShortcodes.js's/phpHooks.js's/
 * phpWpPrimitives.js's resolveCallable() -- see their doc comments for the
 * full case-by-case rationale. Q-003-bounded: only forms resolvable from
 * syntax alone; anything else -> null, never fabricated.
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

/**
 * The raw AST value-node of `array('key' => value, ...)[key]` (or the
 * `[...]` short-syntax equivalent -- both parse to `array_creation_expression`
 * in tree-sitter-php), or null if the key is absent or the array itself
 * isn't a literal. Unlike phpWpPrimitives.js's `arrayLiteralGet()` (which
 * only ever returns a literal *string* value), this returns the node itself
 * so the caller can resolve a non-string value -- here, `render_callback`,
 * which is a callable, not text -- through resolveCallable() above.
 */
function arrayLiteralGetNode(node, text, key) {
  if (!node || node.type !== "array_creation_expression") return null;
  for (const item of node.namedChildren) {
    if (item.type !== "array_element_initializer" || item.namedChildren.length !== 2) continue;
    const [k, v] = item.namedChildren;
    if ((k.type === "string" || k.type === "encapsed_string") && stripQuotes(text(k)) === key) return v;
  }
  return null;
}

/**
 * Resolve register_block_type()'s first argument to a literal directory (or
 * direct block.json) path *fragment*, Q-003-bounded: a bare string literal,
 * `__DIR__` alone, and `.`-concatenation of `__DIR__`/string literals are
 * recognized -- anything else (a variable, `plugin_dir_path(__FILE__)`, a
 * ternary, ...) is unresolvable. `__DIR__` itself resolves to the
 * empty-string literal fragment "" (meaning "no path segment beyond the
 * registering file's own directory") -- this module never knows that file's
 * actual path, so it can't resolve further than that; the caller joins this
 * fragment onto the file's own directory once it does.
 *
 * @returns {{ value: string|null, dynamic: boolean }}
 *   `dynamic: true` means unresolvable -- `value` is meaningless in that
 *   case (never a partial reconstruction the way EDGE-009 partially
 *   reconstructs dynamic *text*; a directory/file path is an identifier, not
 *   prose, same reasoning phpShortcodes.js's literalTag() already applies
 *   to a shortcode tag).
 */
function resolveDirArg(node, text) {
  if (!node) return { value: null, dynamic: true };

  function walk(n) {
    if (n.type === "string" || n.type === "encapsed_string") return { value: stripQuotes(text(n)), dynamic: false };
    if (n.type === "name" && text(n) === "__DIR__") return { value: "", dynamic: false };
    if (n.type === "parenthesized_expression") {
      const inner = n.namedChildren[0];
      return inner ? walk(inner) : { value: null, dynamic: true };
    }
    if (n.type === "binary_expression") {
      const op = n.childForFieldName("operator");
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (op && text(op) === "." && left && right) {
        const l = walk(left);
        const r = walk(right);
        if (l.dynamic || r.dynamic) return { value: null, dynamic: true };
        return { value: l.value + r.value, dynamic: false };
      }
      return { value: null, dynamic: true };
    }
    return { value: null, dynamic: true };
  }

  return walk(node);
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
 * Extract WordPress Gutenberg static block-registration call sites from one
 * PHP source file (REQ-024).
 *
 * @param {string} source
 * @returns {{ dirArg: string, renderCallback: string|null, owner: string, line: number }[]}
 *   `dirArg` is resolveDirArg()'s resolved literal path fragment, relative
 *   to THIS file's own directory (never absolute, never touched by this
 *   module beyond string resolution). A call site whose first argument
 *   isn't resolvable from syntax alone is skipped entirely -- no record, no
 *   downstream entity (REQ-026's spirit). `renderCallback` is
 *   resolveCallable()'s output applied to the second argument's
 *   `'render_callback'` array key, or null if the second argument is
 *   absent, isn't a literal array, or has no such key.
 */
export function extractPhpBlocks(source) {
  const tree = getPhpParser().parse(source, null, { bufferSize: source.length + 1024 });
  const text = (node) => source.slice(node.startIndex, node.endIndex);

  const blocks = [];

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
          const [dirNode, argsNode] = positionalArgs(node);
          const dirRes = resolveDirArg(dirNode, text);
          if (!dirRes.dynamic) {
            const callbackNode = arrayLiteralGetNode(argsNode, text, "render_callback");
            blocks.push({
              dirArg: dirRes.value,
              renderCallback: resolveCallable(callbackNode, text, className),
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
  return blocks;
}
