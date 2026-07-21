import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yauzl from "yauzl";

import { validateRecoveryEvidenceFile } from "./backup/validate-recovery-evidence.mjs";
import { validatePostContractBaselineGrammar } from "./verify-post-contract-database.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const verifierRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(process.env.DEVKH_RELEASE_CANDIDATE_ROOT || verifierRepositoryRoot);
const compose = ["compose", "-f", resolve(repositoryRoot, "docker-compose.yml")];
const postContractCompose = [
  ...compose,
  "-f",
  resolve(repositoryRoot, "docker-compose.post-contract-ci.yml")
];
const sourceBlobContractMigration = resolve(repositoryRoot, "drizzle/0035_source_blobs_contract.sql");
const sourceBlobObservationMs = 7 * 24 * 60 * 60 * 1_000;
const sourceBlobRecoveryEvidenceMaxAgeMs = 24 * 60 * 60 * 1_000;

export const VERIFY_STEPS = Object.freeze([
  { name: "secrets", command: npm, args: ["run", "secrets:scan"] },
  { name: "licenses", command: npm, args: ["run", "licenses:check"] },
  { name: "runtime", command: npm, args: ["run", "runtime:verify"] },
  { name: "runtime-tests", command: npm, args: ["run", "test:runtime"] },
  { name: "backup-tests", command: npm, args: ["run", "test:backup"] },
  { name: "delivery", command: npm, args: ["run", "delivery:verify"] },
  { name: "typecheck", command: npm, args: ["run", "typecheck"] },
  { name: "lint", command: npm, args: ["run", "lint"] },
  { name: "unit", command: npm, args: ["test"] },
  { name: "postgres-integration", command: npm, args: ["run", "test:integration"] },
  { name: "build", command: npm, args: ["run", "build"] },
  { name: "acceptance", command: npm, args: ["run", "acceptance"] },
  { name: "knowledge-quality", command: npm, args: ["run", "evaluate:knowledge"] },
  { name: "e2e", command: npm, args: ["run", "test:e2e"] }
]);

export const CONTAINER_STEPS = Object.freeze([
  { name: "container-build", command: "docker", args: ["build", "--target", "runtime", "-t", "devkh:ci", repositoryRoot] },
  { name: "compose-config", command: "docker", args: [...compose, "config", "--quiet"] },
  { name: "compose-infrastructure", command: "docker", args: [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "120", "postgres", "parser"] },
  { name: "source-blob-contract-migration", command: "docker", args: [...compose, "--profile", "source-blob-contract", "run", "--rm", "--build", "contract-migrate"] },
  { name: "compose-app", command: "docker", args: [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "120", "app"] },
  { name: "parser-isolation", command: "node", args: [resolve(verifierRepositoryRoot, "scripts/security/verify-parser-container.mjs")] },
  {
    name: "application-health",
    command: "docker",
    args: [...compose, "exec", "-T", "app", "node", "-e",
      "fetch('http://127.0.0.1:3000/api/health').then(async(response)=>{console.log(await response.text());process.exit(response.ok?0:1)}).catch(()=>process.exit(1))"]
  },
  { name: "recovery-drill", command: "bash", args: [resolve(verifierRepositoryRoot, "scripts/backup/ci-recovery-drill.sh")] }
]);

export const STANDARD_CONTAINER_STEPS = Object.freeze([
  { name: "container-build", command: "docker", args: ["build", "--target", "runtime", "-t", "devkh:ci", repositoryRoot] },
  { name: "compose-config", command: "docker", args: [...compose, "config", "--quiet"] },
  { name: "compose-up", command: "docker", args: [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "120", "postgres", "parser", "app"] },
  { name: "parser-isolation", command: "node", args: [resolve(verifierRepositoryRoot, "scripts/security/verify-parser-container.mjs")] },
  {
    name: "application-health",
    command: "docker",
    args: [...compose, "exec", "-T", "app", "node", "-e",
      "fetch('http://127.0.0.1:3000/api/health').then(async(response)=>{console.log(await response.text());process.exit(response.ok?0:1)}).catch(()=>process.exit(1))"]
  },
  { name: "recovery-drill", command: "bash", args: [resolve(verifierRepositoryRoot, "scripts/backup/ci-recovery-drill.sh")] }
]);

export const POST_CONTRACT_CONTAINER_STEPS = Object.freeze([
  { name: "container-build", command: "docker", args: ["build", "--target", "runtime", "-t", "devkh:ci", repositoryRoot] },
  { name: "post-contract-compose-config", command: "docker", args: [...postContractCompose, "config", "--quiet"] },
  { name: "post-contract-compose-infrastructure", command: "docker", args: [...postContractCompose, "up", "-d", "--build", "--wait", "--wait-timeout", "120", "postgres", "parser"] },
  { name: "post-contract-database-audit", command: "node", args: [resolve(verifierRepositoryRoot, "scripts/verify-post-contract-database.mjs")] },
  { name: "post-contract-compose-app", command: "docker", args: [...postContractCompose, "up", "-d", "--build", "--wait", "--wait-timeout", "120", "app"] },
  { name: "parser-isolation", command: "node", args: [resolve(verifierRepositoryRoot, "scripts/security/verify-parser-container.mjs")] },
  {
    name: "application-health",
    command: "docker",
    args: [...postContractCompose, "exec", "-T", "app", "node", "-e",
      "fetch('http://127.0.0.1:3000/api/health').then(async(response)=>{console.log(await response.text());process.exit(response.ok?0:1)}).catch(()=>process.exit(1))"]
  },
  { name: "recovery-drill", command: "bash", args: [resolve(verifierRepositoryRoot, "scripts/backup/ci-recovery-drill.sh")] }
]);

const cleanupStep = {
  name: "compose-cleanup",
  command: "docker",
  args: [...compose, "down", "--volumes"]
};

