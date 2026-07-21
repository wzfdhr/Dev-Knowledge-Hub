import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateRecoveryEvidenceFile } from "./backup/validate-recovery-evidence.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compose = ["compose", "-f", resolve(repositoryRoot, "docker-compose.yml")];
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
  { name: "parser-isolation", command: "node", args: [resolve(repositoryRoot, "scripts/security/verify-parser-container.mjs")] },
  {
    name: "application-health",
    command: "docker",
    args: [...compose, "exec", "-T", "app", "node", "-e",
      "fetch('http://127.0.0.1:3000/api/health').then(async(response)=>{console.log(await response.text());process.exit(response.ok?0:1)}).catch(()=>process.exit(1))"]
  },
  { name: "recovery-drill", command: "bash", args: [resolve(repositoryRoot, "scripts/backup/ci-recovery-drill.sh")] }
]);

export const STANDARD_CONTAINER_STEPS = Object.freeze([
  { name: "container-build", command: "docker", args: ["build", "--target", "runtime", "-t", "devkh:ci", repositoryRoot] },
  { name: "compose-config", command: "docker", args: [...compose, "config", "--quiet"] },
  { name: "compose-up", command: "docker", args: [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "120", "postgres", "parser", "app"] },
  { name: "parser-isolation", command: "node", args: [resolve(repositoryRoot, "scripts/security/verify-parser-container.mjs")] },
  {
    name: "application-health",
    command: "docker",
    args: [...compose, "exec", "-T", "app", "node", "-e",
      "fetch('http://127.0.0.1:3000/api/health').then(async(response)=>{console.log(await response.text());process.exit(response.ok?0:1)}).catch(()=>process.exit(1))"]
  },
  { name: "recovery-drill", command: "bash", args: [resolve(repositoryRoot, "scripts/backup/ci-recovery-drill.sh")] }
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
  if (value === "verify" || value === "container" || value === "all") return value;
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
  if (createdAt > now) throw new Error("Source blob contract gate manifest is from the future");
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
  parseUtc(evidence.preflight.finishedAt, "preflight finishedAt");

  requireExactFields(evidence.observation, [
    "schemaVersion", "operation", "candidateCommit", "result", "startedAt", "finishedAt", "incidentCount"
  ], "observation evidence");
  validateCommonEvidence(evidence.observation, "source-blob-dual-read-observation", manifest.candidateCommit, "observation evidence");
  const observationStarted = parseUtc(evidence.observation.startedAt, "observation startedAt");
  const observationFinished = parseUtc(evidence.observation.finishedAt, "observation finishedAt");
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
  parseUtc(evidence.capacity.measuredAt, "capacity measuredAt");
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
  parseUtc(evidence.historicReleases.verifiedAt, "historic release verifiedAt");
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
  parseUtc(evidence.approval.approvedAt, "approval approvedAt");

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
  const approvedBase = env.DEVKH_RELEASE_APPROVED_BASE?.trim();
  if (approvedBase) {
    if (!/^[a-f0-9]{40}$/.test(approvedBase)) {
      throw new Error("Source blob contract approved base commit is invalid");
    }
    try {
      execFileSync("git", ["cat-file", "-e", `${approvedBase}:drizzle/0035_source_blobs_contract.sql`], {
        cwd: repositoryRoot,
        stdio: "ignore"
      });
      return { authorizedByApprovedBase: approvedBase };
    } catch {
      // The approved base does not contain the contract; this candidate must prove every gate.
    }
  }
  const manifestPath = env.DEVKH_SOURCE_BLOB_CONTRACT_GATE_MANIFEST?.trim();
  const expectedDigest = env.DEVKH_SOURCE_BLOB_CONTRACT_GATE_MANIFEST_SHA256?.trim();
  const expectedCandidateCommit = env.DEVKH_SOURCE_BLOB_CONTRACT_CANDIDATE_COMMIT?.trim();
  const expectedApprover = env.DEVKH_SOURCE_BLOB_CONTRACT_EXPECTED_APPROVER?.trim();
  if (!manifestPath || !expectedDigest || !expectedCandidateCommit || !expectedApprover) {
    throw new Error("Source blob contract release requires a gate manifest, digest, candidate commit, and approver");
  }
  const checkedOutCommit = options.checkedOutCommit ?? execFileSync(
    "git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }
  ).trim();
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
  if (scope === "verify" || scope === "all") await runReleaseSteps(VERIFY_STEPS);
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
