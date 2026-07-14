CREATE TABLE build_stage_events (
  sequence bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  stage_run_id uuid NOT NULL REFERENCES build_stage_runs(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('convert', 'extract', 'tables', 'graph', 'synthesize', 'index', 'lint', 'viz', 'validate', 'package')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'reused', 'skipped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stage_run_id, status),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX build_stage_events_replay_idx
  ON build_stage_events (workspace_id, project_id, build_job_id, sequence);