function commandText(step) {
  return step.command ? [step.command, ...step.args].join(" ") : `GET ${step.healthUrl}`;
}

async function invalidateRecoveryEvidence(root, errorClass) {
  if (!root) return;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "recovery-verification-failed.json"), `${JSON.stringify({
    schemaVersion: 1,
    operation: errorClass === "container_verification_failed" ? "container-verification" : "restore-drill",
    result: "failed",
    errorClass,
    finishedAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });
}

export async function finalizeRecoveryEvidence(root, options = {}) {
  if (!root) throw new Error("RECOVERY_EVIDENCE_DIR is required to finalize container recovery evidence");
  const { readdir, rename } = await import("node:fs/promises");
  const renameFile = options.renameFile ?? rename;
  const validateEvidence = options.validateEvidence ?? validateRecoveryEvidenceFile;
  const removeArtifacts = async () => {
    const current = await readdir(root, { recursive: true }).catch(() => []);
    const artifacts = current.filter((entry) => {
      const evidenceDirectoryEntry = entry.split(/[\\/]/).includes("recovery-evidence");
      return evidenceDirectoryEntry && (
        entry.endsWith(".json.pending")
        || entry.endsWith(".source-blobs.ndjson.pending")
        || entry.endsWith(".source-blobs.ndjson")
        || entry.endsWith(".json")
      );
    });
    await Promise.all(artifacts.map((entry) => rm(join(root, entry), { force: true })));
  };

  try {
    const entries = await readdir(root, { recursive: true });
    const pendingJson = entries.filter((entry) => entry.endsWith(".json.pending"));
    const pendingSidecar = entries.filter((entry) => entry.endsWith(".source-blobs.ndjson.pending"));
    if (pendingJson.length !== 1 || pendingSidecar.length !== 1) {
      throw new Error(`Expected exactly one pending recovery evidence pair, found ${pendingJson.length} JSON and ${pendingSidecar.length} sidecar files`);
    }
    const jsonPendingPath = join(root, pendingJson[0]);
    const sidecarPendingPath = join(root, pendingSidecar[0]);
    const jsonFinalPath = jsonPendingPath.slice(0, -".pending".length);
    const sidecarFinalPath = sidecarPendingPath.slice(0, -".pending".length);
    await renameFile(sidecarPendingPath, sidecarFinalPath);
    await renameFile(jsonPendingPath, jsonFinalPath);
    await validateEvidence(jsonFinalPath);
    return jsonFinalPath;
  } catch (error) {
    await removeArtifacts();
    throw error;
  }
}

export function parseReleaseScope(args) {
  if (args.length === 0) return "verify";
  const inline = args.find((arg) => arg.startsWith("--scope="));
  const value = inline?.slice("--scope=".length)
    ?? (args[0] === "--scope" ? args[1] : undefined);
  if (value === "verify" || value === "container" || value === "runtime-container" || value === "all") return value;
  throw new Error(`Unknown release verification scope: ${value ?? args.join(" ")}`);
}

export function assertContainerIsolation(env) {
  if (env.DEVKH_CONTAINER_SMOKE !== "true") {
    throw new Error("DEVKH_CONTAINER_SMOKE=true is required for destructive container verification");
  }
  const project = env.COMPOSE_PROJECT_NAME?.trim() ?? "";
  if (!/^devkh-ci(?:-[a-z0-9]+)*$/.test(project)) {
    throw new Error("Container verification requires a CI-only Compose project named devkh-ci or devkh-ci-<suffix>");
  }
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Source blob contract ${label} must be an object`);
  }
  return value;
}

