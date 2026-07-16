ALTER TABLE releases
  ADD COLUMN kernel_mode text NOT NULL DEFAULT 'legacy'
    CHECK (kernel_mode IN ('legacy', 'pipeline')),
  ADD COLUMN package_artifact_id uuid REFERENCES knowledge_artifacts(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_pipeline_release_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kernel_mode = 'legacy' THEN
    IF NEW.package_artifact_id IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy release cannot reference a package artifact';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.package_artifact_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM knowledge_artifacts artifact
    WHERE artifact.id = NEW.package_artifact_id
      AND artifact.workspace_id = NEW.workspace_id
      AND artifact.build_job_id = NEW.build_job_id
      AND artifact.stage = 'package'
      AND artifact.kind = 'pipeline-package'
  ) THEN
    RAISE EXCEPTION 'Pipeline release must reference a matching package artifact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER releases_pipeline_provenance_integrity
  BEFORE INSERT OR UPDATE OF kernel_mode, package_artifact_id, workspace_id, build_job_id ON releases
  FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_release_provenance();
