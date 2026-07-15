CREATE TABLE knowledge_graph_nodes (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  node_id char(64) NOT NULL CHECK (node_id ~ '^[0-9A-Fa-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('module', 'symbol', 'document', 'table', 'column', 'command')),
  name text NOT NULL,
  qualified_name text NOT NULL,
  candidate boolean NOT NULL DEFAULT false,
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (build_job_id, node_id),
  UNIQUE (workspace_id, project_id, snapshot_id, build_job_id, node_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE CASCADE,
  CHECK (candidate OR jsonb_array_length(source_refs) > 0)
);

CREATE INDEX knowledge_graph_nodes_scope_idx
  ON knowledge_graph_nodes (workspace_id, project_id, snapshot_id, build_job_id, kind, qualified_name);

CREATE TABLE knowledge_graph_edges (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  edge_id char(64) NOT NULL CHECK (edge_id ~ '^[0-9A-Fa-f]{64}$'),
  from_node_id char(64) NOT NULL,
  to_node_id char(64) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('imports', 'exports', 'calls', 'contains', 'documents', 'reads', 'writes', 'depends_on')),
  candidate boolean NOT NULL DEFAULT false,
  candidate_reason text,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (build_job_id, edge_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (build_job_id, from_node_id) REFERENCES knowledge_graph_nodes(build_job_id, node_id) ON DELETE CASCADE,
  CHECK ((candidate AND candidate_reason IS NOT NULL AND length(candidate_reason) > 0) OR (NOT candidate AND candidate_reason IS NULL)),
  CHECK (jsonb_array_length(source_refs) > 0)
);

CREATE INDEX knowledge_graph_edges_scope_idx
  ON knowledge_graph_edges (workspace_id, project_id, snapshot_id, build_job_id, from_node_id, kind);

CREATE OR REPLACE FUNCTION enforce_knowledge_graph_fact_edge()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.candidate AND NOT EXISTS (
    SELECT 1
    FROM knowledge_graph_nodes
    WHERE build_job_id = NEW.build_job_id AND node_id = NEW.to_node_id
  ) THEN
    RAISE EXCEPTION 'Graph fact edge has a dangling node';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_graph_fact_edge_integrity
  BEFORE INSERT OR UPDATE ON knowledge_graph_edges
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_graph_fact_edge();
