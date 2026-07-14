CREATE TABLE import_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id uuid REFERENCES repositories(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  source_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  collected_file_count integer NOT NULL DEFAULT 0,
  collected_text_bytes bigint NOT NULL DEFAULT 0,
  ignored jsonb NOT NULL DEFAULT '{"total": 0, "reasons": {}}'::jsonb,
  snapshot_id uuid REFERENCES source_snapshots(id) ON DELETE SET NULL,
  failure_code text
);

CREATE INDEX import_reports_project_started_idx ON import_reports (workspace_id, project_id, started_at DESC, id DESC);
CREATE INDEX import_reports_retention_idx ON import_reports (status, finished_at) WHERE status IN ('failed', 'cancelled');
