import { describe, expect, test } from "vitest";

import { pipelineInputDigest } from "./input-digest";

const input = {
  stage: "extract" as const,
  snapshotId: "snapshot-1",
  upstreamManifestIds: ["artifact-a"],
  parserConfigVersion: "extract-v1",
  purpose: { kind: "feedback" as const, feedbackIds: ["feedback-2", "feedback-1"] }
};

describe("pipelineInputDigest", () => {
  test("includes versioned stage inputs but only the allow-listed build purpose", () => {
    const digest = pipelineInputDigest(input);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(pipelineInputDigest({ ...input, stage: "tables" })).not.toBe(digest);
    expect(pipelineInputDigest({ ...input, upstreamManifestIds: ["artifact-b"] })).not.toBe(digest);
    expect(pipelineInputDigest({ ...input, parserConfigVersion: "extract-v2" })).not.toBe(digest);
    expect(pipelineInputDigest({ ...input, purpose: { kind: "feedback", feedbackIds: ["feedback-3"] } })).not.toBe(digest);
  });

  test("is stable for equivalent purpose and upstream ordering", () => {
    expect(pipelineInputDigest(input)).toBe(pipelineInputDigest({
      ...input,
      upstreamManifestIds: ["artifact-a"],
      purpose: { kind: "feedback", feedbackIds: ["feedback-1", "feedback-2"] }
    }));
  });
});
