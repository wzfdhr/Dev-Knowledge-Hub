import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const volumeNames = ["snapshots", "repositories", "sources", "artifacts"];
const volumeArchives = volumeNames.map((name) => `${name}.tgz`);
const databaseStatNames = [
  "workspaceCount",
  "userCount",
  "projectCount",
  "projectMemberCount",
  "snapshotCount",
  "releaseCount",
  "releaseChannelCount",
  "artifactCount"
];
const integrityNames = [
  "orphanedReleases",
  "orphanedReleaseChannels",
  "crossWorkspaceProjectMembers",
  "projectMembersWithoutWorkspaceMembership",
  "orphanedArtifacts"
];
const sha256 = /^[a-f0-9]{64}$/;

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`recovery evidence validation failed: ${message}`);
}

export function validateRecoveryEvidence(evidence) {
  requireEvidence(evidence && typeof evidence === "object" && !Array.isArray(evidence), "document must be an object");
  requireEvidence(evidence.schemaVersion === 2, "schemaVersion must be 2");
  requireEvidence(evidence.operation === "restore-drill", "operation must be restore-drill");
  requireEvidence(evidence.result === "success", "result must be success");
  requireEvidence(Number.isFinite(Date.parse(evidence.startedAt)), "startedAt must be an ISO timestamp");
  requireEvidence(Number.isFinite(Date.parse(evidence.finishedAt)), "finishedAt must be an ISO timestamp");
  requireEvidence(/^[a-f0-9]{8,64}$/.test(evidence.resticSnapshotId ?? ""), "resticSnapshotId is invalid");
  requireEvidence(sha256.test(evidence.databaseArchiveSha256 ?? ""), "database archive digest is invalid");
  requireEvidence(
    JSON.stringify(evidence.volumeArchives) === JSON.stringify(volumeArchives),
    "volumeArchives must list every durable archive"
  );
  for (const name of volumeNames) {
    requireEvidence(
      Number.isInteger(evidence.volumeFileCounts?.[name]) && evidence.volumeFileCounts[name] > 0,
      `${name} restored file count must be positive`
    );
    requireEvidence(
      sha256.test(evidence.volumeArchiveSha256?.[name] ?? ""),
      `${name} archive digest is invalid`
    );
  }
  for (const name of databaseStatNames) {
    requireEvidence(
      Number.isInteger(evidence.databaseStats?.[name]) && evidence.databaseStats[name] > 0,
      `${name} must be a positive integer`
    );
  }
  for (const name of integrityNames) {
    requireEvidence(evidence.integrity?.[name] === 0, `${name} must be zero`);
  }
  requireEvidence(evidence.productionVolumeTouched === false, "production volumes must not be touched");
  requireEvidence(evidence.restoredSnapshotCount === 1, "exactly one snapshot must be restored");
  requireEvidence(evidence.pgRestoreListValidated === true, "pg_restore list must be validated");
  requireEvidence(evidence.ephemeralDatabaseRestored === true, "ephemeral database restore must pass");
  requireEvidence(evidence.healthCheckPassed === true, "application health check must pass");
  requireEvidence(
    Number.isInteger(evidence.artifactContentVerifiedCount)
      && evidence.artifactContentVerifiedCount === evidence.databaseStats.artifactCount,
    "every artifact must have verified content"
  );
  return evidence;
}

export async function main(args = process.argv.slice(2)) {
  const [path] = args;
  requireEvidence(Boolean(path), "evidence path is required");
  const evidence = JSON.parse(await readFile(path, "utf8"));
  process.stdout.write(`${JSON.stringify(validateRecoveryEvidence(evidence))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "recovery evidence validation failed");
    process.exitCode = 1;
  });
}
