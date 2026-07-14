CREATE TABLE build_stage_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('convert', 'extract', 'tables', 'graph', 'synthesize', 'index', 'lint', 'viz', 'validate', 'package')),
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'reused', 'skipped')),
  input_digest char(64) NOT NULL CHECK (input_digest ~ '^[0-9A-Fa-f]{64}$'),
  output_manifest_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (build_job_id, stage, attempt),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX build_stage_runs_claim_idx ON build_stage_runs (workspace_id, project_id, status, created_at, id);
CREATE INDEX build_stage_runs_build_idx ON build_stage_runs (workspace_id, build_job_id, stage, attempt);

CREATE TABLE knowledge_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('convert', 'extract', 'tables', 'graph', 'synthesize', 'index', 'lint', 'viz', 'validate', 'package')),
  kind text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  input_digest char(64) NOT NULL CHECK (input_digest ~ '^[0-9A-Fa-f]{64}$'),
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9A-Fa-f]{64}$'),
  storage_key text NOT NULL,
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  producer text NOT NULL CHECK (producer IN ('deterministic', 'llm')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, snapshot_id, stage, kind, input_digest),
  UNIQUE (storage_key),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX knowledge_artifacts_build_idx ON knowledge_artifacts (workspace_id, project_id, build_job_id, stage, created_at);
CREATE INDEX knowledge_artifacts_cache_idx ON knowledge_artifacts (workspace_id, project_id, snapshot_id, stage, kind, input_digest);

CREATE OR REPLACE FUNCTION prevent_published_artifact_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM releases
    WHERE build_job_id = OLD.build_job_id AND workspace_id = OLD.workspace_id AND published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot delete artifacts from a published build';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER knowledge_artifacts_prevent_published_delete
  BEFORE DELETE ON knowledge_artifacts
  FOR EACH ROW EXECUTE FUNCTION prevent_published_artifact_delete();
