CREATE UNIQUE INDEX repositories_id_workspace_project_idx
  ON repositories (id, workspace_id, project_id);
CREATE UNIQUE INDEX source_snapshots_id_workspace_repository_idx
  ON source_snapshots (id, workspace_id, repository_id);

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  session_version integer NOT NULL,
  is_replacement boolean NOT NULL,
  expected_current_repository_id uuid NOT NULL,
  expected_latest_snapshot_id uuid,
  status text NOT NULL DEFAULT 'open'
    CONSTRAINT upload_sessions_status_check CHECK (status IN ('open', 'committing', 'committed', 'cancelled')),
  entry_count integer NOT NULL
    CONSTRAINT upload_sessions_entry_count_check CHECK (entry_count BETWEEN 1 AND 100000),
  manifest_digest text
    CONSTRAINT upload_sessions_manifest_digest_check CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$'),
  snapshot_id uuid,
  commit_response jsonb,
  expires_at timestamptz NOT NULL,
  committed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upload_sessions_scope_unique
    UNIQUE (id, workspace_id, project_id, repository_id, actor_id),
  CONSTRAINT upload_sessions_project_workspace_fk
    FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_repository_scope_fk
    FOREIGN KEY (repository_id, workspace_id, project_id)
    REFERENCES repositories(id, workspace_id, project_id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_expected_current_repository_scope_fk
    FOREIGN KEY (expected_current_repository_id, workspace_id, project_id)
    REFERENCES repositories(id, workspace_id, project_id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_expected_latest_snapshot_scope_fk
    FOREIGN KEY (expected_latest_snapshot_id, workspace_id, repository_id)
    REFERENCES source_snapshots(id, workspace_id, repository_id) ON DELETE RESTRICT,
  CONSTRAINT upload_sessions_actor_workspace_fk
    FOREIGN KEY (actor_id, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_snapshot_repository_fk
    FOREIGN KEY (snapshot_id, workspace_id, repository_id)
    REFERENCES source_snapshots(id, workspace_id, repository_id) ON DELETE RESTRICT,
  CONSTRAINT upload_sessions_terminal_shape_check CHECK (
    (status = 'committed' AND manifest_digest IS NOT NULL AND snapshot_id IS NOT NULL
      AND commit_response IS NOT NULL AND committed_at IS NOT NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR status IN ('open', 'committing')
  )
);

CREATE UNIQUE INDEX upload_sessions_id_workspace_idx ON upload_sessions (id, workspace_id);
CREATE INDEX upload_sessions_expiry_idx ON upload_sessions (expires_at)
  WHERE status IN ('open', 'committing', 'committed', 'cancelled');
CREATE INDEX upload_sessions_project_created_idx ON upload_sessions (workspace_id, project_id, created_at DESC);

CREATE TABLE upload_session_entries (
  session_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  ordinal integer NOT NULL CONSTRAINT upload_session_entries_ordinal_check CHECK (ordinal >= 0),
  path text NOT NULL CONSTRAINT upload_session_entries_path_check CHECK (octet_length(path) BETWEEN 1 AND 4096),
  kind text NOT NULL CONSTRAINT upload_session_entries_kind_check CHECK (kind IN ('source', 'asset')),
  byte_size bigint NOT NULL CONSTRAINT upload_session_entries_byte_size_check CHECK (byte_size >= 0),
  content_hash text
    CONSTRAINT upload_session_entries_content_hash_check CHECK (
      (kind = 'source' AND content_hash ~ '^[0-9a-f]{64}$')
      OR (kind = 'asset' AND content_hash IS NULL)
    ),
  media_type text,
  metadata_byte_size integer NOT NULL
    CONSTRAINT upload_session_entries_metadata_byte_size_check CHECK (metadata_byte_size > 0),
  disposition text NOT NULL
    CONSTRAINT upload_session_entries_disposition_check CHECK (disposition IN ('upload_required', 'metadata_only', 'ignored')),
  trust text NOT NULL
    CONSTRAINT upload_session_entries_trust_check CHECK (trust IN ('pending', 'server_verified', 'client_unverified')),
  ignore_reason text,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, ordinal),
  CONSTRAINT upload_session_entries_path_unique UNIQUE (session_id, path),
  CONSTRAINT upload_session_entries_session_workspace_fk
    FOREIGN KEY (session_id, workspace_id) REFERENCES upload_sessions(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT upload_session_entries_state_check CHECK (
    (disposition = 'upload_required' AND trust IN ('pending', 'server_verified') AND ignore_reason IS NULL)
    OR (disposition = 'metadata_only' AND trust = 'client_unverified' AND ignore_reason IS NULL)
    OR (disposition = 'ignored' AND ignore_reason IS NOT NULL)
  )
);

CREATE TABLE upload_idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CONSTRAINT upload_idempotency_keys_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL,
  request_digest text NOT NULL
    CONSTRAINT upload_idempotency_keys_request_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  session_id uuid,
  response_status integer NOT NULL
    CONSTRAINT upload_idempotency_keys_response_status_check CHECK (response_status BETWEEN 200 AND 599),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, idempotency_key),
  CONSTRAINT upload_idempotency_keys_actor_workspace_fk
    FOREIGN KEY (actor_id, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT upload_idempotency_keys_session_workspace_fk
    FOREIGN KEY (session_id, workspace_id) REFERENCES upload_sessions(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX upload_idempotency_keys_expiry_idx ON upload_idempotency_keys (expires_at);

DROP INDEX source_snapshots_repo_commit_idx;
ALTER TABLE source_snapshots ADD COLUMN pending_upload_session_id uuid;
ALTER TABLE source_snapshots ADD COLUMN pending_import_report_id uuid;
CREATE UNIQUE INDEX source_snapshots_repo_commit_idx
  ON source_snapshots (repository_id, commit_sha)
  WHERE pending_upload_session_id IS NULL AND pending_import_report_id IS NULL;
CREATE UNIQUE INDEX source_snapshots_pending_upload_session_unique_idx
  ON source_snapshots (pending_upload_session_id) WHERE pending_upload_session_id IS NOT NULL;
ALTER TABLE source_snapshots
  ADD CONSTRAINT source_snapshots_pending_upload_session_workspace_fk
  FOREIGN KEY (pending_upload_session_id, workspace_id)
  REFERENCES upload_sessions(id, workspace_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX source_snapshots_pending_import_report_unique_idx
  ON source_snapshots (pending_import_report_id) WHERE pending_import_report_id IS NOT NULL;
CREATE UNIQUE INDEX import_reports_id_workspace_repository_idx
  ON import_reports (id, workspace_id, repository_id);
ALTER TABLE source_snapshots
  ADD CONSTRAINT source_snapshots_pending_import_report_scope_fk
  FOREIGN KEY (pending_import_report_id, workspace_id, repository_id)
  REFERENCES import_reports(id, workspace_id, repository_id) ON DELETE CASCADE;

ALTER TABLE import_reports ADD COLUMN upload_session_id uuid;
CREATE UNIQUE INDEX import_reports_upload_session_unique_idx
  ON import_reports (upload_session_id) WHERE upload_session_id IS NOT NULL;
ALTER TABLE import_reports
  ADD CONSTRAINT import_reports_upload_session_scope_fk
  FOREIGN KEY (upload_session_id, workspace_id, project_id, repository_id, actor_id)
  REFERENCES upload_sessions(id, workspace_id, project_id, repository_id, actor_id);