function requireExactFields(value, expected, label) {
  const actual = Object.keys(requireRecord(value, label)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Source blob contract ${label} fields are invalid`);
  }
}

function parseUtc(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`Source blob contract ${label} must be a UTC ISO timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Source blob contract ${label} is invalid`);
  }
  return date;
}

function rejectFutureTimestamp(date, now, label) {
  if (date.getTime() > now.getTime()) {
    throw new Error(`Source blob contract ${label} is from the future`);
  }
  return date;
}

function parseGithubUtc(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(`Post-contract runtime CI ${label} is not a GitHub UTC timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Post-contract runtime CI ${label} is invalid`);
  return date;
}

async function readCanonicalJson(path, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    const bytes = await handle.readFile();
    const value = JSON.parse(bytes.toString("utf8"));
    if (bytes.toString("utf8") !== `${JSON.stringify(value)}\n`) {
      throw new Error("not canonical JSON");
    }
    return { value, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    throw new Error(`Source blob contract ${label} could not be read as canonical no-follow JSON`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateCommonEvidence(evidence, operation, candidateCommit, label) {
  requireRecord(evidence, label);
  if (evidence.schemaVersion !== 1 || evidence.operation !== operation || evidence.result !== "passed"
    || evidence.candidateCommit !== candidateCommit) {
    throw new Error(`Source blob contract ${label} does not prove the candidate`);
  }
}

export async function validateSourceBlobContractGateManifest(path, options = {}) {
  const sha256 = /^[a-f0-9]{64}$/;
  const commit = /^[a-f0-9]{40}$/;
  if (!sha256.test(options.expectedDigest ?? "")) {
    throw new Error("Source blob contract gate manifest digest is required");
  }
  if (!commit.test(options.expectedCandidateCommit ?? "")) {
    throw new Error("Source blob contract candidate commit is invalid");
  }
  if (typeof options.expectedApprover !== "string" || !options.expectedApprover.trim()) {
    throw new Error("Source blob contract expected approver is required");
  }
  const manifestFile = await readCanonicalJson(path, "gate manifest");
  if (manifestFile.digest !== options.expectedDigest) {
    throw new Error("Source blob contract gate manifest digest does not match");
  }
  const manifest = manifestFile.value;
  requireExactFields(
    manifest,
    ["schemaVersion", "kind", "candidateCommit", "createdAt", "references"],
    "gate manifest"
  );
  if (manifest.schemaVersion !== 1 || manifest.kind !== "devkh-source-blob-contract-gate") {
    throw new Error("Source blob contract gate manifest version or kind is invalid");
  }
  if (manifest.candidateCommit !== options.expectedCandidateCommit) {
    throw new Error("Source blob contract gate manifest candidate commit does not match");
  }
  const now = options.now ?? new Date();
  const createdAt = parseUtc(manifest.createdAt, "gate manifest createdAt");
  rejectFutureTimestamp(createdAt, now, "gate manifest createdAt");
  requireExactFields(
    manifest.references,
    ["preflight", "observation", "capacity", "historicReleases", "approval", "recovery"],
    "gate manifest references"
  );

  const evidence = {};
  const evidencePaths = {};
  for (const [name, reference] of Object.entries(manifest.references)) {
    requireExactFields(reference, ["file", "sha256"], `${name} reference`);
    if (typeof reference.file !== "string" || basename(reference.file) !== reference.file
      || reference.file.includes("\\") || !reference.file.endsWith(".json")
      || !sha256.test(reference.sha256 ?? "")) {
      throw new Error(`Source blob contract ${name} reference is invalid`);
    }
    const evidencePath = join(dirname(path), reference.file);
    const evidenceFile = await readCanonicalJson(evidencePath, `${name} evidence`);
    if (evidenceFile.digest !== reference.sha256) {
      throw new Error(`Source blob contract ${name} evidence digest does not match`);
    }
    evidence[name] = evidenceFile.value;
    evidencePaths[name] = evidencePath;
  }

  requireExactFields(evidence.preflight, [
    "schemaVersion", "operation", "candidateCommit", "result", "finishedAt", "unboundSourceFiles",
    "invalidSourceBlobReferences", "duplicateActiveGenerations", "verifiedSnapshotReferences"
  ], "preflight evidence");
  validateCommonEvidence(evidence.preflight, "source-blob-active-preflight", manifest.candidateCommit, "preflight evidence");
  for (const field of ["unboundSourceFiles", "invalidSourceBlobReferences", "duplicateActiveGenerations"]) {
    if (evidence.preflight[field] !== 0) throw new Error("Source blob contract preflight evidence reports failures");
  }
  if (!Number.isSafeInteger(evidence.preflight.verifiedSnapshotReferences)
    || evidence.preflight.verifiedSnapshotReferences < 1) {
    throw new Error("Source blob contract preflight evidence did not verify snapshot references");
  }
  const preflightFinished = rejectFutureTimestamp(
    parseUtc(evidence.preflight.finishedAt, "preflight finishedAt"),
    now,
    "preflight finishedAt"
  );

  requireExactFields(evidence.observation, [
    "schemaVersion", "operation", "candidateCommit", "result", "startedAt", "finishedAt", "incidentCount"
  ], "observation evidence");
  validateCommonEvidence(evidence.observation, "source-blob-dual-read-observation", manifest.candidateCommit, "observation evidence");
  const observationStarted = rejectFutureTimestamp(
    parseUtc(evidence.observation.startedAt, "observation startedAt"),
    now,
    "observation startedAt"
  );
  const observationFinished = rejectFutureTimestamp(
    parseUtc(evidence.observation.finishedAt, "observation finishedAt"),
    now,
    "observation finishedAt"
  );
  if (observationFinished.getTime() < observationStarted.getTime()) {
    throw new Error("Source blob contract observation finishedAt is before startedAt");
  }
  if (observationFinished.getTime() - observationStarted.getTime() < sourceBlobObservationMs) {
    throw new Error("Source blob contract observation evidence does not cover seven days");
  }
  if (evidence.observation.incidentCount !== 0) {
    throw new Error("Source blob contract observation evidence reports incidents");
  }

  requireExactFields(evidence.capacity, [
    "schemaVersion", "operation", "candidateCommit", "result", "measuredAt", "availableBytes", "requiredBytes"
  ], "capacity evidence");
  validateCommonEvidence(evidence.capacity, "source-blob-capacity", manifest.candidateCommit, "capacity evidence");
  const capacityMeasured = rejectFutureTimestamp(
    parseUtc(evidence.capacity.measuredAt, "capacity measuredAt"),
    now,
    "capacity measuredAt"
  );
  if (typeof evidence.capacity.availableBytes !== "string"
    || typeof evidence.capacity.requiredBytes !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(evidence.capacity.availableBytes)
    || !/^(?:0|[1-9][0-9]*)$/.test(evidence.capacity.requiredBytes)) {
    throw new Error("Source blob contract capacity evidence byte counts are invalid");
  }
  let availableBytes;
  let requiredBytes;
  try {
    availableBytes = BigInt(evidence.capacity.availableBytes);
    requiredBytes = BigInt(evidence.capacity.requiredBytes);
  } catch {
    throw new Error("Source blob contract capacity evidence byte counts are invalid");
  }
  if (availableBytes < 0n || requiredBytes < 1n || availableBytes < requiredBytes) {
    throw new Error("Source blob contract capacity evidence is insufficient");
  }

  requireExactFields(evidence.historicReleases, [
    "schemaVersion", "operation", "candidateCommit", "result", "verifiedAt", "retainedReleaseCount",
    "unresolvedDependencies"
  ], "historic release evidence");
  validateCommonEvidence(
    evidence.historicReleases,
    "source-blob-historic-release-dependencies",
    manifest.candidateCommit,
    "historic release evidence"
  );
  const historicReleasesVerified = rejectFutureTimestamp(
    parseUtc(evidence.historicReleases.verifiedAt, "historic release verifiedAt"),
    now,
    "historic release verifiedAt"
  );
  if (!Number.isSafeInteger(evidence.historicReleases.retainedReleaseCount)
    || evidence.historicReleases.retainedReleaseCount < 1
    || evidence.historicReleases.unresolvedDependencies !== 0) {
    throw new Error("Source blob contract historic release evidence is incomplete");
  }

  requireExactFields(evidence.approval, [
    "schemaVersion", "operation", "candidateCommit", "result", "approvedAt", "approver", "authorizationId"
  ], "approval evidence");
  if (evidence.approval.schemaVersion !== 1 || evidence.approval.operation !== "source-blob-contract-approval"
    || evidence.approval.result !== "approved" || evidence.approval.candidateCommit !== manifest.candidateCommit
    || evidence.approval.approver !== options.expectedApprover
    || typeof evidence.approval.authorizationId !== "string" || !evidence.approval.authorizationId.trim()) {
    throw new Error("Source blob contract approver evidence does not match");
  }
  const approvedAt = rejectFutureTimestamp(
    parseUtc(evidence.approval.approvedAt, "approval approvedAt"),
    now,
    "approval approvedAt"
  );
  if (approvedAt.getTime() > createdAt.getTime()) {
    throw new Error("Source blob contract approval approvedAt is after gate manifest createdAt");
  }

  const validateRecoveryEvidence = options.validateRecoveryEvidence ?? validateRecoveryEvidenceFile;
  const recovery = await validateRecoveryEvidence(evidencePaths.recovery);
  if (recovery?.schemaVersion !== 3 || recovery?.operation !== "restore-drill" || recovery?.result !== "success") {
    throw new Error("Source blob contract recovery evidence is invalid");
  }
  const recoveryFinished = parseUtc(recovery.finishedAt, "recovery finishedAt");
  const recoveryAge = now.getTime() - recoveryFinished.getTime();
  if (recoveryAge < 0 || recoveryAge > sourceBlobRecoveryEvidenceMaxAgeMs) {
    throw new Error("Source blob contract recovery evidence is expired");
  }
  for (const [label, date] of [
    ["preflight finishedAt", preflightFinished],
    ["observation finishedAt", observationFinished],
    ["capacity measuredAt", capacityMeasured],
    ["historic release verifiedAt", historicReleasesVerified],
    ["recovery finishedAt", recoveryFinished]
  ]) {
    if (date.getTime() > approvedAt.getTime()) {
      throw new Error(`Source blob contract ${label} is after approval approvedAt`);
    }
  }
  return {
    candidateCommit: manifest.candidateCommit,
    approver: evidence.approval.approver,
    recoveryEvidencePath: evidencePaths.recovery
  };
}

export async function assertSourceBlobContractReleaseGates(env, options = {}) {
  const contractMigrationPresent = options.contractMigrationPresent
    ?? existsSync(sourceBlobContractMigration);
  if (!contractMigrationPresent) return null;
  const checkedOutCommit = options.checkedOutCommit ?? execFileSync(
    "git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }
  ).trim();
  const approvedBase = env.DEVKH_RELEASE_APPROVED_BASE?.trim();
  if (approvedBase) {
    if (!/^[a-f0-9]{40}$/.test(approvedBase)) {
      throw new Error("Source blob contract approved base commit is invalid");
    }
    try {
      const approvedBlob = gitOutput([
        "rev-parse", `${approvedBase}:drizzle/0035_source_blobs_contract.sql`
      ]);
      const candidateBlob = gitOutput([
        "rev-parse", `${checkedOutCommit}:drizzle/0035_source_blobs_contract.sql`
      ]);
      if (approvedBlob === candidateBlob) return { authorizedByApprovedBase: approvedBase };
    } catch {
      // A missing or changed contract is an introducing candidate and must prove every gate.
    }
  }
  const manifestPath = env.DEVKH_SOURCE_BLOB_CONTRACT_GATE_MANIFEST?.trim();
  const expectedDigest = env.DEVKH_SOURCE_BLOB_CONTRACT_GATE_MANIFEST_SHA256?.trim();
  const expectedCandidateCommit = env.DEVKH_SOURCE_BLOB_CONTRACT_CANDIDATE_COMMIT?.trim();
  const expectedApprover = env.DEVKH_SOURCE_BLOB_CONTRACT_EXPECTED_APPROVER?.trim();
  if (!manifestPath || !expectedDigest || !expectedCandidateCommit || !expectedApprover) {
    throw new Error("Source blob contract release requires a gate manifest, digest, candidate commit, and approver");
  }
  if (expectedCandidateCommit !== checkedOutCommit) {
    throw new Error("Source blob contract candidate commit does not match the checked-out commit");
  }
  return validateSourceBlobContractGateManifest(resolve(repositoryRoot, manifestPath), {
    expectedDigest,
    expectedCandidateCommit: checkedOutCommit,
    expectedApprover,
    now: options.now
  });
}

async function readGithubEvent(path) {
  if (!path) throw new Error("Post-contract runtime CI requires the GitHub event payload");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    return JSON.parse((await handle.readFile()).toString("utf8"));
  } catch (error) {
    throw new Error("Post-contract runtime CI could not read the GitHub event payload", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function gitOutput(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function gitFile(commit, path) {
  return execFileSync("git", ["show", `${commit}:${path}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 4 * 1024 * 1024
  });
}

