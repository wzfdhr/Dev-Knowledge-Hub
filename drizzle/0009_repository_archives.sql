ALTER TABLE repositories
  ADD COLUMN archived_at timestamptz;

UPDATE repositories SET archived_at = NULL;

DROP INDEX repositories_workspace_unique_idx;

CREATE UNIQUE INDEX repositories_workspace_current_unique_idx
  ON repositories (workspace_id)
  WHERE archived_at IS NULL;
