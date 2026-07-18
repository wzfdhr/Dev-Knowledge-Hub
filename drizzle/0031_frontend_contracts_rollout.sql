CREATE TABLE project_frontend_rollouts (
  project_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'shadow', 'active')),
  reason text NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX project_frontend_rollouts_workspace_mode_idx
  ON project_frontend_rollouts (workspace_id, mode, project_id);

ALTER TABLE releases
  ADD COLUMN release_artifact_family text NOT NULL DEFAULT 'knowledge-v1'
    CHECK (release_artifact_family IN ('knowledge-v1', 'frontend-v2')),
  ADD COLUMN package_stage_run_id uuid REFERENCES build_stage_runs(id) ON DELETE RESTRICT,
  ADD COLUMN frontend_ir_schema_version integer,
  ADD COLUMN frontend_graph_schema_version integer,
  ADD COLUMN analyzer_manifest_digest char(64);

ALTER TABLE releases
  ADD CONSTRAINT releases_frontend_provenance_shape_check CHECK (
    (
      release_artifact_family = 'knowledge-v1'
      AND package_stage_run_id IS NULL
      AND frontend_ir_schema_version IS NULL
      AND frontend_graph_schema_version IS NULL
      AND analyzer_manifest_digest IS NULL
    ) OR (
      release_artifact_family = 'frontend-v2'
      AND package_stage_run_id IS NOT NULL
      AND package_artifact_id IS NOT NULL
      AND frontend_ir_schema_version = 2
      AND frontend_graph_schema_version = 2
      AND analyzer_manifest_digest ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE knowledge_graph_nodes DROP CONSTRAINT knowledge_graph_nodes_kind_check;
ALTER TABLE knowledge_graph_nodes ADD CONSTRAINT knowledge_graph_nodes_kind_check CHECK (
  kind IN ('module', 'symbol', 'document', 'table', 'column', 'command',
    'workspace_package', 'application_entry', 'route', 'layout', 'page', 'component',
    'hook_or_composable', 'state_store', 'state_field', 'api_operation', 'data_schema',
    'style_token', 'style_scope', 'visualization', 'test_case', 'test_fixture', 'tooling_config')
);

ALTER TABLE knowledge_graph_edges DROP CONSTRAINT knowledge_graph_edges_kind_check;
ALTER TABLE knowledge_graph_edges ADD CONSTRAINT knowledge_graph_edges_kind_check CHECK (
  kind IN ('imports', 'exports', 'calls', 'contains', 'documents', 'reads', 'writes', 'depends_on',
    'renders', 'routes_to', 'lazy_loads', 'provides', 'injects', 'reads_state', 'writes_state',
    'requests', 'subscribes', 'styles', 'visualizes', 'tests', 'configures')
);

CREATE OR REPLACE FUNCTION enforce_pipeline_release_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.release_artifact_family = 'knowledge-v1' THEN
    IF NEW.package_stage_run_id IS NOT NULL
      OR NEW.frontend_ir_schema_version IS NOT NULL
      OR NEW.frontend_graph_schema_version IS NOT NULL
      OR NEW.analyzer_manifest_digest IS NOT NULL THEN
      RAISE EXCEPTION 'Knowledge v1 release cannot contain frontend v2 provenance';
    END IF;
    IF NEW.kernel_mode = 'legacy' THEN
      IF NEW.package_artifact_id IS NOT NULL THEN
        RAISE EXCEPTION 'Legacy release cannot reference a package artifact';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.package_artifact_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM knowledge_artifacts artifact
      WHERE artifact.id = NEW.package_artifact_id
        AND artifact.workspace_id = NEW.workspace_id
        AND artifact.build_job_id = NEW.build_job_id
        AND artifact.stage = 'package'
        AND artifact.kind = 'pipeline-package'
        AND artifact.schema_version = 1
    ) THEN
      RAISE EXCEPTION 'Pipeline release must reference a matching package artifact';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kernel_mode <> 'pipeline' OR NOT EXISTS (
    SELECT 1
    FROM repositories repository
    JOIN build_jobs build
      ON build.id = NEW.build_job_id
      AND build.workspace_id = NEW.workspace_id
      AND build.repository_id = NEW.repository_id
      AND build.snapshot_id = NEW.snapshot_id
      AND build.status = 'ready'
    JOIN source_snapshots snapshot
      ON snapshot.id = NEW.snapshot_id
      AND snapshot.workspace_id = NEW.workspace_id
      AND snapshot.repository_id = NEW.repository_id
    JOIN build_stage_runs run
      ON run.id = NEW.package_stage_run_id
      AND run.workspace_id = NEW.workspace_id
      AND run.project_id = repository.project_id
      AND run.build_job_id = NEW.build_job_id
      AND run.snapshot_id = NEW.snapshot_id
      AND run.stage = 'package'
      AND run.status IN ('succeeded', 'reused')
    JOIN knowledge_artifacts artifact
      ON artifact.id = NEW.package_artifact_id
      AND artifact.id = ANY(run.output_manifest_ids)
      AND artifact.workspace_id = run.workspace_id
      AND artifact.project_id = run.project_id
      AND artifact.snapshot_id = run.snapshot_id
      AND artifact.stage = 'package'
      AND artifact.kind = 'frontend-pipeline-package'
      AND artifact.schema_version = 2
    WHERE repository.id = NEW.repository_id
      AND repository.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Frontend v2 release must reference its terminal package stage output';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER releases_pipeline_provenance_integrity ON releases;
CREATE TRIGGER releases_pipeline_provenance_integrity
  BEFORE INSERT OR UPDATE OF kernel_mode, package_artifact_id, release_artifact_family,
    package_stage_run_id, frontend_ir_schema_version, frontend_graph_schema_version,
    analyzer_manifest_digest, workspace_id, repository_id, build_job_id, snapshot_id ON releases
  FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_release_provenance();

CREATE OR REPLACE FUNCTION enforce_release_provenance_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kernel_mode IS DISTINCT FROM OLD.kernel_mode
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
    OR NEW.build_job_id IS DISTINCT FROM OLD.build_job_id
    OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
    OR NEW.package_artifact_id IS DISTINCT FROM OLD.package_artifact_id
    OR NEW.release_artifact_family IS DISTINCT FROM OLD.release_artifact_family
    OR NEW.package_stage_run_id IS DISTINCT FROM OLD.package_stage_run_id
    OR NEW.frontend_ir_schema_version IS DISTINCT FROM OLD.frontend_ir_schema_version
    OR NEW.frontend_graph_schema_version IS DISTINCT FROM OLD.frontend_graph_schema_version
    OR NEW.analyzer_manifest_digest IS DISTINCT FROM OLD.analyzer_manifest_digest THEN
    RAISE EXCEPTION 'Release frontend provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER releases_pipeline_provenance_immutable ON releases;
CREATE TRIGGER releases_pipeline_provenance_immutable
  BEFORE UPDATE OF workspace_id, repository_id, build_job_id, snapshot_id,
    kernel_mode, package_artifact_id, release_artifact_family,
    package_stage_run_id, frontend_ir_schema_version, frontend_graph_schema_version,
    analyzer_manifest_digest ON releases
  FOR EACH ROW EXECUTE FUNCTION enforce_release_provenance_immutable();