export function assertTrustedRuntimeMaterialIdentity(material) {
  if (material.trustedContractBlob !== material.candidateContractBlob) {
    throw new Error("Post-contract runtime CI checkout changed 0035 from the trusted base");
  }
  if (material.trustedBaselineBlob !== material.candidateBaselineBlob) {
    throw new Error("Post-contract runtime CI checkout changed the baseline from the trusted base");
  }
}

export function validatePhaseMergeApprovalProvenance(provenance, expected) {
  requireExactFields(provenance, [
    "schemaVersion", "kind", "repository", "approvedCommit", "approvedHead", "approvedBase",
    "contractBlob", "baselineBlob", "workflowBlob", "trustedBootstrapCommit", "trustedVerifierBlob",
    "trustedDatabaseVerifierBlob", "workflowRunId", "workflowRunAttempt", "issuedAt"
  ], "Phase Merge approval provenance");
  if (provenance.schemaVersion !== 1 || provenance.kind !== "devkh-phase-merge-approval") {
    throw new Error("Post-contract runtime CI Phase Merge approval provenance is invalid");
  }
  if (provenance.repository !== expected.repository || provenance.approvedCommit !== expected.approvedCommit) {
    throw new Error("Post-contract runtime CI Phase Merge approval does not bind the trusted predecessor");
  }
  for (const field of [
    "approvedCommit", "approvedHead", "approvedBase", "contractBlob", "baselineBlob", "workflowBlob",
    "trustedBootstrapCommit", "trustedVerifierBlob", "trustedDatabaseVerifierBlob"
  ]) {
    if (!/^[a-f0-9]{40}$/.test(provenance[field] ?? "")) {
      throw new Error(`Post-contract runtime CI Phase Merge approval ${field} is invalid`);
    }
  }
  for (const field of ["trustedBootstrapCommit", "trustedVerifierBlob", "trustedDatabaseVerifierBlob"]) {
    if (expected[field] && provenance[field] !== expected[field]) {
      throw new Error(`Post-contract runtime CI Phase Merge approval ${field} does not match the trusted bootstrap`);
    }
  }
  if (!Number.isSafeInteger(provenance.workflowRunId) || provenance.workflowRunId <= 0
    || !Number.isSafeInteger(provenance.workflowRunAttempt) || provenance.workflowRunAttempt <= 0) {
    throw new Error("Post-contract runtime CI Phase Merge approval workflow identity is invalid");
  }
  parseUtc(provenance.issuedAt, "Phase Merge approval issuedAt");
  return provenance;
}

