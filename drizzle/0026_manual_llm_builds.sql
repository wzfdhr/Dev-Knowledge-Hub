ALTER TABLE build_jobs
  ADD COLUMN allow_llm boolean NOT NULL DEFAULT false;
