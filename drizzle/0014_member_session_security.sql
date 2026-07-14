ALTER TABLE admin_users
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN session_version integer NOT NULL DEFAULT 1;

CREATE INDEX admin_users_workspace_active_idx
  ON admin_users (workspace_id, disabled_at)
  WHERE disabled_at IS NULL;
