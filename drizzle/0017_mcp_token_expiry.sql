ALTER TABLE mcp_tokens
  ADD COLUMN scopes text[] NOT NULL DEFAULT ARRAY['search', 'source.read']::text[],
  ADD COLUMN expires_at timestamptz;

UPDATE mcp_tokens
SET expires_at = created_at + interval '90 days'
WHERE expires_at IS NULL;

ALTER TABLE mcp_tokens
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX mcp_tokens_active_hash_idx
  ON mcp_tokens (token_hash, expires_at)
  WHERE revoked_at IS NULL;