async function readSingleApprovalFromZip(bytes) {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return rejectZip(new Error("Phase Merge approval artifact is not a valid ZIP", { cause: openError }));
      let found = false;
      let settled = false;
      let approvalBytes;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        rejectZip(error);
      };
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        if (entry.fileName !== "phase-merge-approval.json" || found || entry.uncompressedSize > 16 * 1024) {
          fail(new Error("Phase Merge approval artifact contents are invalid"));
          return;
        }
        found = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(new Error("Phase Merge approval artifact could not be read", { cause: streamError }));
          const chunks = [];
          let size = 0;
          stream.on("data", (chunk) => {
            size += chunk.length;
            if (size > 16 * 1024) stream.destroy(new Error("Phase Merge approval artifact is too large"));
            else chunks.push(chunk);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            approvalBytes = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => {
        if (settled) return;
        if (!found) return fail(new Error("Phase Merge approval artifact is missing its approval document"));
        settled = true;
        zip.close();
        resolveZip(approvalBytes);
      });
      zip.readEntry();
    });
  });
}

async function githubRequest(url, token, options = {}) {
  const binary = options.binary === true;
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      Accept: binary ? "application/octet-stream" : "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`GitHub approval provenance request failed with ${response.status}`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

export async function loadPhaseMergeApprovalProvenance(approvedCommit, options) {
  const { repository, token } = options;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !token) {
    throw new Error("Post-contract runtime CI requires a GitHub repository identity and token");
  }
  const api = `https://api.github.com/repos/${repository}`;
  const artifactName = `phase-merge-approval-${approvedCommit}`;
  const listing = await githubRequest(`${api}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`, token);
  const artifacts = listing?.artifacts?.filter((artifact) => artifact.name === artifactName && artifact.expired === false) ?? [];
  if (artifacts.length !== 1) {
    throw new Error("Post-contract runtime CI requires exactly one unexpired Phase Merge approval artifact");
  }
  const [artifact] = artifacts;
  if (!Number.isSafeInteger(artifact.id) || !Number.isSafeInteger(artifact.workflow_run?.id)
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")) {
    throw new Error("Post-contract runtime CI Phase Merge approval artifact metadata is invalid");
  }
  const [run, workflow, archive] = await Promise.all([
    githubRequest(`${api}/actions/runs/${artifact.workflow_run.id}`, token),
    githubRequest(`${api}/actions/runs/${artifact.workflow_run.id}`, token).then((value) =>
      githubRequest(`${api}/actions/workflows/${value.workflow_id}`, token)),
    githubRequest(`${api}/actions/artifacts/${artifact.id}/zip`, token, { binary: true })
  ]);
  const owner = repository.split("/")[0];
  if (run.id !== artifact.workflow_run.id || run.event !== "workflow_dispatch" || run.status !== "completed"
    || run.conclusion !== "success" || run.run_attempt < 1 || run.actor?.login !== owner
    || run.repository?.full_name !== repository || workflow.id !== run.workflow_id
    || workflow.path !== ".github/workflows/phase-merge.yml") {
    throw new Error("Post-contract runtime CI approval was not issued by the trusted Phase Merge workflow identity");
  }
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  if (digest !== artifact.digest) {
    throw new Error("Post-contract runtime CI Phase Merge approval artifact digest does not match GitHub metadata");
  }
  const approvalBytes = await readSingleApprovalFromZip(archive);
  const text = approvalBytes.toString("utf8");
  let provenance;
  try {
    provenance = JSON.parse(text);
  } catch (error) {
    throw new Error("Post-contract runtime CI Phase Merge approval is not JSON", { cause: error });
  }
  if (text !== `${JSON.stringify(provenance)}\n`) {
    throw new Error("Post-contract runtime CI Phase Merge approval is not canonical JSON");
  }
  validatePhaseMergeApprovalProvenance(provenance, {
    repository,
    approvedCommit,
    trustedBootstrapCommit: options.trustedBootstrapCommit,
    trustedVerifierBlob: options.trustedVerifierBlob,
    trustedDatabaseVerifierBlob: options.trustedDatabaseVerifierBlob
  });
  if (provenance.workflowRunId !== run.id || provenance.workflowRunAttempt !== run.run_attempt) {
    throw new Error("Post-contract runtime CI Phase Merge approval workflow run does not match its artifact");
  }
  if (run.head_sha !== provenance.approvedBase || run.head_branch !== "main") {
    throw new Error("Post-contract runtime CI Phase Merge approval is not bound to its trusted default-branch workflow revision");
  }
  const issuedAt = parseUtc(provenance.issuedAt, "Phase Merge approval issuedAt");
  const runCreatedAt = parseGithubUtc(run.created_at, "Phase Merge run createdAt");
  const artifactCreatedAt = parseGithubUtc(artifact.created_at, "Phase Merge artifact createdAt");
  if (issuedAt < runCreatedAt || issuedAt > artifactCreatedAt || artifactCreatedAt > new Date()) {
    throw new Error("Post-contract runtime CI Phase Merge approval timestamps are incoherent");
  }
  return provenance;
}

