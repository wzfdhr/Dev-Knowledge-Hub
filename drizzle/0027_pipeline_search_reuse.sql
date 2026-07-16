ALTER TABLE pipeline_search_documents
  DROP CONSTRAINT pipeline_search_documents_source_artifact_id_document_key_key;

ALTER TABLE pipeline_search_documents
  ADD CONSTRAINT pipeline_search_documents_build_artifact_key
  UNIQUE (build_job_id, source_artifact_id, document_key);

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
  ) THEN
    RAISE EXCEPTION 'Pipeline search document does not match its source artifact scope';
  END IF;
  RETURN NEW;
END;
$$;
