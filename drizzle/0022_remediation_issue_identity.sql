ALTER TABLE remediation_cases
  ADD COLUMN issue_id text;

UPDATE remediation_cases
  SET issue_id = issue->>'id';

ALTER TABLE remediation_cases
  ALTER COLUMN issue_id SET NOT NULL,
  ADD CONSTRAINT remediation_cases_source_issue_unique
    UNIQUE (workspace_id, source_build_id, issue_id);
