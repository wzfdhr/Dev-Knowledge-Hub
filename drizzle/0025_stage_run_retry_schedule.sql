ALTER TABLE build_stage_runs
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX build_stage_runs_available_claim_idx
  ON build_stage_runs (status, available_at, created_at, id);
