import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
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
const sourceBlobDatabaseStatNames = [
  "sourceBlobCount", "sourceFileBlobReferenceCount", "referencedSourceBlobGenerationCount"
];
const legacyIntegrityNames = [
  "orphanedReleases",
  "orphanedReleaseChannels",
  "crossWorkspaceProjectMembers",
  "projectMembersWithoutWorkspaceMembership",
  "orphanedArtifacts",
  "orphanedSourceAnalysisArtifacts"
];
const sourceBlobIntegrityNames = ["unboundSourceFiles", "invalidSourceBlobReferences"];
const sha256 = /^[a-f0-9]{64}$/;
const utcIsoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const evidenceFields = [
  "schemaVersion", "operation", "result", "startedAt", "finishedAt", "resticSnapshotId",
  "databaseArchiveSha256", "volumeArchives", "volumeArchiveSha256", "volumeFileCounts",
  "productionVolumeTouched", "restoredSnapshotCount", "pgRestoreListValidated",
  "ephemeralDatabaseRestored", "healthCheckPassed", "artifactContentVerifiedCount", "databaseStats",
  "integrity", "blobReferenceCount", "blobContentVerifiedCount", "blobHardlinkVerifiedCount",
  "referencedSourceBlobGenerationCount", "sourceBlobLogicalBytes", "sourceBlobPhysicalBytes",
  "sourceBlobRecordManifest"
];
const sourceBlobRecordFields = [
  "workspaceId", "snapshotId", "sourcePath", "storageKey", "snapshotStoragePath", "contentHash",
  "generation", "byteSize", "status", "fencingToken", "tombstonedAt", "trashedAt", "deletedAt",
  "blobMode", "viewMode", "blobDevice", "blobInode", "viewDevice", "viewInode", "blobSize",
  "viewSize", "blobBlocks", "viewBlocks", "blobAllocatedBytes", "viewAllocatedBytes",
  "blobContentSha256", "viewContentSha256", "relationship"
];
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unsignedInteger = /^(0|[1-9][0-9]*)$/;

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

function parseUnsignedBigInt(value, name) {
  requireEvidence(typeof value === "string" && unsignedInteger.test(value), `${name} must be an unsigned decimal string`);
  return BigInt(value);
}

