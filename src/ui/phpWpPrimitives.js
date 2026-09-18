import Parser from "tree-sitter";
import PHP from "tree-sitter-php";

/**
 * Increment 1A UI recognition, phase 1A-2: WordPress core UI-primitive
 * callsites -- REQ-016 (`submit_button()`), REQ-017 (`add_menu_page()` /
 * `add_submenu_page()`), REQ-018 (`add_settings_section()` /
 * `add_settings_field()` / `do_settings_sections()`).
 *
 * This is a sibling extractor to src/ui/phpElements.js, not an extension of
 * it: phpElements.js recognizes literal/echoed HTML markup via a second
 * tree-sitter-html sub-parse; this module recognizes *function-call* AST
 * nodes in the same PHP source and never touches HTML at all. Both are pure
 * and DB-free -- src/indexer.js owns writing results into
 * `entities`/`entity_links`, merging this module's `elements` output into
 * the same array phpElements.js produces before calling writeUiElements().
 *
 * `I18N_WRAPPERS`/`stripQuotes` are intentionally duplicated from
 * phpElements.js rather than imported -- see contracts.md "Phase 1A-2 module
 * boundary" for why: 1A-1's file stays untouched (and its tests keep
 * covering exactly what they always covered) rather than gaining new exports
 * whose only consumer is this module.
 */

let phpParser = null;
function getPhpParser() {
  if (!phpParser) {
    phpParser = new Parser();
    phpParser.setLanguage(PHP.php);
  }
  return phpParser;
}

const I18N_WRAPPERS = new Set(["__", "_e", "esc_html__", "esc_html_e", "esc_attr__", "esc_attr_e", "_x", "_ex"]);

