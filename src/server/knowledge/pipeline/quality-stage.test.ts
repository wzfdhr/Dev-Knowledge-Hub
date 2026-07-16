import { describe, expect, test } from "vitest";

import { pipelineKnowledgeQualityInputDigest } from "./quality-stage";
import { standardBuildPurpose } from "../build-service";

describe("knowledge quality pipeline stage", () => {
  test("binds quality inputs to every persisted pipeline artifact", () => {
    const snapshot = { id: "snapshot-1" };
    const purpose = standardBuildPurpose();
    const artifacts = ["extract-artifact", "tables-artifact", "pages-artifact", "index-artifact"];

    expect(pipelineKnowledgeQualityInputDigest(snapshot, purpose, artifacts))
      .toMatch(/^[a-f0-9]{64}$/);
    expect(pipelineKnowledgeQualityInputDigest(snapshot, purpose, [...artifacts.slice(0, 3), "other-index-artifact"]))
      .not.toBe(pipelineKnowledgeQualityInputDigest(snapshot, purpose, artifacts));
  });
});
