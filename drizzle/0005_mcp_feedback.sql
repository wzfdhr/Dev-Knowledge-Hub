ALTER TABLE mcp_tokens ADD COLUMN token_prefix text;
ALTER TABLE mcp_tokens ADD COLUMN revoked_at timestamptz;
UPDATE mcp_tokens SET token_prefix = '' WHERE token_prefix IS NULL;
ALTER TABLE mcp_tokens ALTER COLUMN token_prefix SET NOT NULL;
CREATE UNIQUE INDEX mcp_tokens_hash_idx ON mcp_tokens (token_hash);

ALTER TABLE agent_feedback ADD COLUMN release_id uuid;
ALTER TABLE agent_feedback ADD COLUMN query text;
ALTER TABLE agent_feedback ADD COLUMN reason text;
ALTER TABLE agent_feedback ADD COLUMN expected text;
ALTER TABLE agent_feedback ADD COLUMN rebuild_build_id uuid;
UPDATE agent_feedback SET query = message, reason = message WHERE query IS NULL OR reason IS NULL;
ALTER TABLE agent_feedback ALTER COLUMN query SET NOT NULL;
ALTER TABLE agent_feedback ALTER COLUMN reason SET NOT NULL;
ALTER TABLE agent_feedback DROP COLUMN message;
ALTER TABLE agent_feedback ADD CONSTRAINT agent_feedback_release_workspace_fk
  FOREIGN KEY (release_id, workspace_id) REFERENCES releases(id, workspace_id);
ALTER TABLE agent_feedback ADD CONSTRAINT agent_feedback_rebuild_workspace_fk
  FOREIGN KEY (rebuild_build_id, workspace_id) REFERENCES build_jobs(id, workspace_id);
