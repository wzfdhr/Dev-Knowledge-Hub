CREATE TABLE source_blobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_hash text NOT NULL
    CONSTRAINT source_blobs_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL
    CONSTRAINT source_blobs_generation_check CHECK (generation > 0),
  byte_size bigint NOT NULL
    CONSTRAINT source_blobs_byte_size_check CHECK (byte_size >= 0),
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT source_blobs_status_check CHECK (status IN ('active', 'tombstoned', 'trash', 'deleted')),
  storage_key text NOT NULL,
  fencing_token uuid,
  tombstoned_at timestamptz,
  trashed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_blobs_workspace_hash_generation_unique
    UNIQUE (workspace_id, content_hash, generation),
  CONSTRAINT source_blobs_id_workspace_unique UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX source_blobs_live_workspace_hash_idx
  ON source_blobs (workspace_id, content_hash) WHERE status IN ('active', 'tombstoned');
CREATE INDEX source_blobs_workspace_status_idx
  ON source_blobs (workspace_id, status, updated_at);

ALTER TABLE source_files ADD COLUMN source_blob_id uuid;
CREATE INDEX source_files_source_blob_idx ON source_files (source_blob_id);
ALTER TABLE source_files
  ADD CONSTRAINT source_files_source_blob_workspace_fk
  FOREIGN KEY (source_blob_id, workspace_id)
  REFERENCES source_blobs(id, workspace_id) ON DELETE RESTRICT;
