CREATE TABLE source_analysis_artifacts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_hash char(64) NOT NULL
    CONSTRAINT source_analysis_artifacts_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  analyzer_id text NOT NULL
    CONSTRAINT source_analysis_artifacts_analyzer_id_check CHECK (analyzer_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  analyzer_version text NOT NULL
    CONSTRAINT source_analysis_artifacts_analyzer_version_check CHECK (analyzer_version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$'),
  parser_config_digest char(64) NOT NULL
    CONSTRAINT source_analysis_artifacts_parser_config_digest_check CHECK (parser_config_digest ~ '^[0-9a-f]{64}$'),
  facts jsonb NOT NULL
    CONSTRAINT source_analysis_artifacts_facts_object_check CHECK (jsonb_typeof(facts) = 'object')
    CONSTRAINT source_analysis_artifacts_facts_size_check CHECK (octet_length(facts::text) <= 8388608),
  facts_digest char(64) NOT NULL
    CONSTRAINT source_analysis_artifacts_facts_digest_check CHECK (facts_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, content_hash, analyzer_id, analyzer_version, parser_config_digest)
);

CREATE OR REPLACE FUNCTION reject_source_analysis_artifact_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source analysis artifacts are immutable';
END;
$$;

CREATE TRIGGER source_analysis_artifacts_immutable
  BEFORE UPDATE ON source_analysis_artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_source_analysis_artifact_update();
