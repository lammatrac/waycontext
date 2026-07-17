import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import PHP from "tree-sitter-php";

const LANGS = {
  js: JavaScript,
  jsx: JavaScript,
  ts: TypeScript.typescript,
  tsx: TypeScript.tsx,
  php: PHP.php,
};

export const EXT_LANG = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".tsx": "tsx",
  ".php": "php",
};

const parsers = {};
function getParser(lang) {
  if (!parsers[lang]) {
    const p = new Parser();
    p.setLanguage(LANGS[lang]);
    parsers[lang] = p;
  }
  return parsers[lang];
}

const MAX_BODY = 6000; // chars stored/embedded per symbol

// WordPress hook APIs
const WP_REGISTER = new Set(["add_action", "add_filter", "add_shortcode"]);
const WP_FIRE = new Set(["do_action", "apply_filters", "do_shortcode"]);

/**
 * Parse one file.
 * @returns {{ symbols: Array, relations: Array }}
 *  symbol:   { name, kind, signature, doc, startLine, endLine, body }
 *  relation: { srcName, relation, dstName, line }
 */
export function parseFile(lang, source) {
  const parser = getParser(lang);
  // default internal read buffer is 32768 UTF-16 units; anything at or above
  // that length trips a chunked-read bug in node-tree-sitter ("Invalid argument")
  const tree = parser.parse(source, null, { bufferSize: source.length + 1024 });
  const symbols = [];
  const relations = [];

  const text = (node) => source.slice(node.startIndex, node.endIndex);
  const line = (node) => node.startPosition.row + 1;

  function leadingDoc(node) {
    let prev = node.previousNamedSibling;
    if (prev && prev.type === "comment") {
      const c = text(prev).trim();
      if (c.startsWith("/**") || c.startsWith("//") || c.startsWith("/*")) {
        return c.slice(0, 1000);
      }
    }
    return null;
  }

  function signatureOf(node) {
    // first line of the definition, trimmed
    const t = text(node);
    return t.split("\n")[0].slice(0, 300).trim();
  }

  function stripQuotes(s) {
    return s.replace(/^['"`]|['"`]$/g, "");
  }

  function addSymbol(name, kind, node) {
    const body = text(node);
    symbols.push({
      name,
      kind,
      signature: signatureOf(node),
      doc: leadingDoc(node),
      startLine: line(node),
      endLine: node.endPosition.row + 1,
      body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n/* …truncated */" : body,
    });
    return name;
  }

  /** Collect calls / instantiations / hooks inside `node`, attributed to `owner`. */
  function collectRefs(node, owner) {
    const cursor = node.walk();
    const visit = (n) => {
      switch (n.type) {
        // ---- JS/TS ----
        case "call_expression": {
          const fn = n.childForFieldName("function");
          if (fn) {
            const callee = text(fn).slice(0, 200);
            relations.push({ srcName: owner, relation: "CALLS", dstName: callee, line: line(n) });
          }
          break;
        }
        case "new_expression": {
          const ctor = n.childForFieldName("constructor");
          if (ctor) {
            relations.push({ srcName: owner, relation: "INSTANTIATES", dstName: text(ctor).slice(0, 200), line: line(n) });
          }
          break;
        }
        // ---- PHP ----
        case "function_call_expression": {
          const fn = n.childForFieldName("function");
          if (!fn) break;
          const callee = text(fn);
          const argsNode = n.childForFieldName("arguments");
          const args = (argsNode ? argsNode.namedChildren : []).map(
            (a) => (a.type === "argument" && a.namedChildCount ? a.namedChildren[0] : a)
          );
          if (WP_REGISTER.has(callee) && args.length >= 1) {
            const hook = stripQuotes(text(args[0]));
            relations.push({ srcName: owner, relation: "REGISTERS_HOOK", dstName: `hook:${hook}`, line: line(n) });
            // callback given as plain string → CALLS edge to that function
            if (args[1] && ["string", "encapsed_string"].includes(args[1].type)) {
              relations.push({ srcName: owner, relation: "CALLS", dstName: stripQuotes(text(args[1])), line: line(n) });
            }
          } else if (WP_FIRE.has(callee) && args.length >= 1) {
            const hook = stripQuotes(text(args[0]));
            relations.push({ srcName: owner, relation: "FIRES_HOOK", dstName: `hook:${hook}`, line: line(n) });
          } else {
            relations.push({ srcName: owner, relation: "CALLS", dstName: callee.slice(0, 200), line: line(n) });
          }
          break;
        }
        case "member_call_expression":
        case "scoped_call_expression": {
          const name = n.childForFieldName("name");
          if (name) {
            relations.push({ srcName: owner, relation: "CALLS", dstName: text(name).slice(0, 200), line: line(n) });
          }
          break;
        }
        case "object_creation_expression": {
          const cls = n.namedChildren.find((c) => c.type.includes("name"));
          if (cls) {
            relations.push({ srcName: owner, relation: "INSTANTIATES", dstName: text(cls).slice(0, 200), line: line(n) });
          }
          break;
        }
      }
      // depth-first
      if (cursor.gotoFirstChild()) {
        do visit(cursor.currentNode);
        while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    visit(cursor.currentNode);
  }

  function classMembers(classNode, className, bodyField) {
    const body = classNode.childForFieldName(bodyField) || classNode.namedChildren.find((c) => c.type.endsWith("body"));
    if (!body) return;
    for (const m of body.namedChildren) {
      if (m.type === "method_definition" || m.type === "method_declaration") {
        const nameNode = m.childForFieldName("name");
        if (!nameNode) continue;
        const full = `${className}::${text(nameNode)}`;
        addSymbol(full, "method", m);
        collectRefs(m, full);
      }
    }
  }

  function heritage(classNode, className) {
    // JS/TS: class_heritage / extends_clause / implements_clause
    for (const c of classNode.namedChildren) {
      if (c.type === "class_heritage" || c.type === "extends_clause") {
        for (const t of c.namedChildren) {
          relations.push({ srcName: className, relation: "EXTENDS", dstName: text(t).slice(0, 200), line: line(c) });
        }
      }
      if (c.type === "implements_clause") {
        for (const t of c.namedChildren) {
          relations.push({ srcName: className, relation: "IMPLEMENTS", dstName: text(t).slice(0, 200), line: line(c) });
        }
      }
      // PHP: base_clause (extends), class_interface_clause (implements)
      if (c.type === "base_clause") {
        for (const t of c.namedChildren) {
          relations.push({ srcName: className, relation: "EXTENDS", dstName: text(t).slice(0, 200), line: line(c) });
        }
      }
      if (c.type === "class_interface_clause") {
        for (const t of c.namedChildren) {
          relations.push({ srcName: className, relation: "IMPLEMENTS", dstName: text(t).slice(0, 200), line: line(c) });
        }
      }
    }
  }

  function walkTopLevel(node, namespace = "") {
    for (const n of node.namedChildren) {
      switch (n.type) {
        // ---- shared ----
        case "class_declaration": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = namespace + text(nameNode);
          addSymbol(name, "class", n);
          heritage(n, name);
          classMembers(n, name, "body");
          break;
        }
        case "interface_declaration": {
          const nameNode = n.childForFieldName("name");
          if (nameNode) addSymbol(namespace + text(nameNode), "interface", n);
          break;
        }
        // ---- JS/TS ----
        case "function_declaration":
        case "generator_function_declaration": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = namespace + text(nameNode);
          addSymbol(name, "function", n);
          collectRefs(n, name);
          break;
        }
        case "lexical_declaration":
        case "variable_declaration": {
          // const foo = () => {} / function() {}
          for (const d of n.namedChildren) {
            if (d.type !== "variable_declarator") continue;
            const nameNode = d.childForFieldName("name");
            const value = d.childForFieldName("value");
            if (nameNode && value && ["arrow_function", "function_expression", "function"].includes(value.type)) {
              const name = namespace + text(nameNode);
              addSymbol(name, "function", n);
              collectRefs(value, name);
            }
          }
          break;
        }
        case "import_statement": {
          const srcNode = n.childForFieldName("source");
          if (srcNode) {
            relations.push({ srcName: "@file", relation: "IMPORTS", dstName: stripQuotes(text(srcNode)), line: line(n) });
          }
          break;
        }
        case "export_statement": {
          walkTopLevel(n, namespace); // unwrap "export function foo() {}"
          break;
        }
        // ---- PHP ----
        case "function_definition": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = namespace + text(nameNode);
          addSymbol(name, "function", n);
          collectRefs(n, name);
          break;
        }
        case "trait_declaration": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = namespace + text(nameNode);
          addSymbol(name, "trait", n);
          classMembers(n, name, "body");
          break;
        }
        case "namespace_definition": {
          const nameNode = n.childForFieldName("name");
          const ns = nameNode ? text(nameNode) + "\\" : "";
          const body = n.childForFieldName("body");
          walkTopLevel(body || n, ns);
          break;
        }
        case "namespace_use_declaration": {
          for (const c of n.namedChildren) {
            if (c.type === "namespace_use_clause") {
              relations.push({ srcName: "@file", relation: "IMPORTS", dstName: text(c).slice(0, 200), line: line(n) });
            }
          }
          break;
        }
        case "program":
        case "php_tag":
        default: {
          // PHP wraps everything; also handle top-level hook calls in plugin bootstrap files
          if (n.type === "expression_statement") {
            collectRefs(n, "@file");
          } else if (n.namedChildCount > 0 && ["program", "text_interpolation"].includes(n.type)) {
            walkTopLevel(n, namespace);
          }
        }
      }
    }
  }

  walkTopLevel(tree.rootNode);
  return { symbols, relations };
}
