CREATE TABLE pipeline_search_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
  document_key text NOT NULL CHECK (length(document_key) > 0),
  kind text NOT NULL CHECK (kind IN ('page', 'symbol', 'module', 'path', 'table', 'command')),
  title text NOT NULL CHECK (length(title) > 0),
  content text NOT NULL CHECK (length(content) > 0),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_artifact_id, document_key),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX pipeline_search_documents_scope_idx
  ON pipeline_search_documents (workspace_id, project_id, build_job_id, kind, document_key);

CREATE OR REPLACE FUNCTION enforce_pipeline_search_document_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM knowledge_artifacts artifact
    WHERE artifact.id = NEW.source_artifact_id
      AND artifact.workspace_id = NEW.workspace_id
      AND artifact.project_id = NEW.project_id
      AND artifact.snapshot_id = NEW.snapshot_id
      AND artifact.build_job_id = NEW.build_job_id
  ) THEN
    RAISE EXCEPTION 'Pipeline search document does not match its source artifact scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pipeline_search_documents_scope_integrity
  BEFORE INSERT OR UPDATE ON pipeline_search_documents
  FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_search_document_scope();
