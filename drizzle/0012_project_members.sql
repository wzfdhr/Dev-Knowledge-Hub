CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role team_role NOT NULL DEFAULT 'reader',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX project_members_user_idx ON project_members (user_id, project_id);

INSERT INTO project_members (project_id, user_id, role)
SELECT p.id, wm.user_id, 'admin'::team_role
FROM projects p
JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
WHERE wm.role = 'admin'
ON CONFLICT (project_id, user_id) DO NOTHING;
