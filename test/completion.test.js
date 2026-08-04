import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  MANUAL_COMMANDS, helpLines, generateBash, completeWords, assertSafeForBash,
} from "../src/completion.js";
import { operations } from "../src/operations.js";

test("help output is byte-identical after moving manual commands into a table", () => {
  const expected = fs.readFileSync(new URL("./fixtures/help.txt", import.meta.url), "utf8");
  const actual = execFileSync("node", ["src/cli.js", "help"], { encoding: "utf8" });
  assert.equal(actual, expected);
});

/**
 * Every name/alias a switch case or op could match, built directly from
 * MANUAL_COMMANDS and operations.js -- independent of completeWords(), so a
 * bug inside completeWords() itself (e.g. dropping op.cli.aliases) can't hide
 * behind a test that only ever compares completeWords() against itself.
 */
function knownCommandNames() {
  return new Set([
    ...MANUAL_COMMANDS.map((c) => c.name),
    ...operations.map((op) => op.name),
    ...operations.flatMap((op) => op.cli?.aliases ?? []),
  ]);
}

test("every hand-written switch case appears in MANUAL_COMMANDS or the registry", () => {
  // cli.js's switch and the completion word list are edited separately and
  // drift silently -- a subcommand that exists but never completes.
  const source = fs.readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  const cases = [...source.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]);

  // --version and -v are flag spellings of `version`, never typed as a subcommand.
  const typed = cases.filter((c) => c !== "--version" && c !== "-v");

  const known = knownCommandNames();

  const missing = typed.filter((c) => !known.has(c));
  assert.deepEqual(missing, [], `switch cases with no completion entry: ${missing.join(", ")}`);
});

test("every MANUAL_COMMANDS entry has a switch case implementing it", () => {
  // The other direction: a stale table entry would offer a command that errors.
  // Registry operations are excluded -- they dispatch through findOperation(),
  // not through the switch, so they legitimately have no case label.
  const source = fs.readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  const cases = new Set([...source.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]));

  const orphaned = MANUAL_COMMANDS.map((c) => c.name).filter((n) => !cases.has(n));
  assert.deepEqual(orphaned, [], `table entries with no switch case: ${orphaned.join(", ")}`);
});

