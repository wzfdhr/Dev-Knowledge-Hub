import { Pool } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runMigrations } from "../../db/migrate";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
let pool: Pool | null = null;

integration("PostgreSQL cited knowledge integration", () => {
  test(databaseUrl
    ? "migrates durable build, citation, search, and release structures"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    const { rows } = await pool.query<{ names: string[] }>(
      `SELECT array_agg(table_name ORDER BY table_name) AS names
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('build_events', 'build_jobs', 'knowledge_chunks', 'releases')`
    );
    expect(rows[0].names).toEqual([
      "build_events", "build_jobs", "knowledge_chunks", "releases"
    ]);
    const extension = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"
    );
    expect(extension.rows).toHaveLength(1);
  });
});

afterAll(async () => {
  await pool?.end();
});
