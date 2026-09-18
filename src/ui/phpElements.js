import Parser from "tree-sitter";
import PHP from "tree-sitter-php";
import HTML from "tree-sitter-html";

/**
 * Increment 1A UI element extraction: PHP-emitted literal HTML.
 *
 * Two independent parses are involved, not one grammar extension:
 *   1. tree-sitter-php walks the file for `text` nodes (literal HTML PHP
 *      outputs directly between `?>`/`<?php`) and `echo_statement`s that build
 *      HTML through string concatenation.
 *   2. Each candidate fragment is hard-parsed a second time with
 *      tree-sitter-html to pull out tag/attrs/text -- tree-sitter-php does not
 *      parse the HTML it emits at all, it hands it back as one opaque `text`
 *      node, confirmed empirically against the actual grammar.
 *
 * This module is pure and DB-free: it returns plain records, and never
 * imports src/db.js. src/indexer.js owns writing the results into
 * `entities`/`entity_links`.
 */

let phpParser = null;
function getPhpParser() {
  if (!phpParser) {
    phpParser = new Parser();
    phpParser.setLanguage(PHP.php);
  }
  return phpParser;
}

let htmlParser = null;
function getHtmlParser() {
  if (!htmlParser) {
    htmlParser = new Parser();
    htmlParser.setLanguage(HTML);
  }
  return htmlParser;
}

// Elements worth recording even with no a11y/identity attribute -- headings
// and controls are exactly what the brainstorm's "button/heading/etc" names.
// Bare structural tags (div/span/li/...) are only recorded when they carry an
// identity attribute (see IDENTITY_ATTRS below); nothing in REQ-001/REQ-002
// asks for structural markup, and indexing every div would make ui_element
// noise-dominated.
const SEMANTIC_TAGS = new Set([
  "button", "a", "input", "select", "textarea", "option", "label",
  "summary", "legend", "caption", "h1", "h2", "h3", "h4", "h5", "h6",
]);

// REQ-002's accessibility/identity attribute list, verbatim.
const IDENTITY_ATTRS = ["aria-label", "title", "placeholder", "alt", "role", "name", "data-testid"];

// WordPress/PHP gettext-family wrappers whose first argument is a literal
// translation source string. Recognizing these keeps the extracted text
// in-file and deterministic (Q-003's bound): the value used is the literal
// argument at the call site, not a resolved catalog lookup -- that stays
// 1A-4's job. See EDGE-009 in contracts.md.
const I18N_WRAPPERS = new Set(["__", "_e", "esc_html__", "esc_html_e", "esc_attr__", "esc_attr_e", "_x", "_ex"]);

// One-character placeholder substituted for every non-literal operand in an
// echo concatenation chain, so the reconstructed probe string still has
// balanced-looking tag structure for the HTML sub-parse. Chosen from the
// Private Use Area: for-all-practical-purposes never appears in real source.
const DYNAMIC_PLACEHOLDER = "";

