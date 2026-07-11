ALTER TABLE knowledge_chunks
  ADD COLUMN position integer;

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY page_id ORDER BY created_at, id) - 1 AS position
  FROM knowledge_chunks
)
UPDATE knowledge_chunks chunk
SET position = ranked.position::integer
FROM ranked
WHERE ranked.id = chunk.id;

ALTER TABLE knowledge_chunks
  ALTER COLUMN position SET NOT NULL,
  ADD CONSTRAINT knowledge_chunks_position_nonnegative CHECK (position >= 0);

CREATE UNIQUE INDEX knowledge_chunks_page_position_idx
  ON knowledge_chunks (page_id, position);
