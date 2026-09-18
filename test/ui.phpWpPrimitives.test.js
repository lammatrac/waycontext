import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPhpWpPrimitives } from "../src/ui/phpWpPrimitives.js";

// Unit tests for the pure, DB-free WP-primitive extraction function (phase
// 1A-2: REQ-016/REQ-017/REQ-018). Integration through indexProject (entities
// + entity_links writes, tombstone lifecycle) lives in
// test/indexer.uiWpPrimitives.test.js.

test("REQ-016: submit_button() with a literal label is recognized as a button-shaped ui_element", () => {
  const src = `<?php
function render_form() {
  submit_button( 'Save Changes' );
}
`;
  const { elements } = extractPhpWpPrimitives(src);
  assert.equal(elements.length, 1);
  const el = elements[0];
  assert.equal(el.tag, "input");
  assert.equal(el.type, "button");
  assert.equal(el.text, "Save Changes");
  assert.equal(el.textSource, "child_text");
  assert.equal(el.owner, "render_form");
  assert.equal(el.extraction, "wp_primitive");
  assert.equal(el.hasDynamicText, false);
});

test("REQ-016: submit_button() with no arguments uses WP's documented defaults", () => {
  const src = `<?php
submit_button();
`;
  const { elements } = extractPhpWpPrimitives(src);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].text, "Save Changes");
  assert.equal(elements[0].name, "submit");
  assert.equal(elements[0].owner, "@file");
});

test("REQ-016: submit_button() label through a recognized i18n wrapper resolves the literal + records i18n_key", () => {
  const src = `<?php
submit_button( __( 'Save', 'text-domain' ), 'primary', 'save_btn' );
`;
  const { elements } = extractPhpWpPrimitives(src);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].text, "Save");
  assert.equal(elements[0].i18nKey, "Save");
  assert.equal(elements[0].name, "save_btn");
});

test("REQ-016: submit_button() with a dynamic label sets hasDynamicText instead of fabricating text", () => {
  const src = `<?php
submit_button( $label );
`;
  const { elements } = extractPhpWpPrimitives(src);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].text, "");
  assert.equal(elements[0].hasDynamicText, true);
});

test("REQ-016: submit_button()'s $other_attributes array literal populates identity attrs", () => {
  const src = `<?php
submit_button( 'Save', 'primary', 'submit', true, array( 'aria-label' => 'Save item', 'data-testid' => 'save-btn' ) );
`;
  const { elements } = extractPhpWpPrimitives(src);
  assert.equal(elements[0].ariaLabel, "Save item");
  assert.equal(elements[0].dataTestId, "save-btn");
});

test("REQ-017: add_menu_page() produces a ui_screen with menu text, page title, slug, route, renderer, callsite", () => {
  const src = `<?php
add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', 'my_render_cb', 'dashicons-admin-generic', 6 );
`;
  const { screens } = extractPhpWpPrimitives(src);
  assert.equal(screens.length, 1);
  const s = screens[0];
  assert.equal(s.registrationFn, "add_menu_page");
  assert.equal(s.pageTitle, "My Page Title");
  assert.equal(s.menuTitle, "My Menu");
  assert.equal(s.slug, "my-slug");
  assert.equal(s.renderer, "my_render_cb");
  assert.equal(s.owner, "@file");
  assert.equal(s.hasDynamicArgs, false);
});

test("REQ-017: add_submenu_page() captures parent_slug and resolves an array($this, 'method') renderer", () => {
  const src = `<?php
class Admin {
  public function boot() {
    add_submenu_page( 'parent-slug', 'Sub Page', 'Sub Menu', 'manage_options', 'sub-slug', array( $this, 'render_sub' ) );
  }
}
`;
  const { screens } = extractPhpWpPrimitives(src);
  assert.equal(screens.length, 1);
  const s = screens[0];
  assert.equal(s.registrationFn, "add_submenu_page");
  assert.equal(s.parentSlug, "parent-slug");
  assert.equal(s.slug, "sub-slug");
  assert.equal(s.renderer, "Admin::render_sub");
  assert.equal(s.owner, "Admin::boot");
});

test("REQ-017: an unresolvable renderer (a variable object) is left null, never fabricated", () => {
  const src = `<?php
add_menu_page( 'Page', 'Menu', 'manage_options', 'slug', array( $obj, 'render' ) );
`;
  const { screens } = extractPhpWpPrimitives(src);
  assert.equal(screens[0].renderer, null);
});

test("REQ-018: add_settings_section()/add_settings_field() extract id/title/page/callback/label_for", () => {
  const src = `<?php
class Settings {
  public function register() {
    add_settings_section( 'sec_id', 'Section Title', array( __CLASS__, 'render_section' ), 'my-page' );
    add_settings_field( 'field_id', 'Field Title', array( $this, 'render_field' ), 'my-page', 'sec_id', array( 'label_for' => 'myfield' ) );
  }
}
`;
  const { settingsSections, settingsFields } = extractPhpWpPrimitives(src);
  assert.equal(settingsSections.length, 1);
  const sec = settingsSections[0];
  assert.equal(sec.sectionId, "sec_id");
  assert.equal(sec.title, "Section Title");
  assert.equal(sec.page, "my-page");
  assert.equal(sec.callback, "Settings::render_section");
  assert.equal(sec.owner, "Settings::register");

  assert.equal(settingsFields.length, 1);
  const field = settingsFields[0];
  assert.equal(field.fieldId, "field_id");
  assert.equal(field.page, "my-page");
  assert.equal(field.section, "sec_id");
  assert.equal(field.callback, "Settings::render_field");
  assert.equal(field.labelFor, "myfield");
});

test("REQ-018: add_settings_field() omitted $section defaults to WP's 'default'", () => {
  const src = `<?php
add_settings_field( 'field_id', 'Field Title', 'render_field_cb', 'my-page' );
`;
  const { settingsFields } = extractPhpWpPrimitives(src);
  assert.equal(settingsFields[0].section, "default");
  assert.equal(settingsFields[0].callback, "render_field_cb");
});

test("REQ-018: do_settings_sections() in the same file correlates rendered_at onto matching sections/fields by page", () => {
  const src = `<?php
function register_settings() {
  add_settings_section( 'sec_id', 'Section Title', 'render_section_cb', 'my-page' );
  add_settings_field( 'field_id', 'Field Title', 'render_field_cb', 'my-page', 'sec_id' );
}
function render_page() {
  do_settings_sections( 'my-page' );
}
`;
  const { settingsSections, settingsFields } = extractPhpWpPrimitives(src);
  assert.deepEqual(settingsSections[0].renderedAt, { owner: "render_page", line: 7 });
  assert.deepEqual(settingsFields[0].renderedAt, { owner: "render_page", line: 7 });
});

test("REQ-018: do_settings_sections() for a page with no in-file match leaves rendered_at null (no cross-file fabrication)", () => {
  const src = `<?php
add_settings_section( 'sec_id', 'Section Title', 'render_section_cb', 'other-page' );
function render_page() {
  do_settings_sections( 'my-page' );
}
`;
  const { settingsSections } = extractPhpWpPrimitives(src);
  assert.equal(settingsSections[0].renderedAt, null);
});
