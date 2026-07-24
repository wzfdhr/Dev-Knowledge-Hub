CREATE TABLE workspace_model_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'deepseek')),
  model text NOT NULL CHECK (length(btrim(model)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspace_model_settings (workspace_id, provider, model)
SELECT workspace_id, metadata->>'provider', metadata->>'model'
FROM encrypted_credentials
WHERE repository_id IS NULL
  AND name = 'model-provider'
  AND metadata->>'provider' IN ('openai', 'anthropic')
  AND length(btrim(coalesce(metadata->>'model', ''))) > 0
ON CONFLICT (workspace_id) DO NOTHING;
