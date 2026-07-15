import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTAINER_STEPS,
  VERIFY_STEPS,
  assertContainerIsolation,
  parseReleaseScope,
  runContainerVerification,
  runReleaseSteps
} from "./release-verify.mjs";

describe("release verification orchestrator", () => {
  test("keeps the release checks in the approved order", () => {
    expect(VERIFY_STEPS.map((step) => step.name)).toEqual([
      "secrets", "licenses", "runtime", "runtime-tests", "backup-tests", "delivery",
      "typecheck", "lint", "unit", "postgres-integration", "build", "acceptance", "e2e"
    ]);
    expect(CONTAINER_STEPS.map((step) => step.name)).toEqual([
      "container-build", "compose-config", "compose-up", "application-health", "recovery-drill"
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

    await expect(runContainerVerification({
      env: { DEVKH_CONTAINER_SMOKE: "true", COMPOSE_PROJECT_NAME: "devkh-ci" },
      execute,
      logger: { error: vi.fn(), log: vi.fn() }
    })).rejects.toThrow("recovery-drill failed with exit code 65");

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: "recovery-drill" }));
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ name: "compose-cleanup" }));
  });

  test("retains the outer Compose state when an earlier container step fails", async () => {
    const execute = vi.fn(async (step) => {
      if (step.name === "application-health") throw Object.assign(new Error("health failed"), { exitCode: 1 });
    });
    await expect(runContainerVerification({ env: { DEVKH_CONTAINER_SMOKE: "true", COMPOSE_PROJECT_NAME: "devkh-ci" }, execute, logger: { error: vi.fn(), log: vi.fn() } }))
      .rejects.toThrow("application-health failed with exit code 1");
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ name: "compose-cleanup" }));
  });

  test("cleans up the isolated Compose state after successful container verification", async () => {
    const execute = vi.fn(async () => undefined);
    await expect(runContainerVerification({ env: { DEVKH_CONTAINER_SMOKE: "true", COMPOSE_PROJECT_NAME: "devkh-ci" }, execute, logger: { error: vi.fn(), log: vi.fn() } }))
      .resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: "compose-cleanup" }));
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
