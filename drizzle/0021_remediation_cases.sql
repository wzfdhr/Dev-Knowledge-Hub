ALTER TABLE build_jobs
  ADD COLUMN remediation_context jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE build_jobs
  DROP CONSTRAINT build_jobs_purpose_check,
  DROP CONSTRAINT build_jobs_feedback_identity_check,
  ADD CONSTRAINT build_jobs_purpose_check CHECK (purpose IN ('standard', 'feedback', 'remediation')),
  ADD CONSTRAINT build_jobs_build_identity_check CHECK (
    (purpose = 'standard'
      AND cardinality(feedback_ids) = 0
      AND feedback_context = '[]'::jsonb
      AND remediation_context = '[]'::jsonb)
    OR (purpose = 'feedback'
      AND cardinality(feedback_ids) > 0
      AND jsonb_array_length(feedback_context) > 0
      AND remediation_context = '[]'::jsonb)
    OR (purpose = 'remediation'
      AND cardinality(feedback_ids) = 0
      AND feedback_context = '[]'::jsonb
      AND jsonb_array_length(remediation_context) > 0)
  );

CREATE TABLE remediation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  source_build_id uuid NOT NULL,
  issue jsonb NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'rebuilding', 'resolved', 'dismissed')),
  rebuild_build_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id, workspace_id) REFERENCES repositories(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (source_build_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (rebuild_build_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(issue) = 'object')
);
CREATE INDEX remediation_cases_project_state_idx
  ON remediation_cases (workspace_id, project_id, state, created_at DESC);

CREATE TABLE remediation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigserial NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  remediation_id uuid NOT NULL,
  from_state text NOT NULL CHECK (from_state IN ('open', 'accepted', 'rebuilding', 'resolved', 'dismissed')),
  to_state text NOT NULL CHECK (to_state IN ('open', 'accepted', 'rebuilding', 'resolved', 'dismissed')),
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (remediation_id, workspace_id) REFERENCES remediation_cases(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX remediation_events_case_idx
  ON remediation_events (workspace_id, remediation_id, sequence);
