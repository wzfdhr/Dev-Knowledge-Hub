CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX knowledge_pages_text_trgm_idx ON knowledge_pages
  USING gin (lower(title || ' ' || body) gin_trgm_ops);
