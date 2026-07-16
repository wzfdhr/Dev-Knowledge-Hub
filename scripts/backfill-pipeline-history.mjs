import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

const BATCH_SIZE = 500;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const reportPath = path.resolve(process.env.PIPELINE_HISTORY_REPORT ?? "var/pipeline-history-backfill.json");
  const pool = new Pool({ connectionString });
  const missingSnapshots = [];
  let cursor = "";
  let legacyReleasesRetained = 0;
  try {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT r.id, r.workspace_id, r.build_job_id, b.snapshot_id,
                EXISTS (SELECT 1 FROM source_snapshots s WHERE s.id = b.snapshot_id AND s.workspace_id = r.workspace_id) AS snapshot_exists
         FROM releases r JOIN build_jobs b ON b.id = r.build_job_id AND b.workspace_id = r.workspace_id
         WHERE r.id::text > $1 AND r.kernel_mode = 'legacy'
         ORDER BY r.id::text LIMIT $2`,
        [cursor, BATCH_SIZE]
      );
      if (rows.length === 0) break;
      cursor = rows.at(-1).id;
      legacyReleasesRetained += rows.length;
      for (const row of rows.filter((candidate) => !candidate.snapshot_exists)) {
        missingSnapshots.push({ releaseId: row.id, workspaceId: row.workspace_id, buildId: row.build_job_id, snapshotId: row.snapshot_id });
      }
    }
  } finally {
    await pool.end();
  }
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify({
    schemaVersion: 2,
    policy: "legacy-provenance-only",
    batchSize: BATCH_SIZE,
    legacyReleasesRetained,
    missingSnapshots
  })}\n`, { mode: 0o600 });
  await chmod(reportPath, 0o600);
  console.log(`Retained ${legacyReleasesRetained} legacy releases; identified ${missingSnapshots.length} releases with absent build snapshots.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
