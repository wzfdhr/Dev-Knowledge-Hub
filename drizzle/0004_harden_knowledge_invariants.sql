ALTER TABLE build_events ADD COLUMN sequence bigserial;
CREATE UNIQUE INDEX build_events_sequence_idx ON build_events (sequence);

ALTER TABLE code_edges ADD COLUMN target_path text;
