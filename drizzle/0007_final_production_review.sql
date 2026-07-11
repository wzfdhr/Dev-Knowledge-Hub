ALTER TABLE build_jobs
  ADD COLUMN purpose text NOT NULL DEFAULT 'standard',
  ADD COLUMN feedback_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN feedback_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT build_jobs_purpose_check CHECK (purpose IN ('standard', 'feedback')),
  ADD CONSTRAINT build_jobs_feedback_identity_check CHECK (
    (purpose = 'standard' AND cardinality(feedback_ids) = 0 AND feedback_context = '[]'::jsonb)
    OR (purpose = 'feedback' AND cardinality(feedback_ids) > 0 AND jsonb_array_length(feedback_context) > 0)
  );

CREATE INDEX build_jobs_identity_idx
  ON build_jobs (workspace_id, repository_id, snapshot_id, purpose, feedback_ids);