// Resolved once, by absolute path: tests override PATH (e.g. to hide jq from
// the generated script's own `command -v` check), and a bare "bash" command
// name would otherwise have to be found via that same overridden PATH,
// failing to spawn at all. An absolute path sidesteps PATH lookup for the
// spawn itself while still letting the script see the caller's PATH override.
const BASH = spawnSync("which", ["bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";

/** Source the generated script in a clean bash and return what Tab would offer. */
function complete(words, cword, env = {}) {
  const script = generateBash();
  const driver = [
    script,
    `COMP_WORDS=(${words.map((w) => `'${w}'`).join(" ")})`,
    `COMP_CWORD=${cword}`,
    "_waycontext",
    'printf "%s\\n" "${COMPREPLY[@]:-}"',
  ].join("\n");
  const r = spawnSync(BASH, ["--norc", "--noprofile", "-c", driver], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    words: r.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    stderr: r.stderr,
    status: r.status,
  };
}

test("the generated script is valid bash", () => {
  const r = spawnSync("bash", ["-n"], { input: generateBash(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("the generated script names every command, alias and manual entry", () => {
  // A substring match against the expected set would pass even if a word went
  // missing entirely, as long as it happens to be a substring of a word that
  // is still present (e.g. dropping the alias "search" would go unnoticed
  // since "search_code" still contains it). Parse out exactly what
  // _WC_COMMANDS holds and compare against the independently-built set
  // instead. Comparing against completeWords() itself would be circular --
  // both _WC_COMMANDS and that call are derived from completeWords(), so a
  // bug inside completeWords() (e.g. it stopped including op.cli.aliases)
  // would never surface.
  const script = generateBash();
  const listed = script.match(/_WC_COMMANDS='([^']*)'/)[1].split(" ");
  assert.deepEqual(listed.sort(), [...knownCommandNames()].sort());
});

test("assertSafeForBash passes conservative names through unchanged", () => {
  const words = ["search_code", "knowledge-export", "init-db"];
  assert.deepEqual(assertSafeForBash(words), words);
});

test("assertSafeForBash throws, naming the offending word, on anything else", () => {
  assert.throws(
    () => assertSafeForBash(["fine", "it's a trap"]),
    /it's a trap/,
  );
  assert.throws(() => assertSafeForBash(["*"]), /\*/);
  assert.throws(() => assertSafeForBash(["has space"]), /has space/);
});

test("generateBash never emits a word that fails the bash-safety guard", () => {
  // Documents *why* generateBash() is safe today rather than just asserting
  // it once: every word completeWords() can currently produce satisfies the
  // same guard Task 3's flags and sub-verbs must also flow through.
  assert.doesNotThrow(() => assertSafeForBash(completeWords()));
});

test("a bare prefix completes to the matching subcommand", () => {
  const { words, stderr, status } = complete(["waycontext", "us"], 1);
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.deepEqual(words, ["usage"]);
});

test("an ambiguous prefix offers every match", () => {
  const { words } = complete(["waycontext", "search"], 1);
  assert.deepEqual(words.sort(), ["search", "search_code", "search_knowledge"]);
});

test("both installed bin names are registered", () => {
  assert.match(generateBash(), /complete -F _waycontext waycontext codecontext/);
});

/** A temp XDG_CACHE_HOME holding a projects.json fixture. */
function cacheWith(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-completion-"));
  fs.mkdirSync(path.join(dir, "waycontext"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "waycontext", "projects.json"),
    JSON.stringify({ version: 1, mcpName: "waycontext", mode: "advise",
      projects: names.map((n) => ({ name: n, root_path: `/tmp/${n}` })) })
  );
  return dir;
}

test("a project slot completes from the cache", () => {
  const XDG_CACHE_HOME = cacheWith(["alpha", "beta", "waycontext"]);
  const { words, stderr } = complete(["waycontext", "search_code", ""], 2, { XDG_CACHE_HOME });
  assert.equal(stderr, "");
  assert.deepEqual(words.sort(), ["alpha", "beta", "waycontext"]);
});

test("a project slot filters on the typed prefix", () => {
  const XDG_CACHE_HOME = cacheWith(["alpha", "beta"]);
  const { words } = complete(["waycontext", "get_symbol", "al"], 2, { XDG_CACHE_HOME });
  assert.deepEqual(words, ["alpha"]);
});

test("project completion works without jq, via the grep fallback", () => {
  const XDG_CACHE_HOME = cacheWith(["alpha", "beta"]);
  // A PATH with no jq on it, but still a usable coreutils.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "wc-nojq-"));
  for (const bin of ["grep", "sed", "cat", "compgen"]) {
    const found = spawnSync("which", [bin], { encoding: "utf8" }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(bare, bin));
  }
  const { words, stderr } = complete(["waycontext", "search_code", ""], 2,
    { XDG_CACHE_HOME, PATH: bare });
  assert.equal(stderr, "");
  assert.deepEqual(words.sort(), ["alpha", "beta"]);
});

test("sub-verbs complete in slot 1 of a command that declares them", () => {
  const { words } = complete(["waycontext", "hook", ""], 2);
  assert.deepEqual(words.sort(), ["install", "refresh", "uninstall"]);
});

test("flags complete wherever a dash is typed", () => {
  const { words } = complete(["waycontext", "migrate", "--"], 2);
  assert.deepEqual(words, ["--status"]);
});

test("a path slot hands back to filename completion without speaking", () => {
  const { words, stderr, status } = complete(["waycontext", "index_project", "proj", ""], 3);
  assert.equal(status, 0);
  assert.equal(stderr, "");   // compopt outside a real completion must stay silent
  assert.deepEqual(words, []);
});

test("completion is silent with no cache at all", () => {
  const XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wc-empty-"));
  const { words, stderr, status } = complete(["waycontext", "search_code", ""], 2, { XDG_CACHE_HOME });
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.deepEqual(words, []);
});

test("completion is silent on malformed cache JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-bad-"));
  fs.mkdirSync(path.join(dir, "waycontext"), { recursive: true });
  fs.writeFileSync(path.join(dir, "waycontext", "projects.json"), "{ not json");
  const { stderr, status } = complete(["waycontext", "search_code", ""], 2, { XDG_CACHE_HOME: dir });
  assert.equal(status, 0);
  assert.equal(stderr, "");
});

test("an unknown command offers nothing and says nothing", () => {
  const { words, stderr, status } = complete(["waycontext", "nonsense", ""], 2);
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.deepEqual(words, []);
});

import { completionPath, installCompletion, removeCompletion } from "../src/completion.js";

function withDataHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-xdg-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
}

test("completionPath honours XDG_DATA_HOME", () => {
  withDataHome((dir) => {
    assert.equal(completionPath(),
      path.join(dir, "bash-completion", "completions", "waycontext"));
  });
});

test("installCompletion writes the script and is idempotent", () => {
  withDataHome(() => {
    const first = installCompletion();
    assert.equal(first.created, true);
    assert.match(fs.readFileSync(first.path, "utf8"), /complete -F _waycontext/);

    const second = installCompletion();
    assert.equal(second.created, false, "re-running should overwrite, not report a new file");
    assert.equal(second.path, first.path);
  });
});

test("removeCompletion deletes the file and reports a second call as a no-op", () => {
  withDataHome(() => {
    installCompletion();
    assert.equal(removeCompletion().removed, true);
    assert.equal(removeCompletion().removed, false);
    assert.equal(fs.existsSync(completionPath()), false);
  });
});

test("completion bash prints the script to stdout without writing anything", () => {
  withDataHome(() => {
    const out = execFileSync("node", ["src/cli.js", "completion", "bash"], { encoding: "utf8" });
    assert.match(out, /complete -F _waycontext waycontext codecontext/);
    assert.equal(fs.existsSync(completionPath()), false);
  });
});

test("completion with no sub-verb exits non-zero with usage", () => {
  const r = spawnSync("node", ["src/cli.js", "completion"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /completion bash\|install\|uninstall/);
});

test("waycontext uninstall removes the completion file end-to-end", () => {
  // Only removeCompletion() itself was tested elsewhere -- this covers the
  // integration point: does the top-level `uninstall` subcommand actually
  // reach it. `case "uninstall"` never calls initDb(), and pool.end() on an
  // unconnected pool is a safe no-op, so this needs no database at all --
  // only filesystem env vars pointed at temp directories.
  const cliPath = path.resolve("src/cli.js");
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "wc-uninstall-data-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wc-uninstall-home-"));
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "wc-uninstall-cache-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wc-uninstall-cwd-"));

  let target;
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    target = installCompletion().path;
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
  assert.equal(fs.existsSync(target), true, "precondition: completion file exists before uninstall");

  const r = spawnSync("node", [cliPath, "uninstall"], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome, XDG_CACHE_HOME: cacheHome },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(target), false, "completion file should be gone after uninstall");
});
