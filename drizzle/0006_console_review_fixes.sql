ALTER TABLE encrypted_credentials
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX encrypted_credentials_workspace_model_idx
  ON encrypted_credentials (workspace_id, name)
  WHERE repository_id IS NULL;

ALTER TABLE agent_feedback
  ADD COLUMN citations jsonb NOT NULL DEFAULT '[]'::jsonb;