function validateSourceBlobRecord(record, summary) {
  requireExactFields(record, sourceBlobRecordFields, "source blob record");
  requireEvidence(safeIdentifier.test(record.workspaceId ?? "") && safeIdentifier.test(record.snapshotId ?? ""), "source blob record identity is invalid");
  requireEvidence(typeof record.sourcePath === "string" && !record.sourcePath.includes("\\"), "source blob record path is invalid");
  const pathSegments = record.sourcePath.split("/");
  requireEvidence(pathSegments.length > 0 && pathSegments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\0")), "source blob record path is invalid");
  requireEvidence(sha256.test(record.contentHash ?? ""), "source blob record content hash is invalid");
  requireEvidence(Number.isSafeInteger(record.generation) && record.generation > 0, "source blob record generation is invalid");
  requireEvidence(Number.isSafeInteger(record.byteSize) && record.byteSize >= 0, "source blob record byte size is invalid");
  const expectedStorageKey = ["blobs", record.workspaceId, record.contentHash.slice(0, 2), record.contentHash, String(record.generation)].join("/");
  requireEvidence(record.storageKey === expectedStorageKey, "source blob record storage key is invalid");
  requireEvidence(record.snapshotStoragePath === `/var/lib/devkh/snapshots/snapshots/${record.snapshotId}/files`, "source blob record snapshot path is invalid");

  if (record.status === "active") {
    requireEvidence([record.fencingToken, record.tombstonedAt, record.trashedAt, record.deletedAt].every((value) => value === null), "source blob record active state is invalid");
  } else if (record.status === "tombstoned") {
    requireEvidence(uuid.test(record.fencingToken ?? "") && typeof record.tombstonedAt === "string" && Number.isFinite(Date.parse(record.tombstonedAt)) && record.trashedAt === null && record.deletedAt === null, "source blob record tombstoned state is invalid");
  } else {
    requireEvidence(false, "source blob record lifecycle state is not recoverable");
  }

  for (const name of ["blobMode", "viewMode"]) {
    requireEvidence(typeof record[name] === "string" && /^[0-7]{4}$/.test(record[name]), "source blob record mode is invalid");
    requireEvidence((Number.parseInt(record[name], 8) & 0o222) === 0, "source blob record mode must be read-only");
  }
  const blobDevice = parseUnsignedBigInt(record.blobDevice, "source blob record blob device");
  const blobInode = parseUnsignedBigInt(record.blobInode, "source blob record blob inode");
  const viewDevice = parseUnsignedBigInt(record.viewDevice, "source blob record view device");
  const viewInode = parseUnsignedBigInt(record.viewInode, "source blob record view inode");
  const blobSize = parseUnsignedBigInt(record.blobSize, "source blob record blob size");
  const viewSize = parseUnsignedBigInt(record.viewSize, "source blob record view size");
  const blobBlocks = parseUnsignedBigInt(record.blobBlocks, "source blob record blob blocks");
  const viewBlocks = parseUnsignedBigInt(record.viewBlocks, "source blob record view blocks");
  const blobAllocatedBytes = parseUnsignedBigInt(record.blobAllocatedBytes, "source blob record blob allocated bytes");
  const viewAllocatedBytes = parseUnsignedBigInt(record.viewAllocatedBytes, "source blob record view allocated bytes");
  requireEvidence(blobInode > 0n && viewInode > 0n, "source blob record inode is invalid");
  requireEvidence(blobSize === BigInt(record.byteSize) && viewSize === BigInt(record.byteSize), "source blob record size does not match manifest");
  requireEvidence(blobAllocatedBytes === blobBlocks * 512n && viewAllocatedBytes === viewBlocks * 512n, "source blob record allocated bytes do not match blocks");
  requireEvidence(record.blobContentSha256 === record.contentHash && record.viewContentSha256 === record.contentHash, "source blob record content digest relationship is invalid");
  requireEvidence(record.relationship === "same-device-inode-hardlink" && blobDevice === viewDevice && blobInode === viewInode, "source blob record hardlink relationship is invalid");
  requireEvidence(blobBlocks === viewBlocks && blobAllocatedBytes === viewAllocatedBytes, "source blob record hardlink allocation is inconsistent");

  const sourceKey = [record.workspaceId, record.snapshotId, record.sourcePath].join("/");
  requireEvidence(!summary.sourceKeys.has(sourceKey) && (!summary.previousSourceKey || Buffer.compare(Buffer.from(summary.previousSourceKey), Buffer.from(sourceKey)) < 0), "source blob records must be uniquely sorted");
  summary.sourceKeys.add(sourceKey);
  summary.previousSourceKey = sourceKey;
  summary.recordCount++;

  const generationKey = [record.workspaceId, record.contentHash, record.generation].join("/");
  const generationFact = [record.storageKey, record.blobDevice, record.blobInode, record.byteSize].join("/");
  const knownGeneration = summary.generations.get(generationKey);
  requireEvidence(!knownGeneration || knownGeneration === generationFact, "source blob generation records are inconsistent");
  if (!knownGeneration) {
    summary.generations.set(generationKey, generationFact);
    summary.logicalBytes += BigInt(record.byteSize);
  }
  const inodeKey = `${record.blobDevice}:${record.blobInode}`;
  const generationIdentity = JSON.stringify([
    record.workspaceId,
    record.contentHash,
    record.generation,
    record.storageKey,
    record.byteSize
  ]);
  const knownInode = summary.inodes.get(inodeKey);
  requireEvidence(!knownInode || knownInode.generationIdentity === generationIdentity,
    "source blob inode is reused across generation identities");
  requireEvidence(!knownInode || knownInode.allocatedBytes === blobAllocatedBytes,
    "source blob inode allocation records are inconsistent");
  if (!knownInode) {
    summary.inodes.set(inodeKey, { generationIdentity, allocatedBytes: blobAllocatedBytes });
    summary.physicalBytes += blobAllocatedBytes;
  }
}

function createSourceBlobSummary() {
  return {
    recordCount: 0,
    sourceKeys: new Set(),
    previousSourceKey: undefined,
    generations: new Map(),
    inodes: new Map(),
    logicalBytes: 0n,
    physicalBytes: 0n
  };
}

function validateSourceBlobSummary(evidence, summary) {
  requireEvidence(summary && summary.recordCount === evidence.sourceBlobRecordManifest.recordCount && summary.recordCount === evidence.blobReferenceCount, "source blob record count is inconsistent");
  requireEvidence(summary.generations.size === evidence.referencedSourceBlobGenerationCount && summary.generations.size === evidence.blobContentVerifiedCount, "source blob record generation count is inconsistent");
  requireEvidence(summary.recordCount === evidence.blobHardlinkVerifiedCount, "source blob record hardlink count is inconsistent");
  requireEvidence(summary.logicalBytes === BigInt(evidence.sourceBlobLogicalBytes), "source blob record logical bytes are inconsistent");
  requireEvidence(summary.physicalBytes === BigInt(evidence.sourceBlobPhysicalBytes), "source blob record physical bytes are inconsistent");
}

function validateSourceBlobManifestDescriptor(evidence) {
  requireExactFields(evidence.sourceBlobRecordManifest, ["file", "sha256", "recordCount"], "sourceBlobRecordManifest");
  const { file, sha256: manifestSha256, recordCount } = evidence.sourceBlobRecordManifest;
  requireEvidence(typeof file === "string" && basename(file) === file && !file.includes("\\") && file.endsWith(".source-blobs.ndjson"), "source blob record manifest file is invalid");
  requireEvidence(sha256.test(manifestSha256 ?? ""), "source blob record manifest digest is invalid");
  requireEvidence(Number.isSafeInteger(recordCount) && recordCount > 0, "source blob record manifest count is invalid");
}

export function validateRecoveryEvidence(evidence, options = {}) {
  requireEvidence(evidence && typeof evidence === "object" && !Array.isArray(evidence), "document must be an object");
  requireEvidence(
    evidence.schemaVersion === 3 || (options.allowLegacyV2 === true && evidence.schemaVersion === 2),
    "schemaVersion must be 3"
  );
  const sourceBlobEvidence = evidence.schemaVersion === 3;
  requireExactFields(
    evidence,
    sourceBlobEvidence ? evidenceFields : evidenceFields.filter((field) => ![
      "blobReferenceCount", "blobContentVerifiedCount", "blobHardlinkVerifiedCount",
      "referencedSourceBlobGenerationCount", "sourceBlobLogicalBytes", "sourceBlobPhysicalBytes",
      "sourceBlobRecordManifest"
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
    Number.isInteger(evidence.referencedSourceBlobGenerationCount)
      && evidence.referencedSourceBlobGenerationCount === evidence.databaseStats.referencedSourceBlobGenerationCount
      && evidence.databaseStats.sourceBlobCount >= evidence.referencedSourceBlobGenerationCount,
    "every referenced source blob generation must be accounted for"
  );
  if (sourceBlobEvidence) requireEvidence(
    Number.isInteger(evidence.blobContentVerifiedCount)
      && evidence.blobContentVerifiedCount === evidence.referencedSourceBlobGenerationCount,
    "every referenced source blob generation must have verified content"
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
  if (sourceBlobEvidence) {
    validateSourceBlobManifestDescriptor(evidence);
    validateSourceBlobSummary(evidence, options.sourceBlobManifestSummary);
  }
  return evidence;
}

async function loadSourceBlobManifestSummary(evidencePath, evidence) {
  validateSourceBlobManifestDescriptor(evidence);
  const finalPath = join(dirname(evidencePath), evidence.sourceBlobRecordManifest.file);
  const manifestPath = evidencePath.endsWith(".pending") ? `${finalPath}.pending` : finalPath;
  const manifestHandle = await openRegularNoFollow(manifestPath, "source blob record manifest");

  const summary = createSourceBlobSummary();
  const digestState = createHash("sha256");
  const input = manifestHandle.createReadStream({ autoClose: false });
  let lastByte;
  let containsCarriageReturn = false;
  input.on("data", (chunk) => {
    digestState.update(chunk);
    if (chunk.length) lastByte = chunk[chunk.length - 1];
    if (chunk.includes(0x0d)) containsCarriageReturn = true;
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      requireEvidence(line.length > 0, "source blob record manifest contains an empty record");
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        requireEvidence(false, "source blob record manifest contains invalid JSON");
      }
      requireEvidence(JSON.stringify(record) === line, "source blob record manifest is not canonical NDJSON");
      validateSourceBlobRecord(record, summary);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("recovery evidence validation failed:")) throw error;
    requireEvidence(false, "source blob record manifest could not be read");
  } finally {
    await manifestHandle.close();
  }
  requireEvidence(lastByte === 0x0a && !containsCarriageReturn, "source blob record manifest must use canonical LF-delimited records");
  requireEvidence(digestState.digest("hex") === evidence.sourceBlobRecordManifest.sha256, "source blob record manifest digest does not match");
  return summary;
}

async function openRegularNoFollow(path, label) {
  let handle;
  try {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
    handle = await open(path, flags);
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) throw new Error("not a regular file");
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    requireEvidence(false, `${label} must be a regular no-follow file`);
  }
}

export async function validateRecoveryEvidenceFile(path, options = {}) {
  const evidenceHandle = await openRegularNoFollow(path, "recovery evidence");
  let evidence;
  try {
    evidence = JSON.parse(await evidenceHandle.readFile("utf8"));
  } finally {
    await evidenceHandle.close();
  }
  const sourceBlobManifestSummary = evidence.schemaVersion === 3
    ? await loadSourceBlobManifestSummary(path, evidence)
    : undefined;
  return validateRecoveryEvidence(evidence, {
    allowLegacyV2: options.allowLegacyV2 === true,
    sourceBlobManifestSummary
  });
}

export async function main(args = process.argv.slice(2)) {
  let path;
  let allowLegacyV2 = false;
  for (const argument of args) {
    if (argument === "--allow-legacy-v2") {
      allowLegacyV2 = true;
    } else {
      requireEvidence(!path, "exactly one evidence path is required");
      path = argument;
    }
  }
  requireEvidence(Boolean(path), "evidence path is required");
  const evidence = await validateRecoveryEvidenceFile(path, { allowLegacyV2 });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "recovery evidence validation failed");
    process.exitCode = 1;
  });
}
