import { describe, expect, test } from "vitest";

import {
  TestCiOutcomeVerifier,
  appliesOutcomeToRecommendation
} from "./outcome-verifier";

describe("CI outcome verification", () => {
  const payload = {
    repositoryId: "repository-1",
    patternGroupId: "experience-1",
    evidenceId: "evidence-1",
    sourceVersion: "content-v1",
    outcome: "failed" as const,
    checks: [{ name: "frontend", status: "failed" as const }],
    reportDigest: "a".repeat(64)
  };

  test("accepts a signed outcome only when repository and source version match", async () => {
    const verifier = new TestCiOutcomeVerifier("test-signature");

    await expect(verifier.verify({
      rawBody: Buffer.from(JSON.stringify(payload)),
      signature: "test-signature",
      expectedRepositoryId: payload.repositoryId,
      expectedSourceVersion: payload.sourceVersion
    })).resolves.toEqual(payload);

    await expect(verifier.verify({
      rawBody: Buffer.from(JSON.stringify({ ...payload, sourceVersion: "content-v2" })),
      signature: "test-signature",
      expectedRepositoryId: payload.repositoryId,
      expectedSourceVersion: payload.sourceVersion
    })).rejects.toThrow("CI outcome source version does not match");
  });

  test("rejects a mismatched repository, invalid signature, and malformed payload", async () => {
    const verifier = new TestCiOutcomeVerifier("test-signature");

    await expect(verifier.verify({
      rawBody: Buffer.from(JSON.stringify(payload)), signature: "wrong",
      expectedRepositoryId: payload.repositoryId, expectedSourceVersion: payload.sourceVersion
    })).rejects.toThrow("CI outcome signature is invalid");
    await expect(verifier.verify({
      rawBody: Buffer.from(JSON.stringify({ ...payload, repositoryId: "other" })),
      signature: "test-signature", expectedRepositoryId: payload.repositoryId,
      expectedSourceVersion: payload.sourceVersion
    })).rejects.toThrow("CI outcome repository does not match");
    await expect(verifier.verify({
      rawBody: Buffer.from("not-json"), signature: "test-signature",
      expectedRepositoryId: payload.repositoryId, expectedSourceVersion: payload.sourceVersion
    })).rejects.toThrow("CI outcome payload is invalid");
  });

  test("only trusted negative outcomes pause recommendation evidence", () => {
    expect(appliesOutcomeToRecommendation({ authority: "signed_ci", outcome: "failed" })).toBe(true);
    expect(appliesOutcomeToRecommendation({ authority: "signed_ci", outcome: "rolled_back" })).toBe(true);
    expect(appliesOutcomeToRecommendation({ authority: "admin_confirmed", outcome: "rolled_back" })).toBe(true);
    expect(appliesOutcomeToRecommendation({ authority: "admin_confirmed", outcome: "failed" })).toBe(false);
    expect(appliesOutcomeToRecommendation({ authority: "user_reported", outcome: "rolled_back" })).toBe(false);
  });
});
