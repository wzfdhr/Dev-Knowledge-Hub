CREATE TABLE workspace_mcp_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  scopes text[] NOT NULL,
  session_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_mcp_tokens_owner_workspace_fk
    FOREIGN KEY (user_id, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_mcp_tokens_scopes_check CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['workspace.patterns.read', 'workspace.solutions.read']::text[]
  ),
  CONSTRAINT workspace_mcp_tokens_expiry_check CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX workspace_mcp_tokens_owner_created_idx
  ON workspace_mcp_tokens (workspace_id, user_id, created_at DESC, id DESC);

CREATE INDEX workspace_mcp_tokens_active_hash_idx
  ON workspace_mcp_tokens (token_hash) WHERE revoked_at IS NULL;