export function assertTrustedVerifierBootstrap(env, options = {}) {
  const trustedBootstrapCommit = env.DEVKH_FK17_TRUSTED_BOOTSTRAP_COMMIT?.trim();
  const currentWorkflowCommit = env.DEVKH_FK17_CURRENT_WORKFLOW_SHA?.trim();
  const currentWorkflowPath = env.DEVKH_FK17_CURRENT_WORKFLOW_PATH?.trim();
  if (!/^[a-f0-9]{40}$/.test(trustedBootstrapCommit ?? "")
    || !/^[a-f0-9]{40}$/.test(currentWorkflowCommit ?? "")
    || !/^\.github\/workflows\/(?:ci|phase-merge)\.yml$/.test(currentWorkflowPath ?? "")) {
    throw new Error("FK17 gate requires an exact trusted bootstrap commit and active workflow identity");
  }
  const output = options.gitOutput ?? gitOutput;
  let trustedVerifierBlob;
  let trustedDatabaseVerifierBlob;
  let trustedWorkflowBlob;
  let currentWorkflowBlob;
  let executingVerifierBlob;
  let executingDatabaseVerifierBlob;
  try {
    output(["merge-base", "--is-ancestor", trustedBootstrapCommit, "HEAD"]);
    trustedVerifierBlob = output(["rev-parse", `${trustedBootstrapCommit}:scripts/release-verify.mjs`]);
    trustedDatabaseVerifierBlob = output(["rev-parse", `${trustedBootstrapCommit}:scripts/verify-post-contract-database.mjs`]);
    trustedWorkflowBlob = output(["rev-parse", `${trustedBootstrapCommit}:${currentWorkflowPath}`]);
    currentWorkflowBlob = output(["rev-parse", `${currentWorkflowCommit}:${currentWorkflowPath}`]);
    executingVerifierBlob = output(["hash-object", resolve(verifierRepositoryRoot, "scripts/release-verify.mjs")]);
    executingDatabaseVerifierBlob = output(["hash-object", resolve(verifierRepositoryRoot, "scripts/verify-post-contract-database.mjs")]);
  } catch (error) {
    throw new Error("FK17 gate could not resolve trusted bootstrap material", { cause: error });
  }
  if (executingVerifierBlob !== trustedVerifierBlob
    || executingDatabaseVerifierBlob !== trustedDatabaseVerifierBlob) {
    throw new Error("FK17 gate is not executing the trusted bootstrap verifier blobs");
  }
  if (currentWorkflowBlob !== trustedWorkflowBlob) {
    throw new Error("FK17 gate active workflow differs from the trusted bootstrap workflow blob");
  }
  const phaseMergeWorkflowBlob = output([
    "rev-parse", `${trustedBootstrapCommit}:.github/workflows/phase-merge.yml`
  ]);
  const trustedCiWorkflowBlob = output([
    "rev-parse", `${trustedBootstrapCommit}:.github/workflows/ci.yml`
  ]);
  let candidateCiWorkflowBlob;
  let candidatePhaseMergeWorkflowBlob;
  let candidateVerifierBlob;
  let candidateDatabaseVerifierBlob;
  try {
    candidateCiWorkflowBlob = output(["rev-parse", "HEAD:.github/workflows/ci.yml"]);
    candidatePhaseMergeWorkflowBlob = output(["rev-parse", "HEAD:.github/workflows/phase-merge.yml"]);
    candidateVerifierBlob = output(["rev-parse", "HEAD:scripts/release-verify.mjs"]);
    candidateDatabaseVerifierBlob = output(["rev-parse", "HEAD:scripts/verify-post-contract-database.mjs"]);
  } catch (error) {
    throw new Error("FK17 candidate is missing a trusted gate workflow", { cause: error });
  }
  if (candidateCiWorkflowBlob !== trustedCiWorkflowBlob
    || candidatePhaseMergeWorkflowBlob !== phaseMergeWorkflowBlob) {
    throw new Error("FK17 candidate gate workflow differs from the trusted bootstrap");
  }
  if (candidateVerifierBlob !== trustedVerifierBlob
    || candidateDatabaseVerifierBlob !== trustedDatabaseVerifierBlob) {
    throw new Error("FK17 candidate verifier differs from the trusted bootstrap verifier blobs");
  }
  return {
    trustedBootstrapCommit,
    trustedVerifierBlob,
    trustedDatabaseVerifierBlob,
    phaseMergeWorkflowBlob
  };
}

