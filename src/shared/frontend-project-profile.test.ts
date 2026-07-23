import { describe, expect, test } from "vitest";

import { frontendProjectProfileSchema } from "./frontend-project-profile";

describe("frontend-project-profile@1", () => {
  test("requires explicit known, unknown, or unsupported states", () => {
    const result = frontendProjectProfileSchema.safeParse({
      schemaVersion: 1,
      snapshotId: "snapshot-1",
      sourceProvenance: {
        schemaVersion: 1,
        kind: "upload",
        gitCommitSha: null,
        contentVersion: "content-1",
        ref: "upload",
        attestation: "unverified"
      },
      analyzerManifestDigest: "a".repeat(64),
      framework: { state: "unknown", reason: "unresolved" }
    });

    expect(result.success).toBe(false);
  });
});
