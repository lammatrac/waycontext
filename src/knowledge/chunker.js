import crypto from "node:crypto";

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/**
 * Split Markdown into sections, one per heading, each carrying the breadcrumb
 * path of the headings enclosing it.
 *
 * Fence-aware on purpose: a `#` line inside a fenced block is code, not a
 * heading, and treating it as one shreds every document that quotes Markdown or
 * shell comments -- which, in a repo's own docs, is most of them.
 */
export function splitSections(body) {
  const sections = [];
  const stack = []; // { level, heading } -- the current heading ancestry
  let current = { level: 0, heading: null, headingPath: "", lines: [] };
  let fence = null;

  const flush = () => {
    if (current.heading || current.lines.some((l) => l.trim())) sections.push(current);
  };

  for (const line of body.split("\n")) {
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      current.lines.push(line);
      continue;
    }
    const h = fence ? null : HEADING.exec(line);
    if (!h) {
      current.lines.push(line);
      continue;
    }
    flush();
    const level = h[1].length;
    const heading = h[2].trim();
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, heading });
    current = { level, heading, headingPath: stack.map((s) => s.heading).join(" > "), lines: [] };
  }
  flush();

  return sections.map(({ level, heading, headingPath, lines }) => ({
    level,
    heading,
    headingPath,
    content: (heading ? [`${"#".repeat(level)} ${heading}`, ...lines] : lines).join("\n").trim(),
  }));
}

/**
 * Break one over-long section into fence-safe pieces at blank lines, then hard
 * cap whatever is still too long.
 *
 * The cap matters more than it looks: src/embeddings.js slices input to 8000
 * characters, so storing a longer chunk would mean the text in the database and
 * the text the vector was computed from are different documents.
 */
function splitOversized(content, target, hardCap) {
  const pieces = [];
  let buf = [];
  let size = 0;
  let fence = null;

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) pieces.push(text);
    buf = [];
    size = 0;
  };

  for (const line of content.split("\n")) {
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
    }
    if (!fence && !line.trim() && size >= target) {
      flush();
      continue;
    }
    buf.push(line);
    size += line.length + 1;
  }
  flush();

  return pieces.flatMap((piece) => {
    if (piece.length <= hardCap) return [piece];
    const parts = [];
    for (let i = 0; i < piece.length; i += hardCap) parts.push(piece.slice(i, i + hardCap));
    return parts;
  });
}

function isHeadingOnly(content) {
  const lines = content.split("\n").filter((l) => l.trim());
  return lines.length === 1 && HEADING.test(lines[0]);
}

/**
 * Chunk a Markdown document for embedding.
 *
 * Section boundaries beat size: a chunk starting mid-argument retrieves badly
 * however well it fits the budget. Small subsections merge into the chunk
 * before them, but a level-1 or level-2 heading always starts a new one, so
 * "## Security" never gets glued to the tail of "## Installation".
 *
 * @param {string} content
 * @param {{target?: number, hardCap?: number}} [opts]
 * @returns {Array<{ord:number, headingPath:string, content:string, contentHash:string, tokenEstimate:number}>}
 */
export function chunkMarkdown(content, { target = 4800, hardCap = 8000 } = {}) {
  const pieces = [];

  for (const section of splitSections(content)) {
    if (!section.content) continue;
    const parts =
      section.content.length <= target
        ? [section.content]
        : splitOversized(section.content, target, hardCap);
    for (const [i, text] of parts.entries()) {
      pieces.push({
        headingPath: section.headingPath,
        content: text.slice(0, hardCap),
        // A major heading opens a chunk; continuation parts of a split section
        // must never be re-merged into what preceded them.
        major: section.level > 0 && section.level <= 2 && i === 0,
        splitPart: i > 0,
      });
    }
  }

  const merged = [];
  // A heading with no body of its own ("# Use RRF" above "## Context") is not a
  // chunk -- alone it retrieves as a bare title with nothing to say. Carry it
  // forward onto the next real chunk, which is where its context belongs.
  let carry = [];

  for (const piece of pieces) {
    if (!piece.splitPart && isHeadingOnly(piece.content)) {
      carry.push(piece);
      continue;
    }

    let content = piece.content;
    if (carry.length) {
      const prefix = carry.map((c) => c.content).join("\n\n");
      if (prefix.length + content.length + 2 <= hardCap) {
        content = `${prefix}\n\n${content}`;
      } else {
        merged.push(...carry.map((c) => ({ headingPath: c.headingPath, content: c.content })));
      }
      carry = [];
    }

    const prev = merged[merged.length - 1];
    const fits = prev && prev.content.length + content.length + 2 <= target;
    if (fits && !piece.major && !piece.splitPart) {
      prev.content = `${prev.content}\n\n${content}`;
      continue;
    }
    merged.push({ headingPath: piece.headingPath, content });
  }
  // Trailing headings with nothing after them still have to be stored: dropping
  // content is never the chunker's call.
  merged.push(...carry.map((c) => ({ headingPath: c.headingPath, content: c.content })));

  return merged.map((m, ord) => ({
    ord,
    headingPath: m.headingPath,
    content: m.content,
    // Hash the breadcrumb too: renaming a heading changes what the chunk means
    // and therefore has to invalidate its embedding.
    contentHash: sha256(`${m.headingPath}\n${m.content}`),
    tokenEstimate: Math.ceil(m.content.length / 4),
  }));
}
