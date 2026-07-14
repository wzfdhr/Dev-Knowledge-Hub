CREATE TABLE admin_mfa (
  user_id uuid PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  encrypted_secret text NOT NULL,
  enabled_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_mfa_workspace_enabled_idx
  ON admin_mfa (workspace_id, enabled_at)
  WHERE enabled_at IS NOT NULL;

CREATE TABLE admin_mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

CREATE INDEX admin_mfa_recovery_codes_active_idx
  ON admin_mfa_recovery_codes (user_id)
  WHERE used_at IS NULL;
