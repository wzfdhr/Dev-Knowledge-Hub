import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

export function resolveMigrationDirectory(applicationRoot = process.cwd()): string {
  return path.resolve(applicationRoot, "drizzle");
}

const migrationDirectory = resolveMigrationDirectory();

async function appliedMigrations(client: PoolClient): Promise<Set<string>> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const result = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(result.rows.map(({ name }) => name));
}

export async function runMigrations(
  pool: Pool,
  directory = migrationDirectory
): Promise<string[]> {
  const client = await pool.connect();
  const completed: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('dev_knowledge_hub_migrations'))");
    const applied = await appliedMigrations(client);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    for (const name of names) {
      if (applied.has(name)) continue;

      const sql = await readFile(path.join(directory, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        completed.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('dev_knowledge_hub_migrations'))");
    client.release();
  }

  return completed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to run migrations");

  const pool = new Pool({ connectionString });
  try {
    const completed = await runMigrations(pool);
    console.log(completed.length === 0 ? "Database is up to date." : `Applied: ${completed.join(", ")}`);
  } finally {
    await pool.end();
  }
}