function stripQuotes(s) {
  return s.replace(/^['"`]|['"`]$/g, "");
}

/**
 * Resolve an element's type/role (REQ-001) from its tag and attributes.
 * An explicit `role` attribute always wins; otherwise a small tag map, with
 * `<input>` further split by its `type` attribute since "input" alone tells a
 * task-matcher nothing about whether it means a text box or a submit button.
 */
function resolveType(tag, attrs) {
  if (attrs.role) return attrs.role;
  if (tag === "input") {
    const t = (attrs.type || "text").toLowerCase();
    if (["submit", "button", "reset"].includes(t)) return "button";
    return "textbox";
  }
  if (tag === "a") return "link";
  if (tag === "textarea") return "textbox";
  if (/^h[1-6]$/.test(tag)) return "heading";
  return tag;
}

/** All attribute name -> raw value pairs on a start_tag/self_closing_tag node. */
function attrsOf(tagNode, src) {
  const out = {};
  for (const a of tagNode.namedChildren) {
    if (a.type !== "attribute") continue;
    const nameNode = a.namedChildren.find((k) => k.type === "attribute_name");
    if (!nameNode) continue;
    const name = src.slice(nameNode.startIndex, nameNode.endIndex).toLowerCase();
    const valueNode = a.namedChildren.find(
      (k) => k.type === "quoted_attribute_value" || k.type === "attribute_value"
    );
    let value = "";
    if (valueNode) {
      const inner = valueNode.namedChildren.find((k) => k.type === "attribute_value") || valueNode;
      value = src.slice(inner.startIndex, inner.endIndex);
    }
    out[name] = value;
  }
  return out;
}

/** Concatenated text of every descendant `text` node under an html `element`. */
function collectText(node) {
  const parts = [];
  const walk = (n) => {
    if (n.type === "text") {
      parts.push(n.text ?? "");
      return;
    }
    if (n.type === "start_tag" || n.type === "end_tag" || n.type === "self_closing_tag") return;
    for (const c of n.namedChildren) walk(c);
  };
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * REQ-002 text-source resolution: literal child text first, then the a11y/
 * identity attributes in the order the spec's text_source precedence gives
 * them (contracts.md) for the tiers this index-time phase can see. A value
 * containing the dynamic placeholder is not a usable literal -- treated as
 * absent, and the caller has already set hasDynamicText for the fragment it
 * came from.
 */
function resolvePrimaryText(childText, attrs) {
  const usable = (v) => (v !== undefined && v !== null && !v.includes(DYNAMIC_PLACEHOLDER) ? v.trim() : "");
  if (usable(childText)) return { text: childText.trim(), textSource: "child_text" };
  for (const [attr, source] of [
    ["aria-label", "aria_label"], ["title", "title"], ["placeholder", "placeholder"], ["alt", "alt"],
  ]) {
    const v = usable(attrs[attr]);
    if (v) return { text: v, textSource: source };
  }
  return { text: "", textSource: null };
}

/** Walk an HTML (sub-)tree, emitting one record per "interesting" element. */
function walkHtmlForElements(root, fragSrc, originRow, owner, extraction, emit) {
  const walk = (n) => {
    if (n.type === "element") {
      const tagNode = n.namedChildren.find((k) => k.type === "start_tag" || k.type === "self_closing_tag");
      const tagNameNode = tagNode?.namedChildren.find((k) => k.type === "tag_name");
      if (tagNode && tagNameNode) {
        const tag = fragSrc.slice(tagNameNode.startIndex, tagNameNode.endIndex).toLowerCase();
        const attrs = attrsOf(tagNode, fragSrc);
        const hasIdentityAttr = IDENTITY_ATTRS.some((a) => attrs[a] !== undefined);
        if (SEMANTIC_TAGS.has(tag) || hasIdentityAttr) {
          const childText = collectText(n);
          const dynamicAttr = IDENTITY_ATTRS.some((a) => attrs[a]?.includes(DYNAMIC_PLACEHOLDER));
          const hasDynamicText = childText.includes(DYNAMIC_PLACEHOLDER) || dynamicAttr;
          const cleanChildText = childText.replaceAll(DYNAMIC_PLACEHOLDER, "").replace(/\s+/g, " ").trim();
          const cleanAttrs = {};
          for (const [k, v] of Object.entries(attrs)) {
            cleanAttrs[k] = v.includes(DYNAMIC_PLACEHOLDER) ? null : v;
          }
          const { text, textSource } = resolvePrimaryText(cleanChildText, cleanAttrs);
          emit({
            tag,
            type: resolveType(tag, cleanAttrs),
            role: cleanAttrs.role ?? null,
            text,
            textSource,
            ariaLabel: cleanAttrs["aria-label"] ?? null,
            title: cleanAttrs.title ?? null,
            placeholder: cleanAttrs.placeholder ?? null,
            alt: cleanAttrs.alt ?? null,
            name: cleanAttrs.name ?? null,
            dataTestId: cleanAttrs["data-testid"] ?? null,
            hasDynamicText,
            owner,
            line: originRow + n.startPosition.row + 1,
            extraction,
          });
        }
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
}

/** Parse `fragment` as HTML and emit any interesting elements found in it. */
function extractFromFragment(fragment, originRow, owner, extraction, emit) {
  if (!fragment.includes("<")) return; // cheap skip: no tag, nothing to find
  const tree = getHtmlParser().parse(fragment);
  walkHtmlForElements(tree.rootNode, fragment, originRow, owner, extraction, emit);
}

/**
 * Reconstruct a probe string from an echo's `.`-concatenation chain: literal
 * string operands (and the literal first argument of a recognized i18n
 * wrapper call) pass through verbatim; everything else -- variables, other
 * calls, ternaries -- becomes one DYNAMIC_PLACEHOLDER character so the
 * surrounding tag structure survives the HTML sub-parse.
 *
 * This is the EDGE-009 resolution: dynamic label text is recorded as far as
 * its literal fragments go, never fabricated and never silently dropped
 * whole. See contracts.md for the write-up.
 */
function reconstructEchoProbe(exprNode, text) {
  let i18nKey = null;

  function literalOf(stringNode) {
    // PHP "string" node covers both '...' and "..." (encapsed) forms; take
    // its raw text and strip the surrounding quotes. Double-quoted strings
    // with variable interpolation still parse as "string" here -- their
    // interpolated part just rides along as literal text, a known, documented
    // approximation (see contracts.md "known limitations").
    return stripQuotes(text(stringNode));
  }

  function operand(node) {
    if (node.type === "string" || node.type === "encapsed_string") {
      return literalOf(node);
    }
    if (node.type === "function_call_expression") {
      const fn = node.childForFieldName("function");
      const fnName = fn ? text(fn) : "";
      if (I18N_WRAPPERS.has(fnName)) {
        const argsNode = node.childForFieldName("arguments");
        const firstArg = argsNode?.namedChildren.find((a) => a.type === "argument")?.namedChildren[0]
          ?? argsNode?.namedChildren[0];
        if (firstArg && (firstArg.type === "string" || firstArg.type === "encapsed_string")) {
          const key = literalOf(firstArg);
          if (i18nKey === null) i18nKey = key;
          return key;
        }
      }
    }
    return DYNAMIC_PLACEHOLDER;
  }

  function walk(node) {
    if (node.type === "binary_expression") {
      const op = node.childForFieldName("operator");
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (op && text(op) === "." && left && right) {
        return walk(left) + walk(right);
      }
      return DYNAMIC_PLACEHOLDER;
    }
    if (node.type === "parenthesized_expression") {
      const inner = node.namedChildren[0];
      return inner ? walk(inner) : DYNAMIC_PLACEHOLDER;
    }
    return operand(node);
  }

  return { probe: walk(exprNode), i18nKey };
}

/**
 * Extract UI elements from one PHP source file.
 * @param {string} source
 * @returns {Array<object>} element records, DB-free (see module doc)
 */
export function extractPhpUiElements(source) {
  const tree = getPhpParser().parse(source, null, { bufferSize: source.length + 1024 });
  const text = (node) => source.slice(node.startIndex, node.endIndex);
  const elements = [];
  const emit = (rec) => elements.push(rec);

  // Owner tracking: nearest enclosing function/method, qualified as
  // Class::method inside a class body, else the file-level sentinel "@file"
  // -- the same sentinel src/parser.js already uses for top-level PHP
  // expressions, so 1A-6 doesn't need a second convention to recognize.
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
      case "text": {
        extractFromFragment(text(node), node.startPosition.row, owner, "literal_html", emit);
        break;
      }
      case "echo_statement": {
        // First (only) expression child, ignoring the "echo" keyword and ";".
        const expr = node.namedChildren[0];
        if (expr) {
          const { probe, i18nKey } = reconstructEchoProbe(expr, text);
          const before = elements.length;
          extractFromFragment(probe, node.startPosition.row, owner, "echo_concat", emit);
          if (i18nKey) {
            for (let i = before; i < elements.length; i++) elements[i].i18nKey = i18nKey;
          }
        }
        break;
      }
    }
    for (const c of node.namedChildren) walk(c, owner, className);
  }

  walk(tree.rootNode, "@file", null);
  return elements;
}
