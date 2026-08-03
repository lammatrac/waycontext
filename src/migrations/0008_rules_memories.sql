-- ---------------------------------------------------------------------------
-- Knowledge plane: rules + memories (Phase 3)
-- ---------------------------------------------------------------------------
--
-- Both are 1:1 satellites of entities, as in Phases 1 and 2. The split between
-- them is prescriptive vs observational: a rule is injected into an agent's
-- context and therefore has to be confirmed by a human first; a memory is
-- retrieved on demand and can be written by the agent itself.
CREATE TABLE IF NOT EXISTS rules (
  entity_id   BIGINT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  org_id      INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  statement   TEXT NOT NULL,
  scope       TEXT,                              -- picomatch glob; NULL = project-wide
  severity    TEXT NOT NULL DEFAULT 'medium',    -- low | medium | high | critical
  origin      TEXT NOT NULL,                     -- adr | doc | fix_commit | manual | imported
  origin_ref  TEXT,                              -- doc path, commit sha, yaml file
  confidence  REAL NOT NULL DEFAULT 0.5,
  -- Only 'active' is ever injected into context. Extraction writes 'candidate'
  -- and nothing else; a human moves rows out of it. 'rejected' is permanent so
  -- re-extraction cannot resurrect a rule someone already threw out.
  state       TEXT NOT NULL DEFAULT 'candidate', -- candidate | active | rejected
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rules_state_idx ON rules (project_id, state);

CREATE TABLE IF NOT EXISTS memories (
  entity_id  BIGINT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  org_id     INT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'gotcha',     -- fix | gotcha | convention | postmortem
  content    TEXT NOT NULL,
  scope      TEXT,
  source     TEXT NOT NULL DEFAULT 'agent',      -- agent | human | extracted | imported
  author     TEXT,
  -- A correction supersedes rather than edits: the old memory stays readable
  -- (it is what someone believed, and why) but stops being recalled.
  supersedes BIGINT REFERENCES entities(id) ON DELETE SET NULL,
  pinned     BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_kind_idx       ON memories (project_id, kind);
CREATE INDEX IF NOT EXISTS memories_pinned_idx     ON memories (project_id) WHERE pinned;
CREATE INDEX IF NOT EXISTS memories_supersedes_idx ON memories (supersedes);
