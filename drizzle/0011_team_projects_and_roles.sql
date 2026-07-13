CREATE TYPE team_role AS ENUM ('admin', 'member', 'reader');

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role team_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (user_id, workspace_id)
    REFERENCES admin_users(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX workspace_members_workspace_role_idx ON workspace_members (workspace_id, role);

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT workspace_id, id, 'admin'::team_role FROM admin_users
ON CONFLICT (workspace_id, user_id) DO NOTHING;

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX projects_workspace_slug_idx ON projects (workspace_id, slug);
CREATE INDEX projects_workspace_active_idx ON projects (workspace_id, archived_at);

INSERT INTO projects (workspace_id, name, slug)
SELECT w.id, '默认项目', 'default-project'
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM projects p WHERE p.workspace_id = w.id
) AND NOT EXISTS (
  SELECT 1 FROM repositories r WHERE r.workspace_id = w.id
);

ALTER TABLE repositories ADD COLUMN project_id uuid;

DO $$
DECLARE repository_row record;
DECLARE project_id_value uuid;
BEGIN
  FOR repository_row IN SELECT id, workspace_id, name, archived_at FROM repositories LOOP
    INSERT INTO projects (workspace_id, name, slug, archived_at)
    VALUES (
      repository_row.workspace_id,
      repository_row.name,
      'legacy-' || replace(repository_row.id::text, '-', ''),
      repository_row.archived_at
    )
    RETURNING id INTO project_id_value;

    UPDATE repositories SET project_id = project_id_value WHERE id = repository_row.id;
  END LOOP;
END $$;

ALTER TABLE repositories ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE repositories
  ADD CONSTRAINT repositories_project_workspace_fk
  FOREIGN KEY (project_id, workspace_id)
  REFERENCES projects(id, workspace_id) ON DELETE CASCADE;
CREATE INDEX repositories_workspace_project_idx ON repositories (workspace_id, project_id);

DROP INDEX repositories_workspace_current_unique_idx;
CREATE UNIQUE INDEX repositories_project_current_unique_idx
  ON repositories (project_id)
  WHERE archived_at IS NULL;

ALTER TABLE mcp_tokens ADD COLUMN project_id uuid;
UPDATE mcp_tokens token
SET project_id = repository.project_id
FROM repositories repository
WHERE repository.workspace_id = token.workspace_id AND repository.archived_at IS NULL;
CREATE INDEX mcp_tokens_workspace_project_idx ON mcp_tokens (workspace_id, project_id);
