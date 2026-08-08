/**
 * The shape of graph.json (distinct from the flat operations.js input schemas)
 * plus the patch-operation vocabulary update_reasoning_graph accepts.
 */
import { z } from "zod";

const alternative = z.object({
  id: z.string(),
  label: z.string(),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
});

const reviewStatus = z.enum(["verified", "assumed", "inferred", "conflict", "unknown"]);

const node = z.object({
  id: z.string(),
  type: z.enum(["feature", "question", "decision"]),
  title: z.string(),
  status: z.enum(["open", "resolved"]).default("open"),
  review: reviewStatus.default("unknown"),
  confidence: z.number().int().min(0).max(100).nullable().default(null),
  evidence: z.array(z.string()).default([]),
  alternatives: z.array(alternative).default([]),
  selected: z.string().nullable().default(null),
  affected_files: z.array(z.string()).default([]),
  risk: z.enum(["low", "medium", "high"]).nullable().default(null),
  notes: z.string().nullable().default(null),
  children: z.array(z.string()).default([]),
});

const graph = z.object({
  schema_version: z.number().int().default(1),
  feature: z.string(),
  slug: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  root_id: z.string(),
  nodes: z.record(z.string(), node),
});

/** Parse+normalize a graph object, filling defaults. Throws on an invalid shape. */
export function validateGraph(data) {
  return graph.parse(data);
}

/** A fresh single-root graph for a new feature. */
export function newGraph({ feature, slug, now = new Date().toISOString() }) {
  return validateGraph({
    schema_version: 1,
    feature,
    slug,
    created_at: now,
    updated_at: now,
    root_id: "n1",
    nodes: {
      n1: { id: "n1", type: "feature", title: feature, status: "open", children: [] },
    },
  });
}

const nodeType = z.enum(["question", "decision"]);
const risk = z.enum(["low", "medium", "high"]).nullable();
const confidence = z.number().int().min(0).max(100).nullable();

export const patchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), parent: z.string(), type: nodeType, title: z.string(), id: z.string().optional() }),
  z.object({ op: z.literal("add_alternative"), node: z.string(), label: z.string(), pros: z.array(z.string()).default([]), cons: z.array(z.string()).default([]), id: z.string().optional() }),
  z.object({ op: z.literal("select_answer"), node: z.string(), alternative: z.string() }),
  z.object({ op: z.literal("set_status"), node: z.string(), status: z.enum(["open", "resolved"]) }),
  z.object({ op: z.literal("set_review"), node: z.string(), review: reviewStatus }),
  z.object({ op: z.literal("set_confidence"), node: z.string(), confidence }),
  z.object({ op: z.literal("set_evidence"), node: z.string(), evidence: z.array(z.string()) }),
  z.object({ op: z.literal("set_risk"), node: z.string(), risk }),
  z.object({ op: z.literal("set_affected_files"), node: z.string(), files: z.array(z.string()) }),
  z.object({ op: z.literal("set_notes"), node: z.string(), notes: z.string().nullable() }),
  z.object({ op: z.literal("set_title"), node: z.string(), title: z.string() }),
  z.object({ op: z.literal("reparent"), node: z.string(), parent: z.string() }),
  z.object({ op: z.literal("remove_node"), node: z.string() }),
]);
