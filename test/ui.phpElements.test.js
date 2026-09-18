import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPhpUiElements } from "../src/ui/phpElements.js";

// Unit tests for the pure, DB-free extraction function. Integration through
// indexProject (entities writes, tombstone lifecycle, ui.enabled gate) lives
// in test/indexer.uiElements.test.js.

test("literal HTML between php tags: semantic tags land with type/text/line/owner", () => {
  const src = `<?php
function render_widget() {
  ?>
  <h2>Section title</h2>
  <button>Save</button>
  <?php
}
`;
  const els = extractPhpUiElements(src);
  const h2 = els.find((e) => e.tag === "h2");
  const btn = els.find((e) => e.tag === "button");
  assert.ok(h2, "heading should be extracted");
  assert.equal(h2.type, "heading");
  assert.equal(h2.text, "Section title");
  assert.equal(h2.textSource, "child_text");
  assert.equal(h2.owner, "render_widget");
  assert.equal(h2.line, 4);
  assert.ok(btn);
  assert.equal(btn.type, "button");
  assert.equal(btn.owner, "render_widget");
});

test("structural tags without an identity attribute are not indexed", () => {
  const src = `<?php
?>
<div class="plain">just a wrapper</div>
<span>bare span</span>
<?php
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 0);
});

test("REQ-002: a11y/identity attributes resolve as text sources, in precedence order", () => {
  const src = `<?php
?>
<a href="#" role="button" aria-label="Go to dashboard"><span class="icon"></span> Dashboard</a>
<input type="text" placeholder="Search" name="q" data-testid="search-input" />
<input type="text" aria-label="Filter" />
<?php
`;
  const els = extractPhpUiElements(src);
  const link = els.find((e) => e.tag === "a");
  const search = els.find((e) => e.dataTestId === "search-input");
  const filterInput = els.find((e) => e.ariaLabel === "Filter");

  // child text present -> wins over aria-label even though both are set
  assert.equal(link.text, "Dashboard");
  assert.equal(link.textSource, "child_text");
  assert.equal(link.role, "button");
  assert.equal(link.type, "button"); // explicit role wins over tag-based mapping

  // no child text -> falls back to placeholder
  assert.equal(search.text, "Search");
  assert.equal(search.textSource, "placeholder");
  assert.equal(search.name, "q");

  // no child text, no placeholder -> falls back to aria-label
  assert.equal(filterInput.text, "Filter");
  assert.equal(filterInput.textSource, "aria_label");
});

test("self-closing input with no text/attrs still lands with an empty text and null textSource", () => {
  const src = `<?php
?>
<input type="submit" value="Go" />
<?php
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 1);
  assert.equal(els[0].type, "button"); // input[type=submit] maps to "button"
  assert.equal(els[0].text, "");
  assert.equal(els[0].textSource, null);
});

test("owner attribution: file-level, plain function, and Class::method", () => {
  const src = `<?php
?>
<h1>Top level</h1>
<?php
function plain_fn() {
  ?>
  <h2>In function</h2>
  <?php
}
class Widget {
  public function render() {
    ?>
    <h3>In method</h3>
    <?php
  }
}
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.find((e) => e.tag === "h1").owner, "@file");
  assert.equal(els.find((e) => e.tag === "h2").owner, "plain_fn");
  assert.equal(els.find((e) => e.tag === "h3").owner, "Widget::render");
});

test("echo concatenation: literal-only chain is fully recovered", () => {
  const src = `<?php
echo '<button>' . 'Save' . '</button>';
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 1);
  assert.equal(els[0].tag, "button");
  assert.equal(els[0].text, "Save");
  assert.equal(els[0].hasDynamicText, false);
  assert.equal(els[0].extraction, "echo_concat");
});

test("EDGE-009: echo concatenation through a recognized i18n wrapper resolves the literal argument and records i18n_key", () => {
  const src = `<?php
echo '<button aria-label="Save item" title="Save">' . esc_html__('Save', 'text-domain') . '</button>';
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 1);
  const el = els[0];
  assert.equal(el.tag, "button");
  assert.equal(el.text, "Save");
  assert.equal(el.ariaLabel, "Save item");
  assert.equal(el.hasDynamicText, false);
  assert.equal(el.i18nKey, "Save");
});

test("EDGE-009: echo concatenation with a bare variable sets hasDynamicText and drops the placeholder from text", () => {
  const src = `<?php
echo '<button>' . $label . '</button>';
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 1);
  assert.equal(els[0].tag, "button");
  assert.equal(els[0].text, "");
  assert.equal(els[0].hasDynamicText, true);
});

test("EDGE-009: an all-dynamic echo with no literal tag produces no entity at all", () => {
  const src = `<?php
echo $fully_dynamic_markup;
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 0);
});

test("EDGE-009: a dynamic value inside an identity attribute is treated as absent, not as garbled placeholder text", () => {
  const src = `<?php
echo '<button aria-label="' . $dynamic_label . '">' . 'Save' . '</button>';
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 1);
  assert.equal(els[0].ariaLabel, null);
  assert.equal(els[0].hasDynamicText, true);
  // The literal child text is still usable even though the attribute was dynamic.
  assert.equal(els[0].text, "Save");
});

test("nested element text is concatenated into the ancestor's visible text", () => {
  const src = `<?php
?>
<button><span class="icon"></span> Save changes</button>
<?php
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 1);
  assert.equal(els[0].text, "Save changes");
});

test("leading top-level HTML before the first <?php tag is attributed to @file", () => {
  const src = `<h1>Leading markup</h1>
<?php
`;
  const els = extractPhpUiElements(src);
  assert.equal(els.length, 1);
  assert.equal(els[0].owner, "@file");
  assert.equal(els[0].text, "Leading markup");
});
