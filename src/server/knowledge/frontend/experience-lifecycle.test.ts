import { describe, expect, test } from "vitest";

import { transitionExperience } from "./experience-lifecycle";

describe("experience lifecycle", () => {
  test("rejects invalid lifecycle jumps", () => {
    expect(() => transitionExperience({ state: "candidate", evidence: [], decisions: [] }, {
      to: "recommended", actorId: "admin-1", reason: "skip", basisEvidenceIds: [], decisionId: null
    })).toThrow("Invalid experience transition");
  });

  test("only eligible evidence with an approved decision can become recommended", () => {
    expect(() => transitionExperience({
      state: "verified",
      evidence: [{ id: "upload-evidence", sourceEligibility: "admin_attested", revokedAt: null }],
      decisions: [{ id: "decision-1", decision: "approve", basisEvidenceIds: ["upload-evidence"] }]
    }, {
      to: "recommended",
      actorId: "admin-1",
      reason: "reviewed",
      basisEvidenceIds: ["upload-evidence"],
      decisionId: "decision-1"
    })).toThrow("Recommended experience requires visible eligible evidence and an approved decision");
  });
});