function stripQuotes(s) {
  return s.replace(/^['"`]|['"`]$/g, "");
}

/**
 * Resolve a single PHP expression node to a literal string, in the same
 * Q-003-bounded (in-file, deterministic, no data-flow beyond the syntactic
 * call site) spirit as EDGE-009's echo-concatenation resolution in
 * phpElements.js: plain strings pass through, `.`-concatenation is summed,
 * and the first string argument of a recognized i18n wrapper call
 * (`__, _e, esc_html__, ...`) counts as a literal fragment. Anything else
 * (a bare variable, another function call, a ternary, ...) marks the result
 * `dynamic` instead of fabricating a value.
 *
 * @returns {{ value: string|null, dynamic: boolean, i18nKey: string|null }}
 *   `value` is `null` only when nothing literal could be recovered at all;
 *   a partially-dynamic concatenation still returns its literal fragments
 *   with `dynamic: true`, mirroring `has_dynamic_text` elsewhere.
 */
function resolveLiteralArg(node, text) {
  if (!node) return { value: null, dynamic: false, i18nKey: null };
  let dynamic = false;
  let i18nKey = null;

  function walk(n) {
    if (n.type === "string" || n.type === "encapsed_string") return stripQuotes(text(n));
    if (n.type === "parenthesized_expression") {
      const inner = n.namedChildren[0];
      return inner ? walk(inner) : "";
    }
    if (n.type === "binary_expression") {
      const op = n.childForFieldName("operator");
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (op && text(op) === "." && left && right) return walk(left) + walk(right);
      dynamic = true;
      return "";
    }
    if (n.type === "function_call_expression") {
      const fn = n.childForFieldName("function");
      const fnName = fn ? text(fn) : "";
      if (I18N_WRAPPERS.has(fnName)) {
        const argsNode = n.childForFieldName("arguments");
        const firstArg = argsNode?.namedChildren.find((a) => a.type === "argument")?.namedChildren[0]
          ?? argsNode?.namedChildren[0];
        if (firstArg && (firstArg.type === "string" || firstArg.type === "encapsed_string")) {
          const key = stripQuotes(text(firstArg));
          if (i18nKey === null) i18nKey = key;
          return key;
        }
      }
      dynamic = true;
      return "";
    }
    dynamic = true;
    return "";
  }

  const raw = walk(node);
  return { value: dynamic && raw === "" ? null : raw, dynamic, i18nKey };
}

/**
 * Resolve a WP-style callable argument to the same owner-identity string
 * phpElements.js/src/parser.js already use ("fnName" or "Class::method"),
 * so it can be matched against this file's own `symbols.name` without a
 * second naming convention (see contracts.md "What 1A-2 needs to know" in
 * the 1A-1 section). Q-003-bounded: only forms resolvable from syntax alone.
 *
 *   'function_name'                 -> "function_name"
 *   array($this, 'method')          -> "<enclosingClass>::method" (class body only)
 *   array(__CLASS__, 'method')      -> "<enclosingClass>::method" (class body only)
 *   array('LiteralClass', 'method') -> "LiteralClass::method"
 *   anything else (a variable object, a Closure, first-class callable
 *   syntax, a dynamic method name, ...) -> null, never fabricated.
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

/** Literal string value of `array('key' => 'value', ...)[key]`, or null if absent/not a literal. */
function arrayLiteralGet(node, text, key) {
  if (!node || node.type !== "array_creation_expression") return null;
  for (const item of node.namedChildren) {
    if (item.type !== "array_element_initializer" || item.namedChildren.length !== 2) continue;
    const [k, v] = item.namedChildren;
    if ((k.type === "string" || k.type === "encapsed_string") && stripQuotes(text(k)) === key) {
      if (v.type === "string" || v.type === "encapsed_string") return stripQuotes(text(v));
    }
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
 * Extract WordPress UI-primitive registrations from one PHP source file.
 * @param {string} source
 * @returns {{ elements: object[], screens: object[], settingsSections: object[], settingsFields: object[] }}
 */
export function extractPhpWpPrimitives(source) {
  const tree = getPhpParser().parse(source, null, { bufferSize: source.length + 1024 });
  const text = (node) => source.slice(node.startIndex, node.endIndex);

  const elements = [];
  const screens = [];
  const settingsSections = [];
  const settingsFields = [];
  const renderSites = []; // do_settings_sections() call sites, correlated in-file only below

  function emitSubmitButton(node, owner, line) {
    const [textNode, , nameNode, , otherAttrsNode] = positionalArgs(node);
    const textRes = textNode ? resolveLiteralArg(textNode, text) : { value: "Save Changes", dynamic: false, i18nKey: null };
    const nameRes = nameNode ? resolveLiteralArg(nameNode, text) : { value: "submit", dynamic: false, i18nKey: null };
    const ariaLabel = arrayLiteralGet(otherAttrsNode, text, "aria-label");
    const titleAttr = arrayLiteralGet(otherAttrsNode, text, "title");
    const placeholder = arrayLiteralGet(otherAttrsNode, text, "placeholder");
    const alt = arrayLiteralGet(otherAttrsNode, text, "alt");
    const dataTestId = arrayLiteralGet(otherAttrsNode, text, "data-testid");
    elements.push({
      tag: "input", type: "button", role: null,
      text: textRes.value ?? "", textSource: textRes.value ? "child_text" : null,
      ariaLabel, title: titleAttr, placeholder, alt,
      name: nameRes.value, dataTestId,
      hasDynamicText: textRes.dynamic,
      i18nKey: textRes.i18nKey ?? null,
      owner, line, extraction: "wp_primitive",
    });
  }

  function emitScreen(node, owner, className, line, registrationFn) {
    const positional = positionalArgs(node);
    let pageTitleNode, menuTitleNode, capabilityNode, slugNode, callbackNode, parentSlugNode;
    if (registrationFn === "add_menu_page") {
      [pageTitleNode, menuTitleNode, capabilityNode, slugNode, callbackNode] = positional;
    } else {
      [parentSlugNode, pageTitleNode, menuTitleNode, capabilityNode, slugNode, callbackNode] = positional;
    }
    const pageTitle = resolveLiteralArg(pageTitleNode, text);
    const menuTitle = resolveLiteralArg(menuTitleNode, text);
    const capability = resolveLiteralArg(capabilityNode, text);
    const slug = resolveLiteralArg(slugNode, text);
    const parentSlug = parentSlugNode ? resolveLiteralArg(parentSlugNode, text) : { value: null, dynamic: false };
    const renderer = resolveCallable(callbackNode, text, className);
    const hasDynamicArgs = [pageTitle, menuTitle, slug, parentSlug].some((r) => r.dynamic);

    screens.push({
      owner, line, registrationFn,
      pageTitle: pageTitle.value, menuTitle: menuTitle.value, slug: slug.value,
      capability: capability.value, parentSlug: parentSlug.value,
      renderer, hasDynamicArgs,
    });
  }

  function emitSection(node, owner, className, line) {
    const [idNode, titleNode, callbackNode, pageNode] = positionalArgs(node);
    const id = resolveLiteralArg(idNode, text);
    const title = resolveLiteralArg(titleNode, text);
    const page = resolveLiteralArg(pageNode, text);
    const callback = resolveCallable(callbackNode, text, className);
    settingsSections.push({
      owner, line, registrationFn: "add_settings_section",
      sectionId: id.value, title: title.value, page: page.value, callback,
      hasDynamicArgs: id.dynamic || title.dynamic || page.dynamic,
      renderedAt: null,
    });
  }

  function emitField(node, owner, className, line) {
    const [idNode, titleNode, callbackNode, pageNode, sectionNode, argsNode] = positionalArgs(node);
    const id = resolveLiteralArg(idNode, text);
    const title = resolveLiteralArg(titleNode, text);
    const page = resolveLiteralArg(pageNode, text);
    const section = sectionNode ? resolveLiteralArg(sectionNode, text) : { value: "default", dynamic: false };
    const callback = resolveCallable(callbackNode, text, className);
    const labelFor = arrayLiteralGet(argsNode, text, "label_for");
    settingsFields.push({
      owner, line, registrationFn: "add_settings_field",
      fieldId: id.value, title: title.value, page: page.value, section: section.value, callback, labelFor,
      hasDynamicArgs: id.dynamic || title.dynamic || page.dynamic || section.dynamic,
      renderedAt: null,
    });
  }

  function emitRenderSite(node, owner, line) {
    const [pageNode] = positionalArgs(node);
    const page = resolveLiteralArg(pageNode, text);
    if (page.value) renderSites.push({ owner, line, page: page.value });
  }

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
        switch (fnName) {
          case "submit_button": emitSubmitButton(node, owner, line); break;
          case "add_menu_page": emitScreen(node, owner, className, line, "add_menu_page"); break;
          case "add_submenu_page": emitScreen(node, owner, className, line, "add_submenu_page"); break;
          case "add_settings_section": emitSection(node, owner, className, line); break;
          case "add_settings_field": emitField(node, owner, className, line); break;
          case "do_settings_sections": emitRenderSite(node, owner, line); break;
        }
        break;
      }
    }
    for (const c of node.namedChildren) walk(c, owner, className);
  }

  walk(tree.rootNode, "@file", null);

  // do_settings_sections($page) is recognized (REQ-018) but does not become
  // its own entity or a new relation type: correlating "this page is
  // rendered here" against sections/fields registered in another file is
  // cross-file, outside Q-003's in-file bound, and is exactly the kind of
  // project-wide resolution 1A-6's post-pass exists for. Within this one
  // file, though, the correlation is deterministic and free, so it's done
  // here and handed to 1A-6 as a ready fact (`data.rendered_at`) rather than
  // making 1A-6 re-derive it. See contracts.md "Phase 1A-2" for the reasoning.
  for (const site of renderSites) {
    for (const sec of settingsSections) {
      if (sec.page && sec.page === site.page) sec.renderedAt = { owner: site.owner, line: site.line };
    }
    for (const f of settingsFields) {
      if (f.page && f.page === site.page) f.renderedAt = { owner: site.owner, line: site.line };
    }
  }

  return { elements, screens, settingsSections, settingsFields };
}
