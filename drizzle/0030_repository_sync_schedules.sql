CREATE TABLE repository_sync_schedules (
  repository_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (repository_id, workspace_id)
    REFERENCES repositories(id, workspace_id) ON DELETE CASCADE,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX repository_sync_schedules_due_idx
  ON repository_sync_schedules (next_attempt_at, repository_id);
