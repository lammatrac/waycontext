-- ---------------------------------------------------------------------------
-- Browser Session Manager: profiles, sessions, artifacts, audit
-- ---------------------------------------------------------------------------
--
-- Operational objects with their own tables -- they are deliberately NOT
-- entities. Every table hangs off projects(id) ON DELETE CASCADE, directly or
-- through browser_sessions. Nothing here can hold a secret or a cookie:
-- browser_profiles.definition carries env var NAMES only, and artifacts are an
-- opaque reference (storage_ref), never content.

CREATE TABLE IF NOT EXISTS browser_profiles (
  id              SERIAL PRIMARY KEY,
  project_id      INT  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id      TEXT NOT NULL,                  -- user-facing id, unique per project
  environment     TEXT NOT NULL,                  -- local | staging (production is rejected at import)
  base_url        TEXT NOT NULL,
  allowed_origins JSONB NOT NULL,                 -- normalized origins, exact-match allowlist
  auth_mode       TEXT NOT NULL,                  -- fresh_login | saved_state
  definition      JSONB NOT NULL,                 -- the validated profile; env var names only
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, profile_id)
);

-- profile_id is the profile's text id, not an FK: removing a profile closes its
-- live sessions first (see browser/profileStore.js) but leaves the closed rows
-- as history. Status values are owned by the lifecycle phase, so no CHECK here.
CREATE TABLE IF NOT EXISTS browser_sessions (
  id               TEXT PRIMARY KEY,              -- opaque random id
  project_id       INT  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id       TEXT NOT NULL,
  status           TEXT NOT NULL,
  reason           TEXT,
  auth_mode        TEXT NOT NULL,
  identity         JSONB,
  owner_runtime    JSONB,
  purpose          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS browser_sessions_project_idx ON browser_sessions (project_id, profile_id, status);

CREATE TABLE IF NOT EXISTS browser_session_artifacts (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('storage_state', 'screenshot')),
  storage_ref   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS browser_session_artifacts_session_idx ON browser_session_artifacts (session_id);

-- session_id is plain text with no FK: profile-level events have no session,
-- and an FK with SET NULL would be an UPDATE on an append-only table.
CREATE TABLE IF NOT EXISTS browser_audit_events (
  id             BIGSERIAL PRIMARY KEY,
  session_id     TEXT,
  project_id     INT  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  actor          TEXT NOT NULL CHECK (actor IN ('mcp', 'cli', 'http')),
  result         TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS browser_audit_events_project_idx ON browser_audit_events (project_id, created_at);
CREATE INDEX IF NOT EXISTS browser_audit_events_session_idx ON browser_audit_events (session_id) WHERE session_id IS NOT NULL;

-- Append-only (REQ-016): no UPDATE. Rows leave only with their project (cascade).
CREATE OR REPLACE FUNCTION browser_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'browser_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS browser_audit_events_no_update ON browser_audit_events;
CREATE TRIGGER browser_audit_events_no_update
  BEFORE UPDATE ON browser_audit_events
  FOR EACH ROW EXECUTE FUNCTION browser_audit_events_append_only();
