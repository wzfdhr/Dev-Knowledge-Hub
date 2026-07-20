import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTAINER_STEPS,
  VERIFY_STEPS,
  assertContainerIsolation,
  finalizeRecoveryEvidence,
  parseReleaseScope,
  runContainerVerification,
  runReleaseSteps
} from "./release-verify.mjs";

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

describe("release verification orchestrator", () => {
  test("keeps the release checks in the approved order", () => {
    expect(VERIFY_STEPS.map((step) => step.name)).toEqual([
      "secrets", "licenses", "runtime", "runtime-tests", "backup-tests", "delivery",
      "typecheck", "lint", "unit", "postgres-integration", "build", "acceptance", "knowledge-quality", "e2e"
    ]);
    expect(CONTAINER_STEPS.map((step) => step.name)).toEqual([
      "container-build", "compose-config", "compose-up", "parser-isolation", "application-health", "recovery-drill"
    ]);
    expect(CONTAINER_STEPS.find((step) => step.name === "compose-up")?.args).toContain("--wait");
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
