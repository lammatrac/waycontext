import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import PHP from "tree-sitter-php";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import JSON_LANG from "tree-sitter-json";
import HTML from "tree-sitter-html";
import CSS from "tree-sitter-css";
import Xml from "@tree-sitter-grammars/tree-sitter-xml";

const LANGS = {
  js: JavaScript,
  jsx: JavaScript,
  ts: TypeScript.typescript,
  tsx: TypeScript.tsx,
  php: PHP.php,
  python: Python,
  go: Go,
  json: JSON_LANG,
  html: HTML,
  css: CSS,
  xml: Xml.xml,
};

export const EXT_LANG = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".tsx": "tsx",
  ".php": "php",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".json": "json",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".xml": "xml",
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

  /**
   * Parameter names declared by a function-like node.
   *
   * Without this, `function f(log) { log(); }` records a CALLS edge to
   * whatever project-wide symbol happens to be named "log" -- there is no
   * scope analysis, just a name match. Knowing the enclosing symbol's own
   * parameters lets `collectRefs` recognize a call to one of them as staying
   * local rather than resolving to an unrelated same-named symbol elsewhere.
   */
  function paramNames(fnNode) {
    const paramsNode = fnNode.childForFieldName("parameters");
    const names = new Set();
    if (!paramsNode) return names;

    function fromPattern(node) {
      switch (node.type) {
        case "identifier":
        case "variable_name": // PHP $foo
        case "shorthand_property_identifier_pattern":
          names.add(text(node));
          return;
        case "assignment_pattern": // JS default: (foo = def)
        case "object_assignment_pattern": // JS destructured default: ({ foo = def })
          fromPattern(node.childForFieldName("left") || node.namedChildren[0]);
          return;
        case "default_parameter": // Python (foo=def)
        case "typed_default_parameter":
          fromPattern(node.childForFieldName("name"));
          return;
        case "rest_pattern":
        case "spread_element":
        case "typed_parameter": // Python foo: int
        case "list_splat_pattern": // Python *args
        case "dictionary_splat_pattern": // Python **kwargs
          if (node.namedChildren[0]) fromPattern(node.namedChildren[0]);
          return;
        case "object_pattern":
        case "array_pattern":
          for (const c of node.namedChildren) fromPattern(c);
          return;
        case "pair_pattern": // JS destructured rename: { foo: bar }
          fromPattern(node.childForFieldName("value") || node.namedChildren.at(-1));
          return;
        default: {
          // TS required_parameter/optional_parameter expose the bound name via
          // a "pattern" field; Go's `a, b int` has no such field, so fall back
          // to any identifier/variable_name children directly.
          const pattern = node.childForFieldName("pattern");
          if (pattern) {
            fromPattern(pattern);
          } else {
            for (const c of node.namedChildren) {
              if (c.type === "identifier" || c.type === "variable_name") names.add(text(c));
            }
          }
        }
      }
    }

    for (const p of paramsNode.namedChildren) fromPattern(p);
    return names;
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
  function collectRefs(node, owner, params = new Set()) {
    // A bare identifier matching one of `owner`'s own parameters is a call to
    // that local/injected value, not to a same-named project symbol -- see
    // `paramNames`. Member/scoped access (`this.log()`, `Class::log()`) is
    // never a bare identifier, so it's unaffected.
    const isLocalParam = (calleeNode, calleeText) =>
      (calleeNode.type === "identifier" || calleeNode.type === "variable_name") && params.has(calleeText);

    const cursor = node.walk();
    const visit = (n) => {
      switch (n.type) {
        // ---- JS/TS ----
        case "call_expression": {
          const fn = n.childForFieldName("function");
          if (fn) {
            const callee = text(fn).slice(0, 200);
            if (!isLocalParam(fn, callee)) {
              relations.push({ srcName: owner, relation: "CALLS", dstName: callee, line: line(n) });
            }
          }
          break;
        }
        case "new_expression": {
          const ctor = n.childForFieldName("constructor");
          if (ctor) {
            const target = text(ctor).slice(0, 200);
            if (!isLocalParam(ctor, target)) {
              relations.push({ srcName: owner, relation: "INSTANTIATES", dstName: target, line: line(n) });
            }
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
          } else if (!isLocalParam(fn, callee)) {
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
            const target = text(cls).slice(0, 200);
            if (!isLocalParam(cls, target)) {
              relations.push({ srcName: owner, relation: "INSTANTIATES", dstName: target, line: line(n) });
            }
          }
          break;
        }
        // ---- Python ----
        // Python's call node is `call`, not `call_expression`. It covers both
        // plain calls and constructor invocation, since Python has no `new`.
        case "call": {
          const fn = n.childForFieldName("function");
          if (fn) {
            const callee = text(fn).slice(0, 200);
            if (!isLocalParam(fn, callee)) {
              relations.push({ srcName: owner, relation: "CALLS", dstName: callee, line: line(n) });
            }
          }
          break;
        }
        // ---- Go ----
        // `Server{...}` / `&Server{...}` -- the closest thing Go has to `new`.
        case "composite_literal": {
          const typeNode = n.childForFieldName("type");
          if (typeNode) {
            relations.push({ srcName: owner, relation: "INSTANTIATES", dstName: text(typeNode).slice(0, 200), line: line(n) });
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

  // Member node types that count as methods, by language family:
  //   JS/TS  method_definition
  //   PHP    method_declaration
  //   Python function_definition (inside a `block`, possibly decorated)
  const METHOD_TYPES = new Set(["method_definition", "method_declaration", "function_definition"]);

  function classMembers(classNode, className, bodyField) {
    const body = classNode.childForFieldName(bodyField) || classNode.namedChildren.find((c) => c.type.endsWith("body"));
    if (!body) return;
    for (const raw of body.namedChildren) {
      // Python decorators wrap the definition they annotate.
      const m = raw.type === "decorated_definition"
        ? raw.namedChildren.find((c) => METHOD_TYPES.has(c.type)) || raw
        : raw;
      if (METHOD_TYPES.has(m.type)) {
        const nameNode = m.childForFieldName("name");
        if (!nameNode) continue;
        const full = `${className}::${text(nameNode)}`;
        addSymbol(full, "method", m);
        collectRefs(m, full, paramNames(m));
      }
    }
  }

  /** `func (s *Server) Handle()` -> "Server", so the method is named Server::Handle. */
  function goReceiverType(node) {
    const receiver = node.childForFieldName("receiver");
    if (!receiver) return null;
    const decl = receiver.namedChildren.find((c) => c.type === "parameter_declaration");
    const typeNode = decl?.childForFieldName("type") || decl?.namedChildren.at(-1);
    return typeNode ? text(typeNode).replace(/^\*/, "") : null;
  }

  function heritage(classNode, className) {
    const emit = (relation, target, at) => {
      // Generic arguments (`extends Base<T>`) are separate named children of
      // the clause; the edge belongs on the base type, not on "<T>".
      if (target.type === "type_arguments" || target.type === "type_parameters") return;
      relations.push({ srcName: className, relation, dstName: text(target).slice(0, 200), line: line(at) });
    };

    const visitClause = (c) => {
      switch (c.type) {
        case "class_heritage":
          // TypeScript nests extends_clause/implements_clause inside
          // class_heritage; plain JavaScript puts the base type directly in
          // it. Recursing handles both -- without this, a TS `implements`
          // was emitted as EXTENDS with the clause's whole text ("implements
          // Shape") as the target, which could never resolve to a symbol.
          for (const inner of c.namedChildren) {
            if (inner.type === "extends_clause" || inner.type === "implements_clause") visitClause(inner);
            else emit("EXTENDS", inner, c);
          }
          break;
        case "extends_clause":
        case "base_clause": // PHP
          for (const t of c.namedChildren) emit("EXTENDS", t, c);
          break;
        case "implements_clause":
        case "class_interface_clause": // PHP
          for (const t of c.namedChildren) emit("IMPLEMENTS", t, c);
          break;
      }
    };

    for (const c of classNode.namedChildren) visitClause(c);
  }

  // ---- JSON / CSS / HTML / XML --------------------------------------
  //
  // None of these have functions, classes, or calls, so they skip
  // collectRefs/paramNames/heritage entirely and never produce relations --
  // just a flat walk emitting addSymbol() for whatever counts as a
  // "symbol" in that grammar.

  function walkJson(node) {
    for (const c of node.namedChildren) {
      if (c.type === "pair") {
        const keyNode = c.childForFieldName("key");
        addSymbol(keyNode ? stripQuotes(text(keyNode)) : "?", "key", c);
      }
      walkJson(c);
    }
  }

  /** Text of an at-rule up to (not including) its block, e.g. "@media screen". */
  function atRuleName(node, blockChild) {
    const end = blockChild ? blockChild.startIndex : node.endIndex;
    return text(node).slice(0, end - node.startIndex).trim().replace(/;$/, "").replace(/\s+/g, " ").slice(0, 200);
  }

  function walkCss(node) {
    for (const c of node.namedChildren) {
      if (c.type === "rule_set") {
        const selectors = c.namedChildren.find((k) => k.type === "selectors");
        addSymbol(selectors ? text(selectors).trim().slice(0, 200) : "?", "rule", c);
      } else if (c.type.endsWith("_statement")) {
        // at-rules: @media, @supports use a plain "block"; @keyframes uses
        // "keyframe_block_list" -- both just need *some* body child to cut
        // the prelude text off before. @import/@charset have no body at all.
        const block = c.namedChildren.find((k) => k.type.includes("block"));
        addSymbol(atRuleName(c, block), "rule", c);
      }
      walkCss(c);
    }
  }

  /** id/class attribute value off a start_tag/self_closing_tag node, or null. */
  function htmlAttr(tagNode, attrName) {
    for (const a of tagNode.namedChildren) {
      if (a.type !== "attribute") continue;
      const nameNode = a.namedChildren.find((k) => k.type === "attribute_name");
      if (!nameNode || text(nameNode) !== attrName) continue;
      const valueNode = a.namedChildren.find(
        (k) => k.type === "quoted_attribute_value" || k.type === "attribute_value"
      );
      if (!valueNode) return "";
      const inner = valueNode.namedChildren.find((k) => k.type === "attribute_value") || valueNode;
      return text(inner);
    }
    return null;
  }

  function walkHtml(node) {
    for (const c of node.namedChildren) {
      if (c.type === "element" || c.type === "script_element" || c.type === "style_element") {
        const tagNode = c.namedChildren.find((k) => k.type === "start_tag" || k.type === "self_closing_tag");
        const tagNameNode = tagNode?.namedChildren.find((k) => k.type === "tag_name");
        if (tagNode && tagNameNode) {
          const tag = text(tagNameNode);
          const id = htmlAttr(tagNode, "id");
          const cls = htmlAttr(tagNode, "class");
          if (id) addSymbol(`${tag}#${id}`, "element", c);
          else if (cls) addSymbol(`${tag}.${cls.trim().split(/\s+/)[0]}`, "element", c);
        }
      }
      walkHtml(c);
    }
  }

  function walkXml(node) {
    for (const c of node.namedChildren) {
      if (c.type === "element") {
        const tagNode = c.namedChildren.find((k) => k.type === "STag" || k.type === "EmptyElemTag");
        const nameNode = tagNode?.namedChildren.find((k) => k.type === "Name");
        addSymbol(nameNode ? text(nameNode) : "?", "element", c);
      }
      walkXml(c);
    }
  }

  const MARKUP_WALKERS = { json: walkJson, css: walkCss, html: walkHtml, xml: walkXml };

  function walkTopLevel(node, namespace = "") {
    // Mutable, because PHP's statement-form `namespace App;` has no body and
    // applies to every following sibling in the file rather than to a block.
    let ns = namespace;
    for (const n of node.namedChildren) {
      switch (n.type) {
        // ---- shared ----
        case "class_declaration": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = ns + text(nameNode);
          addSymbol(name, "class", n);
          heritage(n, name);
          classMembers(n, name, "body");
          break;
        }
        case "interface_declaration": {
          const nameNode = n.childForFieldName("name");
          if (nameNode) addSymbol(ns + text(nameNode), "interface", n);
          break;
        }
        // ---- JS/TS ----
        case "function_declaration":
        case "generator_function_declaration": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = ns + text(nameNode);
          addSymbol(name, "function", n);
          collectRefs(n, name, paramNames(n));
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
              const name = ns + text(nameNode);
              addSymbol(name, "function", n);
              collectRefs(value, name, paramNames(value));
            }
          }
          break;
        }
        case "import_statement": {
          // JS: `import x from "mod"` has a `source` field. Python's
          // import_statement shares the node name but has no source field --
          // the module path is the node's own text after the keyword.
          const srcNode = n.childForFieldName("source");
          if (srcNode) {
            relations.push({ srcName: "@file", relation: "IMPORTS", dstName: stripQuotes(text(srcNode)), line: line(n) });
          } else {
            for (const mod of n.namedChildren) {
              relations.push({ srcName: "@file", relation: "IMPORTS", dstName: text(mod).slice(0, 200), line: line(n) });
            }
          }
          break;
        }
        // ---- Python ----
        case "import_from_statement": {
          const moduleNode = n.childForFieldName("module_name");
          if (moduleNode) {
            relations.push({ srcName: "@file", relation: "IMPORTS", dstName: text(moduleNode).slice(0, 200), line: line(n) });
          }
          break;
        }
        case "decorated_definition": {
          walkTopLevel(n, ns); // unwrap "@app.route(...) def handler(): ..."
          break;
        }
        case "class_definition": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = ns + text(nameNode);
          addSymbol(name, "class", n);
          // Base classes live in an argument_list, not a heritage clause.
          const bases = n.childForFieldName("superclasses");
          if (bases) {
            for (const base of bases.namedChildren) {
              relations.push({ srcName: name, relation: "EXTENDS", dstName: text(base).slice(0, 200), line: line(bases) });
            }
          }
          classMembers(n, name, "body");
          break;
        }
        // ---- Go ----
        case "method_declaration": {
          // Go attaches methods to a receiver type rather than nesting them in
          // the type declaration, so they arrive at the top level.
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const receiver = goReceiverType(n);
          const name = ns + (receiver ? `${receiver}::${text(nameNode)}` : text(nameNode));
          addSymbol(name, receiver ? "method" : "function", n);
          collectRefs(n, name, paramNames(n));
          break;
        }
        case "type_declaration": {
          for (const spec of n.namedChildren) {
            if (spec.type !== "type_spec") continue;
            const nameNode = spec.childForFieldName("name");
            if (!nameNode) continue;
            const kindNode = spec.childForFieldName("type");
            const kind = kindNode?.type === "interface_type" ? "interface" : "class";
            addSymbol(ns + text(nameNode), kind, spec);
          }
          break;
        }
        case "import_declaration": {
          // `import "fmt"` puts the spec directly under the declaration;
          // a grouped `import ( ... )` nests them in an import_spec_list.
          const specs = n.namedChildren.flatMap((c) =>
            c.type === "import_spec_list" ? c.namedChildren : [c]
          );
          for (const spec of specs) {
            if (spec.type !== "import_spec") continue;
            const pathNode = spec.childForFieldName("path") || spec.namedChildren.at(-1);
            if (pathNode) {
              relations.push({ srcName: "@file", relation: "IMPORTS", dstName: stripQuotes(text(pathNode)), line: line(spec) });
            }
          }
          break;
        }
        case "export_statement": {
          walkTopLevel(n, ns); // unwrap "export function foo() {}"
          break;
        }
        // ---- PHP ----
        case "function_definition": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = ns + text(nameNode);
          addSymbol(name, "function", n);
          collectRefs(n, name, paramNames(n));
          break;
        }
        case "trait_declaration": {
          const nameNode = n.childForFieldName("name");
          if (!nameNode) break;
          const name = ns + text(nameNode);
          addSymbol(name, "trait", n);
          classMembers(n, name, "body");
          break;
        }
        case "namespace_definition": {
          const nameNode = n.childForFieldName("name");
          const declared = nameNode ? text(nameNode) + "\\" : "";
          const body = n.childForFieldName("body");
          if (body) {
            // Braced form: `namespace App { ... }` -- scoped to the block.
            walkTopLevel(body, declared);
          } else {
            // Statement form: `namespace App;` -- applies to the rest of the
            // file. This is the form PSR-4/PSR-12 mandate, so it covers most
            // modern PHP. Previously it prefixed nothing, because the
            // declarations are siblings of this node rather than children,
            // which made `App\Billing\Invoice` and `App\Domain\Invoice`
            // collide as a bare `Invoice`.
            ns = declared;
          }
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
            walkTopLevel(n, ns);
          }
        }
      }
    }
  }

  if (MARKUP_WALKERS[lang]) {
    MARKUP_WALKERS[lang](tree.rootNode);
  } else {
    walkTopLevel(tree.rootNode);
  }
  return { symbols, relations };
}
