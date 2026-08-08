/**
 * Pure mutation of a graph object by a batch of patch operations. No fs access --
 * disk I/O lives in store.js, same split as graph.js (query) / indexer.js (writes).
 *
 * Works on a deep clone so a throw partway through a batch never touches the
 * caller's graph: store.js only persists the return value, so "all ops succeed
 * or none are written" falls out of that for free.
 */
import { patchOpSchema, validateGraph } from "./schema.js";

function requireNode(nodes, id, context) {
  if (!nodes[id]) throw new Error(`${context}: node "${id}" not found`);
  return nodes[id];
}

function nextId(nodes, prefix) {
  let max = 0;
  for (const id of Object.keys(nodes)) {
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

function nextAltId(alternatives) {
  let max = 0;
  for (const alt of alternatives) {
    const m = alt.id.match(/^a(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `a${max + 1}`;
}

function collectDescendants(nodes, id, acc = new Set()) {
  for (const childId of nodes[id]?.children ?? []) {
    if (!acc.has(childId)) {
      acc.add(childId);
      collectDescendants(nodes, childId, acc);
    }
  }
  return acc;
}

function findParentId(nodes, childId) {
  for (const [id, n] of Object.entries(nodes)) {
    if (n.children.includes(childId)) return id;
  }
  return null;
}

function detach(nodes, childId) {
  const parentId = findParentId(nodes, childId);
  if (parentId) {
    nodes[parentId].children = nodes[parentId].children.filter((id) => id !== childId);
  }
}

const handlers = {
  add_node(nodes, op) {
    const parent = requireNode(nodes, op.parent, "add_node");
    const id = op.id ?? nextId(nodes, "n");
    if (nodes[id]) throw new Error(`add_node: node "${id}" already exists`);
    nodes[id] = {
      id, type: op.type, title: op.title, status: "open",
      review: "unknown", confidence: null, evidence: [],
      alternatives: [], selected: null, affected_files: [], risk: null, notes: null, children: [],
    };
    parent.children.push(id);
  },
  add_alternative(nodes, op) {
    const node = requireNode(nodes, op.node, "add_alternative");
    const id = op.id ?? nextAltId(node.alternatives);
    if (node.alternatives.some((a) => a.id === id)) {
      throw new Error(`add_alternative: alternative "${id}" already exists on node "${op.node}"`);
    }
    node.alternatives.push({ id, label: op.label, pros: op.pros ?? [], cons: op.cons ?? [] });
  },
  select_answer(nodes, op) {
    const node = requireNode(nodes, op.node, "select_answer");
    if (!node.alternatives.some((a) => a.id === op.alternative)) {
      throw new Error(`select_answer: node "${op.node}" has no alternative "${op.alternative}"`);
    }
    node.selected = op.alternative;
  },
  set_status(nodes, op) {
    requireNode(nodes, op.node, "set_status").status = op.status;
  },
  set_review(nodes, op) {
    requireNode(nodes, op.node, "set_review").review = op.review;
  },
  set_confidence(nodes, op) {
    requireNode(nodes, op.node, "set_confidence").confidence = op.confidence;
  },
  set_evidence(nodes, op) {
    requireNode(nodes, op.node, "set_evidence").evidence = op.evidence;
  },
  set_risk(nodes, op) {
    requireNode(nodes, op.node, "set_risk").risk = op.risk;
  },
  set_affected_files(nodes, op) {
    requireNode(nodes, op.node, "set_affected_files").affected_files = op.files;
  },
  set_notes(nodes, op) {
    requireNode(nodes, op.node, "set_notes").notes = op.notes;
  },
  set_title(nodes, op) {
    requireNode(nodes, op.node, "set_title").title = op.title;
  },
  reparent(nodes, op) {
    requireNode(nodes, op.node, "reparent");
    requireNode(nodes, op.parent, "reparent");
    if (op.parent === op.node || collectDescendants(nodes, op.node).has(op.parent)) {
      throw new Error(`reparent: "${op.parent}" is "${op.node}"'s own descendant`);
    }
    detach(nodes, op.node);
    nodes[op.parent].children.push(op.node);
  },
  remove_node(nodes, op) {
    requireNode(nodes, op.node, "remove_node");
    detach(nodes, op.node);
    for (const id of [op.node, ...collectDescendants(nodes, op.node)]) delete nodes[id];
  },
};

/** Apply a batch of patch ops to `graph`, returning a new validated graph. Atomic. */
export function applyPatch(graph, ops, { now = new Date().toISOString() } = {}) {
  const next = structuredClone(graph);
  for (const raw of ops) {
    const op = patchOpSchema.parse(raw);
    if (op.op === "remove_node" && op.node === next.root_id) {
      throw new Error("remove_node: cannot remove the root node");
    }
    handlers[op.op](next.nodes, op);
  }
  next.updated_at = now;
  return validateGraph(next);
}
