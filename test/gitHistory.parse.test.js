import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECORD_SEP, FIELD_SEP, BODY_SEP,
  parseGitLog, parseCommitRecord, extractIssueRefs, extractCoAuthors, personKey,
} from "../src/knowledge/gitHistory.js";

/** Build the exact bytes `git log --pretty=format:… --numstat` would emit. */
function logRecord({
  sha = "a".repeat(40), short = "aaaaaaa", name = "Dev", email = "dev@example.com",
  authored = "2026-01-15T10:00:00+00:00", committed = "2026-01-15T10:00:00+00:00",
  parents = "b".repeat(40), body = "a commit", numstat = [],
}) {
  return (
    RECORD_SEP +
    [sha, short, name, email, authored, committed, parents, body].join(FIELD_SEP) +
    BODY_SEP + "\n\n" + numstat.join("\n") + "\n"
  );
}

// --- record framing --------------------------------------------------------

test("a multi-line body is not confused with the numstat block that follows it", async () => {
  // The whole reason for the GS body terminator: this message contains a line
  // that is indistinguishable from numstat output.
  const body = "Fix the parser\n\n12\t3\tsrc/looks-like-numstat.js\n\nReally.";
  const [commit] = await parseGitLog(logRecord({ body, numstat: ["4\t2\tsrc/real.js"] }));
  assert.equal(commit.subject, "Fix the parser");
  assert.equal(commit.body, body);
  assert.deepEqual(commit.files.map((f) => f.path), ["src/real.js"]);
  assert.equal(commit.insertions, 4);
  assert.equal(commit.deletions, 2);
});

test("commits are recovered whatever the chunk boundaries happen to be", async () => {
  const text =
    logRecord({ sha: "1".repeat(40), short: "1111111", body: "first commit here", numstat: ["1\t0\ta.js"] }) +
    logRecord({ sha: "2".repeat(40), short: "2222222", body: "second commit here", numstat: ["2\t1\tb.js"] }) +
    logRecord({ sha: "3".repeat(40), short: "3333333", body: "third commit here", numstat: ["0\t5\tc.js"] });

  const { streamCommits } = await import("../src/knowledge/gitHistory.js");
  for (const size of [1, 7, 33, 500, text.length + 10]) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const out = [];
    for await (const c of streamCommits(chunks)) out.push(c);
    assert.deepEqual(
      out.map((c) => c.subject),
      ["first commit here", "second commit here", "third commit here"],
      `chunk size ${size}`
    );
    assert.deepEqual(out.map((c) => c.files[0].path), ["a.js", "b.js", "c.js"], `chunk size ${size}`);
  }
});

test("binary files are recorded as touched but contribute no line counts", async () => {
  const [commit] = await parseGitLog(
    logRecord({ body: "add a logo", numstat: ["-\t-\tsrc/logo.png", "3\t1\tsrc/a.js"] })
  );
  const binary = commit.files.find((f) => f.path === "src/logo.png");
  assert.equal(binary.isBinary, true);
  assert.equal(binary.additions, 0);
  assert.equal(commit.insertions, 3);
  assert.equal(commit.filesChanged, 2);
});

test("a path containing a tab survives parsing", async () => {
  const [commit] = await parseGitLog(logRecord({ body: "odd path", numstat: ["1\t0\tsrc/we\tird.js"] }));
  assert.equal(commit.files[0].path, "src/we\tird.js");
});

test("a merge is recognised by its parent count and carries no numstat", async () => {
  const [commit] = await parseGitLog(
    logRecord({ body: "Merge branch 'feature'", parents: `${"b".repeat(40)} ${"c".repeat(40)}` })
  );
  assert.equal(commit.isMerge, true);
  assert.equal(commit.filesChanged, 0);
});

test("a malformed record is dropped rather than throwing", () => {
  assert.equal(parseCommitRecord(""), null);
  assert.equal(parseCommitRecord("no body separator here"), null);
  assert.equal(parseCommitRecord(`too${FIELD_SEP}few${BODY_SEP}`), null);
});

// --- classification --------------------------------------------------------

test("fix and revert are detected even behind a prefixed subject line", async () => {
  const cases = [
    ["Trac Lam - fix: correct login redirect", true, false],
    ["fix(auth): expiry", true, false],
    ["PROJ-12 Fixes the cache stampede", true, false],
    ["feat: add a prefix helper", false, false],   // "prefix" must not match
    ["Add fixture loading", false, false],          // nor "fixture"
    ["Revert \"feat: add caching\"", false, true],
    ["chore: bump deps", false, false],
  ];
  for (const [subject, isFix, isRevert] of cases) {
    const [commit] = await parseGitLog(logRecord({ body: subject }));
    assert.equal(commit.isFix, isFix, `isFix for: ${subject}`);
    assert.equal(commit.isRevert, isRevert, `isRevert for: ${subject}`);
  }
});

test("a revert is detected from the body git itself generates", async () => {
  const [commit] = await parseGitLog(
    logRecord({ body: "Undo the caching change\n\nThis reverts commit deadbeef." })
  );
  assert.equal(commit.isRevert, true);
});

// --- issue references ------------------------------------------------------

test("closing keywords produce FIXES, bare mentions produce REFERENCES", () => {
  const refs = extractIssueRefs("Handle expiry\n\nFixes #1532. Related to #99 and PROJ-7.");
  const byKey = Object.fromEntries(refs.map((r) => [`${r.tracker}:${r.key}`, r.relation]));
  assert.equal(byKey["github:1532"], "FIXES");
  assert.equal(byKey["github:99"], "REFERENCES");
  assert.equal(byKey["jira:PROJ-7"], "REFERENCES");
});

test("a tracker URL is captured so the stub issue can be reached later", () => {
  const refs = extractIssueRefs("See https://github.com/acme/api/issues/44 for context");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].key, "44");
  assert.equal(refs[0].url, "https://github.com/acme/api/issues/44");
});

test("the same issue referenced twice collapses, keeping the stronger relation", () => {
  const refs = extractIssueRefs("Mentions #12. Also fixes #12.");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].relation, "FIXES");
});

test("things shaped like issue references but obviously not are ignored", () => {
  const noise = "Switch to UTF-8, verify SHA-256, follow ISO-8601, colour #1532ab, path a/b#3";
  assert.deepEqual(extractIssueRefs(noise), []);
});

test("a markdown heading is not an issue reference", () => {
  assert.deepEqual(extractIssueRefs("# Changelog\n\n## 1.2.0"), []);
});

// --- identities ------------------------------------------------------------

test("co-authored-by trailers are extracted and de-duplicated", () => {
  const authors = extractCoAuthors(
    "Pair work\n\nCo-authored-by: Ann <ann@example.com>\nco-authored-by: Ann <ANN@example.com>\n" +
    "Co-authored-by: Bo <bo@example.com>\n"
  );
  assert.deepEqual(authors.map((a) => a.email), ["ann@example.com", "bo@example.com"]);
});

test("identity is the address, case-folded, with a name fallback", () => {
  assert.equal(personKey({ name: "Ann", email: "Ann@Example.COM" }), "ann@example.com");
  assert.equal(personKey({ name: "No Address", email: "" }), "name:no address");
});
