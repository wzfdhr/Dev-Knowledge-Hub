import { describe, expect, test, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTAINER_STEPS,
  POST_CONTRACT_CONTAINER_STEPS,
  STANDARD_CONTAINER_STEPS,
  VERIFY_STEPS,
  assertContainerIsolation,
  assertPostContractRuntimeCi,
  assertSourceBlobContractReleaseGates,
  assertTrustedVerifierBootstrap,
  assertTrustedRuntimeMaterialIdentity,
  finalizeRecoveryEvidence,
  loadPhaseMergeApprovalProvenance,
  parseReleaseScope,
  requiresTrustedVerifierBootstrap,
  runContainerVerification,
  runReleaseSteps,
  validatePhaseMergeApprovalProvenance,
  validateSourceBlobContractGateManifest
} from "./release-verify.mjs";
import { validatePostContractBaselineGrammar } from "./verify-post-contract-database.mjs";

const testWithSourceBlobContract = existsSync("drizzle/0035_source_blobs_contract.sql") ? test : test.skip;

test("requires the trusted verifier only after the bootstrap commit is configured", () => {
  expect(requiresTrustedVerifierBootstrap({ GITHUB_ACTIONS: "true" })).toBe(false);
  expect(requiresTrustedVerifierBootstrap({
    DEVKH_FK17_TRUSTED_BOOTSTRAP_COMMIT: "a".repeat(40)
  })).toBe(true);
});

function createPendingEvidence(root) {
  const document = readFileSync(join(process.cwd(), "docs/operations/recovery-evidence.md"), "utf8");
  const evidence = document.match(/```json\n([\s\S]*?)\n```/)?.[1];
  const sidecar = document.match(/```ndjson\n([\s\S]*?)\n```/)?.[1];
  if (!evidence || !sidecar) throw new Error("documented evidence fixture is incomplete");
  const directory = join(root, "run-1", "recovery-evidence");
  mkdirSync(directory, { recursive: true });
  const jsonPending = join(directory, "evidence.json.pending");
  const sidecarPending = join(directory, "evidence.source-blobs.ndjson.pending");
  writeFileSync(jsonPending, `${evidence}\n`, { mode: 0o600 });
  writeFileSync(sidecarPending, `${sidecar}\n`, { mode: 0o600 });
  return {
    jsonPending,
    jsonFinal: jsonPending.slice(0, -".pending".length),
    sidecarPending,
    sidecarFinal: sidecarPending.slice(0, -".pending".length)
  };
}