export async function stageTrustedBaseline(sql, root = tmpdir()) {
  const directory = await mkdtemp(join(root, "devkh-post-contract-baseline-"));
  const sourcePath = join(directory, "trusted-source.sql");
  const stagedDirectory = join(directory, "postgres-init");
  const baselinePath = join(stagedDirectory, "20-post-contract-baseline.sql");
  await mkdir(stagedDirectory, { mode: 0o700 });
  await writeFile(sourcePath, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    execFileSync("docker", [
      "run", "--rm", "--user", "0",
      "-v", `${sourcePath}:/source/trusted.sql:ro`,
      "-v", `${stagedDirectory}:/target`,
      "postgres:16-bookworm", "sh", "-ceu",
      "install -o postgres -g postgres -m 0400 /source/trusted.sql /target/20-post-contract-baseline.sql"
    ], { cwd: repositoryRoot, stdio: "ignore" });
    await rm(sourcePath, { force: true });
    return { baselineDirectory: directory, baselinePath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Post-contract runtime CI could not stage the trusted baseline for the PostgreSQL UID", { cause: error });
  }
}

export async function assertPostContractRuntimeCi(env, options = {}) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_WORKFLOW !== "ci") {
    throw new Error("Post-contract runtime verification is restricted to the ordinary GitHub CI workflow");
  }
  const eventName = env.GITHUB_EVENT_NAME;
  if (eventName !== "pull_request" && eventName !== "push") {
    throw new Error("Post-contract runtime verification requires a pull_request or main push event");
  }
  const checkedOutCommit = options.checkedOutCommit ?? gitOutput(["rev-parse", "HEAD"]);
  const event = options.event ?? await readGithubEvent(env.GITHUB_EVENT_PATH);
  if (event?.repository?.full_name !== env.GITHUB_REPOSITORY) {
    throw new Error("Post-contract runtime CI repository identity does not match the GitHub event");
  }

  let trustedContractCommit;
  if (eventName === "pull_request") {
    if (event?.pull_request?.base?.repo?.full_name !== env.GITHUB_REPOSITORY) {
      throw new Error("Post-contract runtime CI pull request base repository is not trusted");
    }
    trustedContractCommit = event?.pull_request?.base?.sha;
    if (!/^[a-f0-9]{40}$/.test(trustedContractCommit ?? "")) {
      throw new Error("Post-contract runtime CI trusted pull request base is invalid");
    }
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", trustedContractCommit, checkedOutCommit], {
        cwd: repositoryRoot,
        stdio: "ignore"
      });
    } catch {
      throw new Error("Post-contract runtime CI trusted pull request base is not an ancestor of the checkout");
    }
  } else {
    if (event?.after !== checkedOutCommit) {
      throw new Error("Post-contract runtime CI push does not match the checkout");
    }
    if ((event?.ref === "refs/heads/main" || event?.ref === "refs/heads/codex/mvp")
      && /^[a-f0-9]{40}$/.test(event?.before ?? "")) {
      trustedContractCommit = event.before;
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", trustedContractCommit, checkedOutCommit], {
          cwd: repositoryRoot,
          stdio: "ignore"
        });
      } catch {
        throw new Error("Post-contract runtime CI trusted push base is not an ancestor of the checkout");
      }
    } else {
      throw new Error("Post-contract runtime CI push is not on an allowed CI branch");
    }
  }

  if (trustedContractCommit === checkedOutCommit) {
    throw new Error("Post-contract runtime CI requires a distinct trusted predecessor");
  }

  let trustedContractBlob;
  let checkedOutContractBlob;
  let trustedBaselineBlob;
  let checkedOutBaselineBlob;
  let trustedBaseline;
  let expectedMigrations;
  try {
    trustedContractBlob = gitOutput([
      "rev-parse", `${trustedContractCommit}:drizzle/0035_source_blobs_contract.sql`
    ]);
    checkedOutContractBlob = gitOutput([
      "rev-parse", `${checkedOutCommit}:drizzle/0035_source_blobs_contract.sql`
    ]);
    trustedBaselineBlob = gitOutput([
      "rev-parse", `${trustedContractCommit}:docker/post-contract-ci-baseline.sql`
    ]);
    checkedOutBaselineBlob = gitOutput([
      "rev-parse", `${checkedOutCommit}:docker/post-contract-ci-baseline.sql`
    ]);
    trustedBaseline = gitFile(trustedContractCommit, "docker/post-contract-ci-baseline.sql");
    expectedMigrations = gitOutput([
      "ls-tree", "-r", "--name-only", trustedContractCommit, "--", "drizzle"
    ]).split("\n").map((name) => basename(name)).filter((name) =>
      name.endsWith(".sql") && name <= "0035_source_blobs_contract.sql"
    ).sort();
  } catch {
    throw new Error("Post-contract runtime CI trusted base does not contain 0035 and its baseline");
  }
  assertTrustedRuntimeMaterialIdentity({
    trustedContractBlob,
    candidateContractBlob: checkedOutContractBlob,
    trustedBaselineBlob,
    candidateBaselineBlob: checkedOutBaselineBlob
  });
  const trustedBootstrap = options.trustedBootstrapMaterial
    ?? (env.DEVKH_FK17_TRUSTED_BOOTSTRAP_COMMIT ? assertTrustedVerifierBootstrap(env) : undefined);
  const loadApproval = options.loadApprovalProvenance ?? loadPhaseMergeApprovalProvenance;
  const approval = await loadApproval(trustedContractCommit, {
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    trustedBootstrapCommit: trustedBootstrap?.trustedBootstrapCommit,
    trustedVerifierBlob: trustedBootstrap?.trustedVerifierBlob,
    trustedDatabaseVerifierBlob: trustedBootstrap?.trustedDatabaseVerifierBlob
  });
  validatePhaseMergeApprovalProvenance(approval, {
    repository: env.GITHUB_REPOSITORY,
    approvedCommit: trustedContractCommit,
    trustedBootstrapCommit: trustedBootstrap?.trustedBootstrapCommit,
    trustedVerifierBlob: trustedBootstrap?.trustedVerifierBlob,
    trustedDatabaseVerifierBlob: trustedBootstrap?.trustedDatabaseVerifierBlob
  });
  if (approval.contractBlob !== trustedContractBlob || approval.baselineBlob !== trustedBaselineBlob) {
    throw new Error("Post-contract runtime CI trusted material does not match Phase Merge approval provenance");
  }
  let approvedWorkflowBlob;
  try {
    approvedWorkflowBlob = gitOutput([
      "rev-parse", `${approval.trustedBootstrapCommit}:.github/workflows/phase-merge.yml`
    ]);
    execFileSync("git", ["merge-base", "--is-ancestor", approval.approvedBase, trustedContractCommit], {
      cwd: repositoryRoot,
      stdio: "ignore"
    });
  } catch {
    throw new Error("Post-contract runtime CI Phase Merge approval base is not trusted commit ancestry");
  }
  if (approval.workflowBlob !== approvedWorkflowBlob) {
    throw new Error("Post-contract runtime CI Phase Merge approval workflow blob does not match its trusted bootstrap");
  }
  validatePostContractBaselineGrammar(trustedBaseline, expectedMigrations);
  let materialized = {};
  if (options.materializeBaseline !== false) {
    materialized = await stageTrustedBaseline(trustedBaseline, env.RUNNER_TEMP || tmpdir());
  }
  return { eventName, trustedContractCommit, expectedMigrations, ...materialized };
}

