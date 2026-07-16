ALTER TABLE remediation_events
  ADD COLUMN reason text;

ALTER TABLE remediation_events
  ADD CONSTRAINT remediation_events_reason_length_check
    CHECK (reason IS NULL OR char_length(reason) <= 500),
  ADD CONSTRAINT remediation_events_dismissal_reason_check
    CHECK (
      to_state <> 'dismissed'
      OR (reason IS NOT NULL AND btrim(reason) <> '')
    ) NOT VALID;
