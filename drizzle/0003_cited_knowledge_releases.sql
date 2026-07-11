CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE code_symbols
  ADD COLUMN start_line integer NOT NULL DEFAULT 1,
  ADD COLUMN end_line integer NOT NULL DEFAULT 1,
  ADD COLUMN exported boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX code_symbols_source_identity_idx
  ON code_symbols (source_file_id, kind, name, start_line, end_line);

ALTER TABLE code_edges
  ALTER COLUMN source_symbol_id DROP NOT NULL,
  ALTER COLUMN target_symbol_id DROP NOT NULL,
  ADD COLUMN source_name text NOT NULL DEFAULT '',
  ADD COLUMN target_name text NOT NULL DEFAULT '',
  ADD COLUMN source_path text NOT NULL DEFAULT '',
  ADD COLUMN snapshot_id uuid,
  ADD COLUMN start_line integer NOT NULL DEFAULT 1,
  ADD COLUMN end_line integer NOT NULL DEFAULT 1;
ALTER TABLE code_edges
  ADD CONSTRAINT code_edges_snapshot_workspace_fk
  FOREIGN KEY (snapshot_id, workspace_id)
  REFERENCES source_snapshots(id, workspace_id)
  ON DELETE CASCADE;
CREATE INDEX code_edges_snapshot_idx ON code_edges (snapshot_id);
CREATE UNIQUE INDEX code_edges_snapshot_identity_idx
  ON code_edges (snapshot_id, kind, source_name, target_name, source_path, start_line, end_line);

ALTER TABLE build_jobs
  ADD COLUMN snapshot_path text NOT NULL DEFAULT '',
  ADD COLUMN commit_sha text NOT NULL DEFAULT '',
  ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;

DROP INDEX knowledge_pages_repository_slug_idx;
CREATE UNIQUE INDEX knowledge_pages_build_slug_idx ON knowledge_pages (build_job_id, slug);

ALTER TABLE knowledge_chunks
  ADD COLUMN citations jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE releases
  ADD COLUMN snapshot_id uuid,
  ADD COLUMN published_at timestamptz,
  ADD CONSTRAINT releases_snapshot_workspace_fk
    FOREIGN KEY (snapshot_id, workspace_id)
    REFERENCES source_snapshots(id, workspace_id)
    ON DELETE RESTRICT;
UPDATE releases r
SET snapshot_id = b.snapshot_id
FROM build_jobs b
WHERE b.id = r.build_job_id;
ALTER TABLE releases ALTER COLUMN snapshot_id SET NOT NULL;

CREATE TABLE build_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  build_job_id uuid NOT NULL,
  status build_job_status NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (build_job_id, workspace_id)
    REFERENCES build_jobs(id, workspace_id)
    ON DELETE CASCADE
);
CREATE INDEX build_events_build_created_idx ON build_events (build_job_id, created_at);
CREATE INDEX code_symbols_name_trgm_idx ON code_symbols USING gin (lower(name) gin_trgm_ops);
CREATE INDEX source_files_path_trgm_idx ON source_files USING gin (lower(path) gin_trgm_ops);
CREATE INDEX knowledge_pages_search_idx ON knowledge_pages
  USING gin (to_tsvector('english', title || ' ' || body));
