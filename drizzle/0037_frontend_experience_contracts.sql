CREATE TABLE workspace_pattern_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capability text NOT NULL,
  state text NOT NULL DEFAULT 'candidate',
  superseded_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_pattern_groups_state_check
    CHECK (state IN ('candidate', 'verified', 'recommended', 'standard', 'rejected', 'deprecated')),
  CONSTRAINT workspace_pattern_groups_no_self_supersession_check
    CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  CONSTRAINT workspace_pattern_groups_superseded_workspace_fk
    FOREIGN KEY (superseded_by_id, workspace_id)
    REFERENCES workspace_pattern_groups(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX workspace_pattern_groups_workspace_state_idx
  ON workspace_pattern_groups (workspace_id, state, capability, id);

CREATE TABLE workspace_pattern_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pattern_group_id uuid NOT NULL,
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  evidence_type text NOT NULL DEFAULT 'observed_pattern',
  source_eligibility text NOT NULL,
  title text NOT NULL,
  observed_fact text NOT NULL,
  profile_digest text NOT NULL,
  content_version text NOT NULL,
  citations jsonb NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_pattern_evidence_type_check CHECK (evidence_type = 'observed_pattern'),
  CONSTRAINT workspace_pattern_evidence_source_eligibility_check
    CHECK (source_eligibility IN ('git', 'git_linked', 'admin_attested', 'unverified_upload')),
  CONSTRAINT workspace_pattern_evidence_citations_check
    CHECK (jsonb_typeof(citations) = 'array' AND jsonb_array_length(citations) > 0),
  CONSTRAINT workspace_pattern_evidence_profile_digest_check CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_pattern_evidence_group_workspace_fk
    FOREIGN KEY (pattern_group_id, workspace_id)
    REFERENCES workspace_pattern_groups(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_pattern_evidence_project_workspace_fk
    FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_pattern_evidence_release_workspace_fk
    FOREIGN KEY (release_id, workspace_id) REFERENCES releases(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_pattern_evidence_snapshot_workspace_fk
    FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX workspace_pattern_evidence_projection_idx
  ON workspace_pattern_evidence (workspace_id, pattern_group_id, project_id, revoked_at);

CREATE TABLE workspace_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pattern_group_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  decision text NOT NULL,
  reason text NOT NULL,
  basis_evidence_ids uuid[] NOT NULL,
  applicability jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_decisions_decision_check
    CHECK (decision IN ('approve', 'reject', 'deprecate', 'standardize')),
  CONSTRAINT workspace_decisions_basis_check CHECK (cardinality(basis_evidence_ids) > 0),
  CONSTRAINT workspace_decisions_group_workspace_fk
    FOREIGN KEY (pattern_group_id, workspace_id)
    REFERENCES workspace_pattern_groups(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_decisions_actor_workspace_fk
    FOREIGN KEY (actor_id, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE workspace_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pattern_group_id uuid NOT NULL,
  evidence_id uuid,
  authority text NOT NULL,
  outcome text NOT NULL,
  source_version text NOT NULL,
  checks jsonb NOT NULL,
  report_digest text,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_outcomes_authority_check
    CHECK (authority IN ('signed_ci', 'admin_confirmed', 'user_reported')),
  CONSTRAINT workspace_outcomes_outcome_check
    CHECK (outcome IN ('passed', 'failed', 'rolled_back', 'partial')),
  CONSTRAINT workspace_outcomes_report_digest_check
    CHECK (report_digest IS NULL OR report_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_outcomes_group_workspace_fk
    FOREIGN KEY (pattern_group_id, workspace_id)
    REFERENCES workspace_pattern_groups(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_outcomes_evidence_workspace_fk
    FOREIGN KEY (evidence_id, workspace_id)
    REFERENCES workspace_pattern_evidence(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_outcomes_actor_workspace_fk
    FOREIGN KEY (recorded_by, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE workspace_experience_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pattern_group_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  reason text NOT NULL,
  basis_evidence_ids uuid[] NOT NULL,
  decision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_experience_reviews_state_check
    CHECK (from_state IN ('candidate', 'verified', 'recommended', 'standard', 'rejected', 'deprecated')
      AND to_state IN ('candidate', 'verified', 'recommended', 'standard', 'rejected', 'deprecated')),
  CONSTRAINT workspace_experience_reviews_basis_check
    CHECK (cardinality(basis_evidence_ids) > 0 OR decision_id IS NOT NULL),
  CONSTRAINT workspace_experience_reviews_group_workspace_fk
    FOREIGN KEY (pattern_group_id, workspace_id)
    REFERENCES workspace_pattern_groups(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_experience_reviews_decision_workspace_fk
    FOREIGN KEY (decision_id, workspace_id)
    REFERENCES workspace_decisions(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_experience_reviews_actor_workspace_fk
    FOREIGN KEY (actor_id, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX workspace_experience_reviews_group_created_idx
  ON workspace_experience_reviews (workspace_id, pattern_group_id, created_at, id);

CREATE TABLE workspace_standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pattern_group_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  authored_by uuid NOT NULL,
  superseded_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_standards_no_self_supersession_check
    CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  CONSTRAINT workspace_standards_group_workspace_fk
    FOREIGN KEY (pattern_group_id, workspace_id)
    REFERENCES workspace_pattern_groups(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_standards_actor_workspace_fk
    FOREIGN KEY (authored_by, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_standards_superseded_workspace_fk
    FOREIGN KEY (superseded_by_id, workspace_id)
    REFERENCES workspace_standards(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE workspace_experience_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pattern_group_id uuid NOT NULL,
  evidence_id uuid,
  outcome_id uuid UNIQUE,
  reported_by uuid NOT NULL,
  kind text NOT NULL,
  priority text NOT NULL,
  feedback_event text,
  current_project_id uuid,
  source_version text NOT NULL,
  task_summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_experience_review_items_kind_check
    CHECK (kind IN ('trusted_negative_outcome', 'user_feedback')),
  CONSTRAINT workspace_experience_review_items_priority_check
    CHECK (priority IN ('high', 'normal')),
  CONSTRAINT workspace_experience_review_items_feedback_check
    CHECK (feedback_event IS NULL OR feedback_event IN
      ('considered', 'adopted', 'partially_adopted', 'rejected', 'failed', 'rolled_back')),
  CONSTRAINT workspace_experience_review_items_shape_check CHECK (
    (kind = 'trusted_negative_outcome' AND outcome_id IS NOT NULL
      AND feedback_event IS NULL AND current_project_id IS NULL AND priority = 'high')
    OR
    (kind = 'user_feedback' AND outcome_id IS NULL
      AND feedback_event IS NOT NULL AND current_project_id IS NOT NULL AND priority = 'normal')
  ),
  CONSTRAINT workspace_experience_review_items_group_workspace_fk
    FOREIGN KEY (pattern_group_id, workspace_id)
    REFERENCES workspace_pattern_groups(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_experience_review_items_evidence_workspace_fk
    FOREIGN KEY (evidence_id, workspace_id)
    REFERENCES workspace_pattern_evidence(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_experience_review_items_outcome_workspace_fk
    FOREIGN KEY (outcome_id, workspace_id)
    REFERENCES workspace_outcomes(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_experience_review_items_actor_workspace_fk
    FOREIGN KEY (reported_by, workspace_id) REFERENCES admin_users(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_experience_review_items_project_workspace_fk
    FOREIGN KEY (current_project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX workspace_experience_review_items_queue_idx
  ON workspace_experience_review_items (workspace_id, priority, created_at, id);

CREATE FUNCTION reject_workspace_experience_review_item_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workspace experience review items are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_experience_review_items_append_only_trigger
BEFORE UPDATE OR DELETE ON workspace_experience_review_items
FOR EACH ROW EXECUTE FUNCTION reject_workspace_experience_review_item_mutation();

CREATE FUNCTION validate_workspace_decision_basis() RETURNS trigger AS $$
BEGIN
  IF (
    SELECT count(DISTINCT evidence.id)
    FROM workspace_pattern_evidence evidence
    WHERE evidence.workspace_id = NEW.workspace_id
      AND evidence.pattern_group_id = NEW.pattern_group_id
      AND evidence.id = ANY(NEW.basis_evidence_ids)
  ) <> cardinality(NEW.basis_evidence_ids) THEN
    RAISE EXCEPTION 'workspace decision basis is missing or crosses a pattern group';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_decisions_validate_basis_trigger
BEFORE INSERT ON workspace_decisions
FOR EACH ROW EXECUTE FUNCTION validate_workspace_decision_basis();

CREATE FUNCTION validate_workspace_experience_review_basis() RETURNS trigger AS $$
BEGIN
  IF cardinality(NEW.basis_evidence_ids) > 0 AND (
    SELECT count(DISTINCT evidence.id)
    FROM workspace_pattern_evidence evidence
    WHERE evidence.workspace_id = NEW.workspace_id
      AND evidence.pattern_group_id = NEW.pattern_group_id
      AND evidence.id = ANY(NEW.basis_evidence_ids)
  ) <> cardinality(NEW.basis_evidence_ids) THEN
    RAISE EXCEPTION 'workspace review basis is missing or crosses a pattern group';
  END IF;
  IF NEW.decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_decisions decision
    WHERE decision.workspace_id = NEW.workspace_id
      AND decision.pattern_group_id = NEW.pattern_group_id
      AND decision.id = NEW.decision_id
  ) THEN
    RAISE EXCEPTION 'workspace review decision crosses a pattern group';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_experience_reviews_validate_basis_trigger
BEFORE INSERT ON workspace_experience_reviews
FOR EACH ROW EXECUTE FUNCTION validate_workspace_experience_review_basis();

CREATE FUNCTION reject_workspace_experience_review_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workspace experience reviews are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_experience_reviews_append_only_trigger
BEFORE UPDATE OR DELETE ON workspace_experience_reviews
FOR EACH ROW EXECUTE FUNCTION reject_workspace_experience_review_mutation();
