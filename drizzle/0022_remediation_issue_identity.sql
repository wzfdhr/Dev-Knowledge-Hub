DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM remediation_cases
    WHERE NOT (issue ? 'id')
      OR jsonb_typeof(issue->'id') <> 'string'
      OR btrim(issue->>'id') = ''
  ) THEN
    RAISE EXCEPTION 'remediation identity migration blocked: legacy cases are missing a non-empty issue.id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM remediation_cases
    GROUP BY workspace_id, source_build_id, issue->>'id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'remediation identity migration blocked: legacy cases contain duplicate issue identities';
  END IF;
END
$$;

ALTER TABLE remediation_cases
  ADD COLUMN issue_id text;

UPDATE remediation_cases
  SET issue_id = issue->>'id';

ALTER TABLE remediation_cases
  ALTER COLUMN issue_id SET NOT NULL,
  ADD CONSTRAINT remediation_cases_source_issue_unique
    UNIQUE (workspace_id, source_build_id, issue_id);
