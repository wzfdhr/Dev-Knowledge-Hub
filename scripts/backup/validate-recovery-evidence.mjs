import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const volumeNames = ["snapshots", "repositories", "sources", "artifacts"];
const volumeArchives = volumeNames.map((name) => `${name}.tgz`);
const legacyDatabaseStatNames = [
  "workspaceCount",
  "userCount",
  "projectCount",
  "projectMemberCount",
  "snapshotCount",
  "releaseCount",
  "releaseChannelCount",
  "artifactCount",
  "sourceAnalysisArtifactCount"
];
const sourceBlobDatabaseStatNames = ["sourceBlobCount", "sourceFileBlobReferenceCount"];
const legacyIntegrityNames = [
  "orphanedReleases",
  "orphanedReleaseChannels",
  "crossWorkspaceProjectMembers",
  "projectMembersWithoutWorkspaceMembership",
  "orphanedArtifacts",
  "orphanedSourceAnalysisArtifacts"
];
const sourceBlobIntegrityNames = ["invalidSourceBlobReferences"];
const sha256 = /^[a-f0-9]{64}$/;
const utcIsoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const evidenceFields = [
  "schemaVersion", "operation", "result", "startedAt", "finishedAt", "resticSnapshotId",
  "databaseArchiveSha256", "volumeArchives", "volumeArchiveSha256", "volumeFileCounts",
  "productionVolumeTouched", "restoredSnapshotCount", "pgRestoreListValidated",
  "ephemeralDatabaseRestored", "healthCheckPassed", "artifactContentVerifiedCount", "databaseStats",
  "integrity", "blobReferenceCount", "blobContentVerifiedCount", "blobHardlinkVerifiedCount",
  "sourceBlobGenerationCount", "sourceBlobLogicalBytes", "sourceBlobPhysicalBytes"
];

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`recovery evidence validation failed: ${message}`);
}

function requireExactFields(value, fields, name) {
  requireEvidence(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  const actual = Object.keys(value);
  requireEvidence(actual.length === fields.length && fields.every((field) => Object.hasOwn(value, field)), `${name} has unexpected or missing fields`);
}

function parseUtcTimestamp(value, name) {
  requireEvidence(typeof value === "string" && utcIsoTimestamp.test(value), `${name} must be a UTC ISO timestamp`);
  const parsed = new Date(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  requireEvidence(Number.isFinite(parsed.getTime()) && parsed.toISOString() === canonical, `${name} must be a valid UTC ISO timestamp`);
  return parsed.getTime();
}

export function validateRecoveryEvidence(evidence) {
  requireEvidence(evidence && typeof evidence === "object" && !Array.isArray(evidence), "document must be an object");
  requireEvidence(evidence.schemaVersion === 2 || evidence.schemaVersion === 3, "schemaVersion must be 2 or 3");
  const sourceBlobEvidence = evidence.schemaVersion === 3;
  requireExactFields(
    evidence,
    sourceBlobEvidence ? evidenceFields : evidenceFields.filter((field) => ![
      "blobReferenceCount", "blobContentVerifiedCount", "blobHardlinkVerifiedCount",
      "sourceBlobGenerationCount", "sourceBlobLogicalBytes", "sourceBlobPhysicalBytes"
    ].includes(field)),
    "document"
  );
  requireEvidence(evidence.operation === "restore-drill", "operation must be restore-drill");
  requireEvidence(evidence.result === "success", "result must be success");
  const startedAt = parseUtcTimestamp(evidence.startedAt, "startedAt");
  const finishedAt = parseUtcTimestamp(evidence.finishedAt, "finishedAt");
  requireEvidence(finishedAt >= startedAt, "finishedAt must not be earlier than startedAt");
  requireEvidence(sha256.test(evidence.resticSnapshotId ?? ""), "resticSnapshotId is invalid");
  requireEvidence(sha256.test(evidence.databaseArchiveSha256 ?? ""), "database archive digest is invalid");
  requireEvidence(
    JSON.stringify(evidence.volumeArchives) === JSON.stringify(volumeArchives),
    "volumeArchives must list every durable archive"
  );
  requireExactFields(evidence.volumeArchiveSha256, volumeNames, "volumeArchiveSha256");
  requireExactFields(evidence.volumeFileCounts, volumeNames, "volumeFileCounts");
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
  const databaseStatNames = sourceBlobEvidence
    ? [...legacyDatabaseStatNames, ...sourceBlobDatabaseStatNames]
    : legacyDatabaseStatNames;
  requireExactFields(evidence.databaseStats, databaseStatNames, "databaseStats");
  for (const name of databaseStatNames) {
    requireEvidence(
      Number.isInteger(evidence.databaseStats?.[name]) && evidence.databaseStats[name] > 0,
      `${name} must be a positive integer`
    );
  }
  const integrityNames = sourceBlobEvidence
    ? [...legacyIntegrityNames, ...sourceBlobIntegrityNames]
    : legacyIntegrityNames;
  requireExactFields(evidence.integrity, integrityNames, "integrity");
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
  if (sourceBlobEvidence) requireEvidence(
    Number.isInteger(evidence.blobReferenceCount)
      && evidence.blobReferenceCount === evidence.databaseStats.sourceFileBlobReferenceCount,
    "every source file blob reference must be verified"
  );
  if (sourceBlobEvidence) requireEvidence(
    Number.isInteger(evidence.sourceBlobGenerationCount)
      && evidence.sourceBlobGenerationCount === evidence.databaseStats.sourceBlobCount,
    "every source blob generation must be accounted for"
  );
  if (sourceBlobEvidence) requireEvidence(
    Number.isInteger(evidence.blobContentVerifiedCount)
      && evidence.blobContentVerifiedCount === evidence.sourceBlobGenerationCount,
    "every source blob generation must have verified content"
  );
  if (sourceBlobEvidence) requireEvidence(
    Number.isInteger(evidence.blobHardlinkVerifiedCount)
      && evidence.blobHardlinkVerifiedCount === evidence.blobReferenceCount,
    "every source file blob reference must preserve its hardlink"
  );
  if (sourceBlobEvidence) requireEvidence(
    Number.isSafeInteger(evidence.sourceBlobLogicalBytes) && evidence.sourceBlobLogicalBytes >= 0,
    "source blob logical bytes must be a non-negative safe integer"
  );
  if (sourceBlobEvidence) requireEvidence(
    Number.isSafeInteger(evidence.sourceBlobPhysicalBytes)
      && evidence.sourceBlobPhysicalBytes >= 0
      && evidence.sourceBlobPhysicalBytes % 512 === 0,
    "source blob physical bytes must be allocated-block bytes"
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
