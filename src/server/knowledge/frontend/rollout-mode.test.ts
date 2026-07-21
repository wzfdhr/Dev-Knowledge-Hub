import { describe, expect, test } from "vitest";

import {
  effectiveFrontendKnowledgeMode,
  validateProjectFrontendMode,
  validateFrontendModeConfiguration
} from "./rollout-mode";

describe("frontend knowledge rollout mode", () => {
  test.each([
    ["legacy", "legacy", undefined, "legacy"],
    ["shadow", "legacy", "shadow", "legacy"],
    ["shadow", "shadow", undefined, "legacy"],
    ["shadow", "shadow", "legacy", "legacy"],
    ["shadow", "shadow", "shadow", "shadow"],
    ["active", "active", "active", "active"]
  ] as const)("resolves kernel=%s system=%s project=%s to %s", (
    kernelMode, systemMode, projectMode, expected
  ) => {
    expect(effectiveFrontendKnowledgeMode({ kernelMode, systemMode, projectMode })).toBe(expected);
  });

  test("rejects a frontend system cap above the kernel cap", () => {
    expect(() => validateFrontendModeConfiguration({
      kernelMode: "legacy", systemMode: "shadow"
    })).toThrow("exceeds knowledge kernel mode");
    expect(() => validateFrontendModeConfiguration({
      kernelMode: "shadow", systemMode: "active"
    })).toThrow("exceeds knowledge kernel mode");
  });

  test("rejects project overrides above the configured frontend cap", () => {
    expect(() => validateProjectFrontendMode({
      kernelMode: "active", systemMode: "shadow", projectMode: "active"
    })).toThrow("exceeds frontend system mode");
  });
});