function executeCommand(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { cwd: repositoryRoot, env: process.env, stdio: "inherit" });
    child.once("error", (error) => {
      error.exitCode = error.code === "ENOENT" ? 127 : 1;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(
        new Error(signal ? `terminated by ${signal}` : `exited with ${code ?? 1}`),
        { exitCode: code ?? 1 }
      ));
    });
  });
}

async function executeHealthCheck(step) {
  const port = process.env.DEVKH_PORT?.trim() || "3000";
  const url = new URL(step.healthUrl);
  url.port = port;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        process.stdout.write(`${await response.text()}\n`);
        return;
      }
    } catch {
      // The service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await executeCommand({
    name: "compose-logs",
    command: "docker",
    args: [...compose, "logs", "app"]
  }).catch(() => undefined);
  throw Object.assign(new Error("application health probe timed out"), { exitCode: 1 });
}

async function executeStep(step) {
  if (step.healthUrl) return executeHealthCheck(step);
  return executeCommand(step);
}

export async function runReleaseSteps(steps, options = {}) {
  const execute = options.execute ?? executeStep;
  const logger = options.logger ?? console;
  for (const step of steps) {
    logger.log(`[release] START ${step.name}: ${commandText(step)}`);
    try {
      await execute(step);
    } catch (error) {
      const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
      throw Object.assign(
        new Error(`${step.name} failed with exit code ${exitCode}: ${commandText(step)}`),
        { cause: error, exitCode, stepName: step.name }
      );
    }
    logger.log(`[release] PASS ${step.name}`);
  }
}

export async function runContainerVerification(options = {}) {
  const env = options.env ?? process.env;
  const execute = options.execute ?? executeStep;
  const logger = options.logger ?? console;
  const invalidateEvidence = options.invalidateEvidence ?? invalidateRecoveryEvidence;
  const finalizeEvidence = options.finalizeEvidence ?? finalizeRecoveryEvidence;
  const steps = options.steps ?? CONTAINER_STEPS;

  assertContainerIsolation(env);
  let failure;
  try {
    await runReleaseSteps(steps, { execute, logger });
  } catch (error) {
    failure = error;
  }

  if (failure) {
    logger.error("[release] container verification failed; retaining the isolated Compose state for diagnosis");
    const errorClass = failure.stepName === "recovery-drill"
      ? "recovery_drill_failed"
      : "container_verification_failed";
    await invalidateEvidence(env.RECOVERY_EVIDENCE_DIR, errorClass);
    throw failure;
  }

  try {
    await runReleaseSteps([cleanupStep], { execute, logger });
  } catch (cleanupError) {
    await invalidateEvidence(env.RECOVERY_EVIDENCE_DIR, "compose_cleanup_failed");
    failure = cleanupError;
  }
  if (failure) throw failure;
  if (env.RECOVERY_EVIDENCE_DEFER_FINALIZATION === "true") {
    try {
      await finalizeEvidence(env.RECOVERY_EVIDENCE_DIR);
    } catch (error) {
      await invalidateEvidence(env.RECOVERY_EVIDENCE_DIR, "recovery_evidence_finalization_failed");
      throw error;
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const scope = parseReleaseScope(args);
  const trustedBootstrap = (process.env.GITHUB_ACTIONS === "true"
    || scope === "container" || scope === "runtime-container" || scope === "all")
    ? assertTrustedVerifierBootstrap(process.env)
    : undefined;
  if (scope === "verify" || scope === "all") await runReleaseSteps(VERIFY_STEPS);
  if (scope === "runtime-container") {
    const runtime = await assertPostContractRuntimeCi(process.env, { trustedBootstrapMaterial: trustedBootstrap });
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.DEVKH_POST_CONTRACT_BASELINE_PATH = runtime.baselinePath;
    process.env.DEVKH_POST_CONTRACT_EXPECTED_MIGRATIONS = JSON.stringify(runtime.expectedMigrations);
    try {
      await runContainerVerification({ steps: POST_CONTRACT_CONTAINER_STEPS });
    } finally {
      delete process.env.DEVKH_POST_CONTRACT_BASELINE_PATH;
      delete process.env.DEVKH_POST_CONTRACT_EXPECTED_MIGRATIONS;
      await rm(runtime.baselineDirectory, { recursive: true, force: true });
    }
  }
  if (scope === "container" || scope === "all") {
    const gates = await assertSourceBlobContractReleaseGates(process.env);
    await runContainerVerification({ steps: gates ? CONTAINER_STEPS : STANDARD_CONTAINER_STEPS });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
