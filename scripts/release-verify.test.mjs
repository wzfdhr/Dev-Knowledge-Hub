import { describe, expect, test, vi } from "vitest";

import {
  CONTAINER_STEPS,
  VERIFY_STEPS,
  parseReleaseScope,
  runReleaseSteps
} from "./release-verify.mjs";

describe("release verification orchestrator", () => {
  test("keeps the release checks in the approved order", () => {
    expect(VERIFY_STEPS.map((step) => step.name)).toEqual([
      "secrets", "licenses", "runtime", "runtime-tests", "backup-tests", "delivery",
      "typecheck", "lint", "unit", "postgres-integration", "build", "acceptance", "e2e"
    ]);
    expect(CONTAINER_STEPS.map((step) => step.name)).toEqual([
      "container-build", "compose-config", "compose-up", "application-health"
    ]);
  });

  test("uses all checks by default and rejects unknown scopes", () => {
    expect(parseReleaseScope([])).toBe("all");
    expect(parseReleaseScope(["--scope", "verify"])).toBe("verify");
    expect(parseReleaseScope(["--scope=container"])).toBe("container");
    expect(() => parseReleaseScope(["--scope", "partial"])).toThrow("Unknown release verification scope");
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
