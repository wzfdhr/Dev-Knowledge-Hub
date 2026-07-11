CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE build_job_status AS ENUM (
  'queued', 'syncing', 'parsing', 'synthesizing',
  'validating', 'ready', 'published', 'failed'
);
CREATE TYPE agent_feedback_status AS ENUM ('open', 'acknowledged', 'fixed', 'dismissed');

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspaces_slug_idx ON workspaces (slug);

CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX admin_users_workspace_email_idx ON admin_users (workspace_id, email);

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  clone_url text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE INDEX repositories_workspace_idx ON repositories (workspace_id);

CREATE TABLE encrypted_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE INDEX encrypted_credentials_workspace_idx ON encrypted_credentials (workspace_id);

CREATE TABLE source_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  commit_sha text NOT NULL,
  ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (repository_id, workspace_id) REFERENCES repositories(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX source_snapshots_workspace_repo_idx ON source_snapshots (workspace_id, repository_id);

CREATE TABLE source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL,
  path text NOT NULL,
  language text,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX source_files_snapshot_path_idx ON source_files (snapshot_id, path);

CREATE TABLE code_symbols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_file_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (source_file_id, workspace_id) REFERENCES source_files(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX code_symbols_workspace_file_idx ON code_symbols (workspace_id, source_file_id);

CREATE TABLE code_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_symbol_id uuid NOT NULL,
  target_symbol_id uuid NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (source_symbol_id, workspace_id) REFERENCES code_symbols(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (target_symbol_id, workspace_id) REFERENCES code_symbols(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX code_edges_workspace_source_idx ON code_edges (workspace_id, source_symbol_id);

CREATE TABLE build_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  snapshot_id uuid,
  status build_job_status NOT NULL DEFAULT 'queued',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (repository_id, workspace_id) REFERENCES repositories(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id)
);
CREATE INDEX build_jobs_workspace_status_idx ON build_jobs (workspace_id, status);

CREATE TABLE knowledge_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (repository_id, workspace_id) REFERENCES repositories(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX knowledge_pages_repository_slug_idx ON knowledge_pages (repository_id, slug);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL,
  heading text,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (page_id, workspace_id) REFERENCES knowledge_pages(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_chunks_workspace_page_idx ON knowledge_chunks (workspace_id, page_id);

CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (repository_id, workspace_id) REFERENCES repositories(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX releases_repository_version_idx ON releases (repository_id, version);

CREATE TABLE release_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  release_id uuid,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (repository_id, workspace_id) REFERENCES repositories(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (release_id, workspace_id) REFERENCES releases(id, workspace_id)
);
CREATE UNIQUE INDEX release_channels_repository_name_idx ON release_channels (repository_id, name);

CREATE TABLE mcp_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE INDEX mcp_tokens_workspace_idx ON mcp_tokens (workspace_id);

CREATE TABLE agent_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid,
  status agent_feedback_status NOT NULL DEFAULT 'open',
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (page_id, workspace_id) REFERENCES knowledge_pages(id, workspace_id)
);
CREATE INDEX agent_feedback_workspace_status_idx ON agent_feedback (workspace_id, status);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (actor_id, workspace_id) REFERENCES admin_users(id, workspace_id)
);
CREATE INDEX audit_events_workspace_created_idx ON audit_events (workspace_id, created_at);