function writeCanonicalJson(root, name, value) {
  const bytes = `${JSON.stringify(value)}\n`;
  const file = join(root, name);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file: name, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function createContractGateFixture(root, overrides = {}) {
  const candidateCommit = overrides.candidateCommit ?? "a".repeat(40);
  const approver = overrides.approver ?? "release-owner";
  const common = { schemaVersion: 1, candidateCommit, result: "passed" };
  const references = {
    preflight: writeCanonicalJson(root, "preflight.json", {
      ...common,
      operation: "source-blob-active-preflight",
      finishedAt: overrides.preflightFinishedAt ?? "2026-07-08T00:00:00.000Z",
      unboundSourceFiles: overrides.unboundSourceFiles ?? 0,
      invalidSourceBlobReferences: 0,
      duplicateActiveGenerations: 0,
      verifiedSnapshotReferences: 2
    }),
    observation: writeCanonicalJson(root, "observation.json", {
      ...common,
      operation: "source-blob-dual-read-observation",
      startedAt: overrides.observationStartedAt ?? "2026-07-01T00:00:00.000Z",
      finishedAt: overrides.observationFinishedAt ?? "2026-07-08T00:00:00.000Z",
      incidentCount: 0
    }),
    capacity: writeCanonicalJson(root, "capacity.json", {
      ...common,
      operation: "source-blob-capacity",
      measuredAt: overrides.capacityMeasuredAt ?? "2026-07-08T00:00:00.000Z",
      availableBytes: overrides.availableBytes ?? "2000000",
      requiredBytes: "1000000"
    }),
    historicReleases: writeCanonicalJson(root, "historic-releases.json", {
      ...common,
      operation: "source-blob-historic-release-dependencies",
      verifiedAt: overrides.historicVerifiedAt ?? "2026-07-08T00:00:00.000Z",
      retainedReleaseCount: 3,
      unresolvedDependencies: overrides.unresolvedDependencies ?? 0
    }),
    approval: writeCanonicalJson(root, "approval.json", {
      schemaVersion: 1,
      operation: "source-blob-contract-approval",
      candidateCommit,
      result: "approved",
      approvedAt: overrides.approvedAt ?? "2026-07-08T00:00:00.000Z",
      approver,
      authorizationId: "fk17-review-1"
    }),
    recovery: writeCanonicalJson(root, "recovery.json", {
      schemaVersion: 3,
      operation: "restore-drill",
      result: "success",
      finishedAt: overrides.recoveryFinishedAt ?? "2026-07-08T00:00:00.000Z"
    })
  };
  const manifest = {
    schemaVersion: 1,
    kind: "devkh-source-blob-contract-gate",
    candidateCommit,
    createdAt: overrides.manifestCreatedAt ?? "2026-07-08T00:00:00.000Z",
    references
  };
  const manifestReference = writeCanonicalJson(root, "gate-manifest.json", manifest);
  return {
    candidateCommit,
    approver,
    manifestPath: join(root, manifestReference.file),
    manifestDigest: manifestReference.sha256
  };
}

function createSyntheticDescendant(parent) {
  const tree = spawnSync("git", ["rev-parse", `${parent}^{tree}`], { encoding: "utf8" }).stdout.trim();
  const result = spawnSync("git", ["commit-tree", tree, "-p", parent], {
    encoding: "utf8",
    input: "post-contract runtime fixture\n",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "DevKH Test",
      GIT_AUTHOR_EMAIL: "devkh-test@example.invalid",
      GIT_AUTHOR_DATE: "2026-07-21T00:00:00Z",
      GIT_COMMITTER_NAME: "DevKH Test",
      GIT_COMMITTER_EMAIL: "devkh-test@example.invalid",
      GIT_COMMITTER_DATE: "2026-07-21T00:00:00Z"
    }
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function createSyntheticTrustedBaselineCommit(parent) {
  const root = mkdtempSync(join(tmpdir(), "devkh-trusted-baseline-tree-"));
  const index = join(root, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync("git", ["read-tree", parent], { env });
    const baselineBlob = execFileSync("git", ["hash-object", "-w", "docker/post-contract-ci-baseline.sql"], {
      encoding: "utf8"
    }).trim();
    execFileSync("git", [
      "update-index", "--add", "--cacheinfo", `100644,${baselineBlob},docker/post-contract-ci-baseline.sql`
    ], { env });
    const tree = execFileSync("git", ["write-tree"], { env, encoding: "utf8" }).trim();
    const result = spawnSync("git", ["commit-tree", tree, "-p", parent], {
      encoding: "utf8",
      input: "trusted minimal post-contract baseline fixture\n",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "DevKH Test",
        GIT_AUTHOR_EMAIL: "devkh-test@example.invalid",
        GIT_AUTHOR_DATE: "2026-07-21T00:00:00Z",
        GIT_COMMITTER_NAME: "DevKH Test",
        GIT_COMMITTER_EMAIL: "devkh-test@example.invalid",
        GIT_COMMITTER_DATE: "2026-07-21T00:00:00Z"
      }
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createPhaseMergeApproval(approvedCommit, repository = "example/devkh") {
  const blob = (path) => spawnSync("git", ["rev-parse", `${approvedCommit}:${path}`], { encoding: "utf8" }).stdout.trim();
  const approvedBase = spawnSync("git", ["rev-parse", `${approvedCommit}^`], { encoding: "utf8" }).stdout.trim();
  return {
    schemaVersion: 1,
    kind: "devkh-phase-merge-approval",
    repository,
    approvedCommit,
    approvedHead: "a".repeat(40),
    approvedBase,
    contractBlob: blob("drizzle/0035_source_blobs_contract.sql"),
    baselineBlob: blob("docker/post-contract-ci-baseline.sql"),
    workflowBlob: blob(".github/workflows/phase-merge.yml"),
    trustedBootstrapCommit: approvedCommit,
    trustedVerifierBlob: blob("scripts/release-verify.mjs"),
    trustedDatabaseVerifierBlob: blob("scripts/verify-post-contract-database.mjs"),
    workflowRunId: 12345,
    workflowRunAttempt: 1,
    issuedAt: "2026-07-21T00:00:00.000Z"
  };
}

describe("release verification orchestrator", () => {
  test("keeps the release checks in the approved order", () => {
    expect(VERIFY_STEPS.map((step) => step.name)).toEqual([
      "secrets", "licenses", "runtime", "runtime-tests", "backup-tests", "delivery",
      "typecheck", "lint", "unit", "postgres-integration", "build", "acceptance", "knowledge-quality", "e2e"
    ]);
    expect(CONTAINER_STEPS.map((step) => step.name)).toEqual([
      "container-build", "compose-config", "compose-infrastructure", "source-blob-contract-migration",
      "compose-app", "parser-isolation", "application-health", "recovery-drill"
    ]);
    expect(CONTAINER_STEPS.find((step) => step.name === "compose-infrastructure")?.args).not.toContain("app");
    expect(CONTAINER_STEPS.find((step) => step.name === "source-blob-contract-migration")?.args)
      .toEqual(expect.arrayContaining(["--profile", "source-blob-contract", "run", "--rm", "contract-migrate"]));
    expect(CONTAINER_STEPS.findIndex((step) => step.name === "source-blob-contract-migration"))
      .toBeLessThan(CONTAINER_STEPS.findIndex((step) => step.name === "compose-app"));
    expect(STANDARD_CONTAINER_STEPS.map((step) => step.name)).toEqual([
      "container-build", "compose-config", "compose-up", "parser-isolation", "application-health", "recovery-drill"
    ]);
    expect(STANDARD_CONTAINER_STEPS.map((step) => step.name)).not.toContain("source-blob-contract-migration");
    expect(POST_CONTRACT_CONTAINER_STEPS.map((step) => step.name)).toEqual([
      "container-build", "post-contract-compose-config", "post-contract-compose-infrastructure",
      "post-contract-database-audit", "post-contract-compose-app", "parser-isolation", "application-health",
      "recovery-drill"
    ]);
    expect(POST_CONTRACT_CONTAINER_STEPS.map((step) => step.name))
      .not.toContain("source-blob-contract-migration");
    expect(POST_CONTRACT_CONTAINER_STEPS.find((step) => step.name === "post-contract-compose-infrastructure")?.args.join(" "))
      .toContain("docker-compose.post-contract-ci.yml");
    expect(POST_CONTRACT_CONTAINER_STEPS.findIndex((step) => step.name === "post-contract-database-audit"))
      .toBeLessThan(POST_CONTRACT_CONTAINER_STEPS.findIndex((step) => step.name === "post-contract-compose-app"));
    const repositoryRoot = process.cwd();
    const composeFile = join(repositoryRoot, "docker-compose.yml");
    expect(isAbsolute(repositoryRoot)).toBe(true);
    expect(CONTAINER_STEPS.find((step) => step.name === "container-build")?.args.at(-1))
      .toBe(repositoryRoot);
    expect(CONTAINER_STEPS.find((step) => step.name === "application-health")?.args.join(" "))
      .toContain(`compose -f ${composeFile} exec -T app node`);
    expect(CONTAINER_STEPS.find((step) => step.name === "recovery-drill")?.args)
      .toEqual([join(repositoryRoot, "scripts/backup/ci-recovery-drill.sh")]);
  });

  test("anchors container verification to this repository when invoked from another directory", async () => {
    const repositoryRoot = process.cwd();
    const foreignDirectory = mkdtempSync(join(tmpdir(), "devkh-release-verify-"));
    try {
      const scriptUrl = pathToFileURL(join(repositoryRoot, "scripts/release-verify.mjs")).href;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import { CONTAINER_STEPS } from ${JSON.stringify(scriptUrl)};
        process.stdout.write(JSON.stringify(CONTAINER_STEPS));
      `], { cwd: foreignDirectory, encoding: "utf8" });
      expect(result.status).toBe(0);
      const steps = JSON.parse(result.stdout);
      expect(steps.find((step) => step.name === "container-build")?.args.at(-1))
        .toBe(repositoryRoot);
      expect(steps.find((step) => step.name === "compose-config")?.args)
        .toContain(join(repositoryRoot, "docker-compose.yml"));
    } finally {
      rmSync(foreignDirectory, { recursive: true, force: true });
    }
  });

  test("uses the non-destructive verification scope by default and rejects unknown scopes", () => {
    expect(parseReleaseScope([])).toBe("verify");
    expect(parseReleaseScope(["--scope", "verify"])).toBe("verify");
    expect(parseReleaseScope(["--scope=container"])).toBe("container");
    expect(parseReleaseScope(["--scope=runtime-container"])).toBe("runtime-container");
    expect(() => parseReleaseScope(["--scope", "partial"])).toThrow("Unknown release verification scope");
  });

  test("allows destructive container cleanup only for an explicitly isolated CI project", () => {
    expect(() => assertContainerIsolation({})).toThrow("DEVKH_CONTAINER_SMOKE");
    expect(() => assertContainerIsolation({
      DEVKH_CONTAINER_SMOKE: "true",
      COMPOSE_PROJECT_NAME: "dev-knowledge-hub"
    })).toThrow("CI-only Compose project");
    expect(() => assertContainerIsolation({
      DEVKH_CONTAINER_SMOKE: "true",
      COMPOSE_PROJECT_NAME: "devkh-ci"
    })).not.toThrow();
  });

  test("accepts only a digest-bound semantic gate manifest for the exact candidate and approver", async () => {
    const root = mkdtempSync(join(tmpdir(), "devkh-contract-gate-"));
    const fixture = createContractGateFixture(root);
    try {
      await expect(validateSourceBlobContractGateManifest(fixture.manifestPath, {
        expectedDigest: fixture.manifestDigest,
        expectedCandidateCommit: fixture.candidateCommit,
        expectedApprover: fixture.approver,
        now: new Date("2026-07-08T12:00:00.000Z"),
        validateRecoveryEvidence: async (path) => JSON.parse(readFileSync(path, "utf8"))
      })).resolves.toMatchObject({
        candidateCommit: fixture.candidateCommit,
        approver: fixture.approver,
        recoveryEvidencePath: join(root, "recovery.json")
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects legacy caller flags when no immutable gate manifest is supplied", async () => {
    await expect(assertSourceBlobContractReleaseGates({
      DEVKH_SOURCE_BLOB_ACTIVE_PREFLIGHT: "passed",
      DEVKH_SOURCE_BLOB_OBSERVATION_COMPLETE: "true",
      DEVKH_SOURCE_BLOB_DISK_CAPACITY_VALIDATED: "true",
      DEVKH_SOURCE_BLOB_HISTORIC_RELEASES_VALIDATED: "true",
      DEVKH_SOURCE_BLOB_OPERATOR_APPROVED: "true"
    }, {
      contractMigrationPresent: true,
      checkedOutCommit: "a".repeat(40)
    })).rejects.toThrow(/gate manifest, digest, candidate commit, and approver/i);
  });

  testWithSourceBlobContract("keeps the migration-only container path when the approved base contains the contract", async () => {
    const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    await expect(assertSourceBlobContractReleaseGates({
      DEVKH_RELEASE_APPROVED_BASE: currentCommit
    }, {
      contractMigrationPresent: true
    })).resolves.toEqual({ authorizedByApprovedBase: currentCommit });
  });

  test("does not inherit approved-base authorization from a different same-named 0035", async () => {
    const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    await expect(assertSourceBlobContractReleaseGates({
      DEVKH_RELEASE_APPROVED_BASE: "79c833b7bcd88c5147ff7ee7aba9786bf89032ed"
    }, {
      contractMigrationPresent: true,
      checkedOutCommit: currentCommit
    })).rejects.toThrow(/gate manifest, digest, candidate commit, and approver/i);
  });

  testWithSourceBlobContract.each([
    ["a pull request whose trusted base already contains the unchanged contract", (trusted, candidate) => ({
      repository: { full_name: "example/devkh" },
      pull_request: { base: { sha: trusted, repo: { full_name: "example/devkh" } } },
      after: candidate
    }), "pull_request"],
    ["a protected main push whose predecessor already contains the contracted runtime", (trusted, candidate) => ({
      ref: "refs/heads/main",
      before: trusted,
      after: candidate,
      repository: { full_name: "example/devkh" }
    }), "push"]
  ])("allows ordinary runtime verification for %s", async (_label, eventFactory, eventName) => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const trustedCommit = createSyntheticTrustedBaselineCommit(head);
    const candidateCommit = createSyntheticDescendant(trustedCommit);
    const loadApprovalProvenance = vi.fn(async (commit) => createPhaseMergeApproval(commit));
    await expect(assertPostContractRuntimeCi({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKFLOW: "ci",
      GITHUB_EVENT_NAME: eventName,
      GITHUB_REPOSITORY: "example/devkh"
    }, {
      checkedOutCommit: candidateCommit,
      event: eventFactory(trustedCommit, candidateCommit),
      loadApprovalProvenance,
      materializeBaseline: false
    })).resolves.toMatchObject({
      eventName,
      trustedContractCommit: trustedCommit
    });
    expect(loadApprovalProvenance).toHaveBeenCalledWith(trustedCommit, expect.any(Object));
  });

  testWithSourceBlobContract("rejects a second main push after an unapproved contract introduction", async () => {
    const unauthorizedContractCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const candidateCommit = createSyntheticDescendant(unauthorizedContractCommit);
    await expect(assertPostContractRuntimeCi({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKFLOW: "ci",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REPOSITORY: "example/devkh"
    }, {
      checkedOutCommit: candidateCommit,
      event: {
        ref: "refs/heads/main",
        before: unauthorizedContractCommit,
        after: candidateCommit,
        repository: { full_name: "example/devkh" }
      },
      loadApprovalProvenance: async () => {
        throw new Error("No independently approved Phase Merge artifact");
      },
      materializeBaseline: false
    })).rejects.toThrow(/independently approved Phase Merge artifact/i);
  });

  test("verifies an exact-commit approval ZIP against trusted GitHub workflow metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "devkh-phase-merge-approval-"));
    const approvedCommit = "c".repeat(40);
    const provenance = {
      schemaVersion: 1,
      kind: "devkh-phase-merge-approval",
      repository: "example/devkh",
      approvedCommit,
      approvedHead: "a".repeat(40),
      approvedBase: "b".repeat(40),
      contractBlob: "d".repeat(40),
      baselineBlob: "e".repeat(40),
      workflowBlob: "f".repeat(40),
      trustedBootstrapCommit: "9".repeat(40),
      trustedVerifierBlob: "8".repeat(40),
      trustedDatabaseVerifierBlob: "7".repeat(40),
      workflowRunId: 12345,
      workflowRunAttempt: 1,
      issuedAt: "2026-07-21T00:00:30.000Z"
    };
    writeFileSync(join(root, "phase-merge-approval.json"), `${JSON.stringify(provenance)}\n`);
    execFileSync("zip", ["-q", "-j", join(root, "approval.zip"), join(root, "phase-merge-approval.json")]);
    const archive = readFileSync(join(root, "approval.zip"));
    const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    const fetchMock = vi.fn(async (url) => {
      const value = String(url);
      if (value.includes("actions/artifacts?")) return {
        ok: true,
        json: async () => ({ artifacts: [{
          id: 55, name: `phase-merge-approval-${approvedCommit}`, expired: false, digest,
          created_at: "2026-07-21T00:01:00Z", workflow_run: { id: 12345 }
        }] })
      };
      if (value.endsWith("/actions/runs/12345")) return {
        ok: true,
        json: async () => ({
          id: 12345, workflow_id: 77, event: "workflow_dispatch", status: "completed", conclusion: "success",
          run_attempt: 1, actor: { login: "example" }, repository: { full_name: "example/devkh" },
          head_sha: "b".repeat(40), head_branch: "main",
          created_at: "2026-07-21T00:00:00Z"
        })
      };
      if (value.endsWith("/actions/workflows/77")) return {
        ok: true,
        json: async () => ({ id: 77, path: ".github/workflows/phase-merge.yml" })
      };
      if (value.endsWith("/actions/artifacts/55/zip")) return {
        ok: true,
        arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
      };
      throw new Error(`unexpected GitHub URL: ${value}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(loadPhaseMergeApprovalProvenance(approvedCommit, {
        repository: "example/devkh",
        token: "github-token"
      })).resolves.toEqual(provenance);
    } finally {
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects legacy approval provenance that is not bound to the trusted bootstrap verifier", () => {
    const approvedCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const legacy = { ...createPhaseMergeApproval(approvedCommit) };
    delete legacy.trustedBootstrapCommit;
    delete legacy.trustedVerifierBlob;
    delete legacy.trustedDatabaseVerifierBlob;
    expect(() => validatePhaseMergeApprovalProvenance(legacy, {
      repository: "example/devkh",
      approvedCommit,
      trustedBootstrapCommit: "9".repeat(40),
      trustedVerifierBlob: "8".repeat(40),
      trustedDatabaseVerifierBlob: "7".repeat(40)
    })).toThrow(/bootstrap|fields|verifier/i);
  });

  test.each([
    ["executing verifier", { executingVerifier: "0".repeat(40) }],
    ["candidate verifier", { candidateVerifier: "0".repeat(40) }],
    ["candidate workflow", { candidateCiWorkflow: "0".repeat(40) }]
  ])("rejects a candidate-replaced %s before gate enforcement", (_label, override) => {
    const bootstrap = "9".repeat(40);
    const currentWorkflow = "8".repeat(40);
    const blobs = {
      trustedVerifier: "1".repeat(40),
      trustedDatabaseVerifier: "2".repeat(40),
      ciWorkflow: "3".repeat(40),
      phaseMergeWorkflow: "4".repeat(40),
      ...override
    };
    const gitOutput = vi.fn((args) => {
      const value = args.join(" ");
      if (value === `merge-base --is-ancestor ${bootstrap} HEAD`) return "";
      if (value.includes(`${bootstrap}:scripts/release-verify.mjs`)) return blobs.trustedVerifier;
      if (value.includes(`${bootstrap}:scripts/verify-post-contract-database.mjs`)) return blobs.trustedDatabaseVerifier;
      if (value.includes(`${bootstrap}:.github/workflows/ci.yml`)) return blobs.ciWorkflow;
      if (value.includes(`${bootstrap}:.github/workflows/phase-merge.yml`)) return blobs.phaseMergeWorkflow;
      if (value.includes(`${currentWorkflow}:.github/workflows/ci.yml`)) return blobs.ciWorkflow;
      if (value.includes("HEAD:scripts/release-verify.mjs")) return blobs.candidateVerifier ?? blobs.trustedVerifier;
      if (value.includes("HEAD:scripts/verify-post-contract-database.mjs")) return blobs.trustedDatabaseVerifier;
      if (value.includes("HEAD:.github/workflows/ci.yml")) return blobs.candidateCiWorkflow ?? blobs.ciWorkflow;
      if (value.includes("HEAD:.github/workflows/phase-merge.yml")) return blobs.phaseMergeWorkflow;
      if (args[0] === "hash-object" && value.includes("verify-post-contract-database.mjs")) {
        return blobs.trustedDatabaseVerifier;
      }
      if (args[0] === "hash-object") return blobs.executingVerifier ?? blobs.trustedVerifier;
      throw new Error(`unexpected git call: ${value}`);
    });

    expect(() => assertTrustedVerifierBootstrap({
      DEVKH_FK17_TRUSTED_BOOTSTRAP_COMMIT: bootstrap,
      DEVKH_FK17_CURRENT_WORKFLOW_SHA: currentWorkflow,
      DEVKH_FK17_CURRENT_WORKFLOW_PATH: ".github/workflows/ci.yml"
    }, { gitOutput })).toThrow(/trusted bootstrap verifier|candidate gate workflow/i);
  });

  testWithSourceBlobContract("allows a codex/mvp push only when its prior commit already contains the unchanged contract", async () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const priorCommit = createSyntheticTrustedBaselineCommit(head);
    const currentCommit = createSyntheticDescendant(priorCommit);
    await expect(assertPostContractRuntimeCi({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKFLOW: "ci",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REPOSITORY: "example/devkh"
    }, {
      checkedOutCommit: currentCommit,
      event: {
        ref: "refs/heads/codex/mvp",
        before: priorCommit,
        after: currentCommit,
        repository: { full_name: "example/devkh" }
      },
      loadApprovalProvenance: async (commit) => createPhaseMergeApproval(commit),
      materializeBaseline: false
    })).resolves.toMatchObject({
      eventName: "push",
      trustedContractCommit: priorCommit
    });
  });

  testWithSourceBlobContract("rejects an introducing protected-main push whose predecessor lacks 0035", async () => {
    const candidateCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const introducingBase = spawnSync(
      "git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" }
    ).stdout.trim();
    await expect(assertPostContractRuntimeCi({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKFLOW: "ci",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REPOSITORY: "example/devkh"
    }, {
      checkedOutCommit: candidateCommit,
      event: {
        ref: "refs/heads/main",
        before: introducingBase,
        after: candidateCommit,
        repository: { full_name: "example/devkh" }
      },
      materializeBaseline: false
    })).rejects.toThrow(/trusted.*base.*0035/i);
  });

  test("rejects protected-main runtime self-authorization when before equals the candidate", async () => {
    const candidateCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    await expect(assertPostContractRuntimeCi({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKFLOW: "ci",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REPOSITORY: "example/devkh"
    }, {
      checkedOutCommit: candidateCommit,
      event: {
        ref: "refs/heads/main",
        before: candidateCommit,
        after: candidateCommit,
        repository: { full_name: "example/devkh" }
      },
      materializeBaseline: false
    })).rejects.toThrow(/distinct trusted predecessor/i);
  });

  test("rejects candidate baseline edits even when 0035 is unchanged", () => {
    expect(() => assertTrustedRuntimeMaterialIdentity({
      trustedContractBlob: "a".repeat(40),
      candidateContractBlob: "a".repeat(40),
      trustedBaselineBlob: "b".repeat(40),
      candidateBaselineBlob: "c".repeat(40)
    })).toThrow(/baseline/i);
  });

  testWithSourceBlobContract.each([
    ["CTE-wrapped write", "WITH injected AS (INSERT INTO public.workspaces (name, slug) VALUES ('x', 'x') RETURNING id) SELECT * FROM injected;"],
    ["no-op application delete", "DELETE FROM public.workspaces WHERE false;"],
    ["table-as-select write", "CREATE TABLE public.injected AS SELECT * FROM public.workspaces;"],
    ["anonymous code block", "DO $$ BEGIN DELETE FROM public.workspaces; END $$;"],
    ["stored procedure call", "CALL public.injected();"],
    ["user-defined function", "CREATE FUNCTION public.injected() RETURNS void LANGUAGE sql AS $$ INSERT INTO public.workspaces (name, slug) VALUES ('x', 'x') $$;"],
    ["trigger", "CREATE TRIGGER injected BEFORE INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.injected();"]
  ])("rejects arbitrary executable baseline DML: %s", (_label, statement) => {
    const baseline = readFileSync("docker/post-contract-ci-baseline.sql", "utf8");
    const expectedMigrations = readdirSync("drizzle")
      .filter((name) => name.endsWith(".sql") && name <= "0035_source_blobs_contract.sql")
      .sort();
    expect(() => validatePostContractBaselineGrammar(`${baseline}\n${statement}\n`, expectedMigrations))
      .toThrow(/executable statement/i);
  });

  testWithSourceBlobContract("does not let caller flags turn an introducing contract PR into ordinary runtime CI", async () => {
    const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const introducingBase = spawnSync(
      "git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" }
    ).stdout.trim();
    await expect(assertPostContractRuntimeCi({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKFLOW: "ci",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "example/devkh",
      DEVKH_RELEASE_APPROVED_BASE: currentCommit,
      DEVKH_SOURCE_BLOB_CONTRACT_AUTHORIZED: "true"
    }, {
      checkedOutCommit: currentCommit,
      event: {
        repository: { full_name: "example/devkh" },
        pull_request: { base: { sha: introducingBase, repo: { full_name: "example/devkh" } } }
      }
    })).rejects.toThrow(/trusted.*base.*0035/i);
  });

  test.each([
    ["candidate commit", { expectedCandidateCommit: "b".repeat(40) }, /candidate commit/i],
    ["approver", { expectedApprover: "different-owner" }, /approver/i]
  ])("rejects a gate manifest bound to the wrong %s", async (_label, option, pattern) => {
    const root = mkdtempSync(join(tmpdir(), "devkh-contract-gate-"));
    const fixture = createContractGateFixture(root);
    try {
      await expect(validateSourceBlobContractGateManifest(fixture.manifestPath, {
        expectedDigest: fixture.manifestDigest,
        expectedCandidateCommit: fixture.candidateCommit,
        expectedApprover: fixture.approver,
        ...option,
        now: new Date("2026-07-08T12:00:00.000Z"),
        validateRecoveryEvidence: async (path) => JSON.parse(readFileSync(path, "utf8"))
      })).rejects.toThrow(pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["preflight", { unboundSourceFiles: 1 }, /preflight/i],
    ["seven-day observation", { observationStartedAt: "2026-07-01T00:00:00.001Z" }, /seven days/i],
    ["capacity", { availableBytes: "999999" }, /capacity/i],
    ["canonical capacity byte counts", { availableBytes: 2000000 }, /byte counts/i],
    ["historic releases", { unresolvedDependencies: 1 }, /historic release/i]
  ])("rejects gate evidence that does not prove %s", async (_label, fixtureOptions, pattern) => {
    const root = mkdtempSync(join(tmpdir(), "devkh-contract-gate-"));
    const fixture = createContractGateFixture(root, fixtureOptions);
    try {
      await expect(validateSourceBlobContractGateManifest(fixture.manifestPath, {
        expectedDigest: fixture.manifestDigest,
        expectedCandidateCommit: fixture.candidateCommit,
        expectedApprover: fixture.approver,
        now: new Date("2026-07-08T12:00:00.000Z"),
        validateRecoveryEvidence: async (path) => JSON.parse(readFileSync(path, "utf8"))
      })).rejects.toThrow(pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["preflight", { preflightFinishedAt: "2026-07-08T12:00:00.001Z" }],
    ["observation", {
      observationStartedAt: "2026-07-09T00:00:00.000Z",
      observationFinishedAt: "2026-07-16T00:00:00.000Z"
    }],
    ["capacity", { capacityMeasuredAt: "2026-07-08T12:00:00.001Z" }],
    ["historic release", { historicVerifiedAt: "2026-07-08T12:00:00.001Z" }],
    ["approval", { approvedAt: "2026-07-08T12:00:00.001Z" }]
  ])("rejects future-dated %s evidence", async (label, fixtureOptions) => {
    const root = mkdtempSync(join(tmpdir(), "devkh-contract-gate-"));
    const fixture = createContractGateFixture(root, fixtureOptions);
    try {
      await expect(validateSourceBlobContractGateManifest(fixture.manifestPath, {
        expectedDigest: fixture.manifestDigest,
        expectedCandidateCommit: fixture.candidateCommit,
        expectedApprover: fixture.approver,
        now: new Date("2026-07-08T12:00:00.000Z"),
        validateRecoveryEvidence: async (path) => JSON.parse(readFileSync(path, "utf8"))
      })).rejects.toThrow(new RegExp(`${label}.*future`, "i"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["approval after manifest creation", {
      approvedAt: "2026-07-08T12:00:00.000Z",
      manifestCreatedAt: "2026-07-08T00:00:00.000Z"
    }, /approval.*after.*manifest/i],
    ["evidence completed after approval", {
      preflightFinishedAt: "2026-07-08T12:00:00.000Z",
      approvedAt: "2026-07-08T00:00:00.000Z",
      manifestCreatedAt: "2026-07-09T00:00:00.000Z"
    }, /preflight.*after.*approval/i],
    ["observation ending before it starts", {
      observationStartedAt: "2026-07-08T00:00:00.000Z",
      observationFinishedAt: "2026-07-07T00:00:00.000Z",
      approvedAt: "2026-07-09T00:00:00.000Z",
      manifestCreatedAt: "2026-07-09T00:00:00.000Z"
    }, /observation.*before.*start/i]
  ])("rejects incoherent gate chronology: %s", async (_label, fixtureOptions, pattern) => {
    const root = mkdtempSync(join(tmpdir(), "devkh-contract-gate-"));
    const fixture = createContractGateFixture(root, fixtureOptions);
    try {
      await expect(validateSourceBlobContractGateManifest(fixture.manifestPath, {
        expectedDigest: fixture.manifestDigest,
        expectedCandidateCommit: fixture.candidateCommit,
        expectedApprover: fixture.approver,
        now: new Date("2026-07-09T00:00:00.000Z"),
        validateRecoveryEvidence: async (path) => JSON.parse(readFileSync(path, "utf8"))
      })).rejects.toThrow(pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a tampered evidence reference even when caller flags claim success", async () => {
    const root = mkdtempSync(join(tmpdir(), "devkh-contract-gate-"));
    const fixture = createContractGateFixture(root);
    writeFileSync(join(root, "capacity.json"), '{"fabricated":true}\n', { mode: 0o600 });
    try {
      await expect(validateSourceBlobContractGateManifest(fixture.manifestPath, {
        expectedDigest: fixture.manifestDigest,
        expectedCandidateCommit: fixture.candidateCommit,
        expectedApprover: fixture.approver,
        now: new Date("2026-07-08T12:00:00.000Z"),
        validateRecoveryEvidence: async (path) => JSON.parse(readFileSync(path, "utf8")),
        env: {
          DEVKH_SOURCE_BLOB_ACTIVE_PREFLIGHT: "passed",
          DEVKH_SOURCE_BLOB_DISK_CAPACITY_VALIDATED: "true"
        }
      })).rejects.toThrow(/digest/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains the outer Compose state when the recovery drill fails", async () => {
    const execute = vi.fn(async (step) => {
      if (step.name === "recovery-drill") {
        throw Object.assign(new Error("recovery fixture failed"), { exitCode: 65 });
      }
    });

    const invalidateEvidence = vi.fn(async () => undefined);
    await expect(runContainerVerification({
      env: {
        DEVKH_CONTAINER_SMOKE: "true",
        COMPOSE_PROJECT_NAME: "devkh-ci",
        RECOVERY_EVIDENCE_DIR: "/tmp/evidence"
      },
      execute,
      invalidateEvidence,
      logger: { error: vi.fn(), log: vi.fn() }
    })).rejects.toThrow("recovery-drill failed with exit code 65");

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: "recovery-drill" }));
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ name: "compose-cleanup" }));
    expect(invalidateEvidence).toHaveBeenCalledWith("/tmp/evidence", "recovery_drill_failed");
  });

  test("recovery drill failure leaves only a sanitized upload record", async () => {
    const root = mkdtempSync(join(tmpdir(), "devkh-release-evidence-"));
    const pairDirectory = join(root, "run-1", "recovery-evidence");
    mkdirSync(pairDirectory, { recursive: true });
    for (const name of ["evidence.json", "evidence.json.pending", "evidence.ndjson", "evidence.ndjson.pending"]) {
      writeFileSync(join(pairDirectory, name), "invalid\n");
    }
    const execute = vi.fn(async (step) => {
      if (step.name === "recovery-drill") throw Object.assign(new Error("invalid pending pair"), { exitCode: 65 });
    });

    try {
      await expect(runContainerVerification({
        env: {
          DEVKH_CONTAINER_SMOKE: "true",
          COMPOSE_PROJECT_NAME: "devkh-ci",
          RECOVERY_EVIDENCE_DIR: root
        },
        execute,
        logger: { error: vi.fn(), log: vi.fn() }
      })).rejects.toThrow("recovery-drill failed with exit code 65");

      expect(readdirSync(root)).toEqual(["recovery-verification-failed.json"]);
      const failure = JSON.parse(readFileSync(join(root, "recovery-verification-failed.json"), "utf8"));
      expect(failure).toMatchObject({ result: "failed", errorClass: "recovery_drill_failed" });
      expect(failure).not.toHaveProperty("retentionPath");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains the outer Compose state when an earlier container step fails", async () => {
    const execute = vi.fn(async (step) => {
      if (step.name === "application-health") throw Object.assign(new Error("health failed"), { exitCode: 1 });
    });
    const invalidateEvidence = vi.fn(async () => undefined);
    await expect(runContainerVerification({
      env: {
        DEVKH_CONTAINER_SMOKE: "true",
        COMPOSE_PROJECT_NAME: "devkh-ci",
        RECOVERY_EVIDENCE_DIR: "/tmp/evidence"
      },
      execute,
      invalidateEvidence,
      logger: { error: vi.fn(), log: vi.fn() }
    }))
      .rejects.toThrow("application-health failed with exit code 1");
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ name: "compose-cleanup" }));
    expect(invalidateEvidence).toHaveBeenCalledWith("/tmp/evidence", "container_verification_failed");
  });

  test("cleans up the isolated Compose state after successful container verification", async () => {
    const execute = vi.fn(async () => undefined);
    await expect(runContainerVerification({ env: { DEVKH_CONTAINER_SMOKE: "true", COMPOSE_PROJECT_NAME: "devkh-ci" }, execute, logger: { error: vi.fn(), log: vi.fn() } }))
      .resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: "compose-cleanup" }));
  });

  test("invalidates recovery evidence when outer Compose cleanup fails", async () => {
    const execute = vi.fn(async (step) => {
      if (step.name === "compose-cleanup") throw Object.assign(new Error("cleanup failed"), { exitCode: 1 });
    });
    const invalidateEvidence = vi.fn(async () => undefined);
    await expect(runContainerVerification({
      env: { DEVKH_CONTAINER_SMOKE: "true", COMPOSE_PROJECT_NAME: "devkh-ci", RECOVERY_EVIDENCE_DIR: "/tmp/evidence" },
      execute,
      invalidateEvidence,
      logger: { error: vi.fn(), log: vi.fn() }
    })).rejects.toThrow("compose-cleanup failed with exit code 1");
    expect(invalidateEvidence).toHaveBeenCalledWith("/tmp/evidence", "compose_cleanup_failed");
  });

  test("finalizes the sidecar before JSON and strictly validates the final pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "devkh-release-evidence-"));
    const paths = createPendingEvidence(root);
    const renames = [];
    try {
      await finalizeRecoveryEvidence(root, {
        renameFile: async (source, destination) => {
          renames.push([source, destination]);
          const { rename } = await import("node:fs/promises");
          await rename(source, destination);
        },
        validateEvidence: async (path) => {
          expect(path).toBe(paths.jsonFinal);
          expect(existsSync(paths.sidecarFinal)).toBe(true);
          expect(existsSync(paths.jsonFinal)).toBe(true);
          const { validateRecoveryEvidenceFile } = await import("./backup/validate-recovery-evidence.mjs");
          await validateRecoveryEvidenceFile(path);
        }
      });

      expect(renames).toEqual([
        [paths.sidecarPending, paths.sidecarFinal],
        [paths.jsonPending, paths.jsonFinal]
      ]);
      expect(existsSync(paths.sidecarPending)).toBe(false);
      expect(existsSync(paths.jsonPending)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes both pending and final artifacts when strict final validation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "devkh-release-evidence-"));
    const paths = createPendingEvidence(root);
    try {
      await expect(finalizeRecoveryEvidence(root, {
        validateEvidence: async () => { throw new Error("tampered final pair"); }
      })).rejects.toThrow("tampered final pair");

      for (const path of [paths.sidecarPending, paths.sidecarFinal, paths.jsonPending, paths.jsonFinal]) {
        expect(existsSync(path)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalidates both artifacts when deferred final validation fails", async () => {
    const execute = vi.fn(async () => undefined);
    const invalidateEvidence = vi.fn(async () => undefined);
    const finalizeEvidence = vi.fn(async () => { throw new Error("strict final validation failed"); });

    await expect(runContainerVerification({
      env: {
        DEVKH_CONTAINER_SMOKE: "true",
        COMPOSE_PROJECT_NAME: "devkh-ci",
        RECOVERY_EVIDENCE_DIR: "/tmp/evidence",
        RECOVERY_EVIDENCE_DEFER_FINALIZATION: "true"
      },
      execute,
      finalizeEvidence,
      invalidateEvidence,
      logger: { error: vi.fn(), log: vi.fn() }
    })).rejects.toThrow("strict final validation failed");

    expect(finalizeEvidence).toHaveBeenCalledWith("/tmp/evidence");
    expect(invalidateEvidence).toHaveBeenCalledWith("/tmp/evidence", "recovery_evidence_finalization_failed");
  });

  test("stops at the first failed step and reports its command and exit code", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("failed"), { exitCode: 7 }));

    await expect(runReleaseSteps(VERIFY_STEPS.slice(0, 3), { execute }))
      .rejects.toThrow("licenses failed with exit code 7: npm run licenses:check");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
