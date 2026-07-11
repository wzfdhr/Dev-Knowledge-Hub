ALTER TABLE repositories
  ADD COLUMN kind text NOT NULL DEFAULT 'git',
  ADD COLUMN local_path text,
  ALTER COLUMN clone_url DROP NOT NULL;

DROP INDEX repositories_workspace_idx;
CREATE UNIQUE INDEX repositories_workspace_unique_idx ON repositories (workspace_id);

ALTER TABLE encrypted_credentials
  ADD COLUMN repository_id uuid;
ALTER TABLE encrypted_credentials
  ADD CONSTRAINT encrypted_credentials_repository_workspace_fk
  FOREIGN KEY (repository_id, workspace_id)
  REFERENCES repositories(id, workspace_id)
  ON DELETE CASCADE;
CREATE UNIQUE INDEX encrypted_credentials_repo_name_idx
  ON encrypted_credentials (repository_id, name);

ALTER TABLE source_snapshots
  ADD COLUMN remote_url text,
  ADD COLUMN commit_timestamp timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN storage_path text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX source_snapshots_repo_commit_idx
  ON source_snapshots (repository_id, commit_sha);

ALTER TABLE source_files
  ADD COLUMN byte_size integer NOT NULL DEFAULT 0;
