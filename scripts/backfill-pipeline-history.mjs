import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

const BATCH_SIZE = 500;

async function writePrivateReport(payload) {
  const reportRoot = path.resolve(process.env.DEVKH_DATA_DIR ?? "var", "reports");
  const reportName = process.env.PIPELINE_HISTORY_REPORT ?? "pipeline-history-backfill.json";
  if (reportName === "" || path.isAbsolute(reportName) || path.basename(reportName) !== reportName
    || reportName === "." || reportName === ".." || reportName.includes("/") || reportName.includes("\\")) {
    throw new Error("PIPELINE_HISTORY_REPORT must be a filename inside DEVKH_DATA_DIR/reports");
  }
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  const root = await lstat(reportRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("DEVKH_DATA_DIR/reports must be a real directory");
  await chmod(reportRoot, 0o700);
  const reportPath = path.join(reportRoot, reportName);
  const temporaryPath = path.join(reportRoot, `.${reportName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, reportPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString });
  const missingSnapshots = [];
  let cursor = "";
  let legacyReleasesRetained = 0;
  try {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT r.id, r.workspace_id, r.build_job_id, b.snapshot_id,
                EXISTS (
                  SELECT 1 FROM source_snapshots s
                  WHERE s.id = b.snapshot_id
                    AND s.workspace_id = r.workspace_id
                    AND b.repository_id = r.repository_id
                    AND s.repository_id = r.repository_id
                    AND r.snapshot_id = b.snapshot_id
                ) AS snapshot_exists
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
  await writePrivateReport({
    schemaVersion: 2,
    policy: "legacy-provenance-only",
    batchSize: BATCH_SIZE,
    legacyReleasesRetained,
    missingSnapshots
  });
  console.log(`Retained ${legacyReleasesRetained} legacy releases; identified ${missingSnapshots.length} releases with absent build snapshots.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
