import { describe, expect, test, vi } from "vitest";

import {
  assertMergeReady,
  mergeVerifiedPullRequest,
  parseMergeArguments
} from "./merge-verified-pr.mjs";

const greenPullRequest = {
  number: 3,
  isDraft: false,
  baseRefName: "main",
  headRefName: "codex/phase-a-release-baseline",
  headRefOid: "a".repeat(40)
};

describe("private-repository merge gate", () => {
  test("requires an explicit user approval flag and a positive PR number", () => {
    expect(parseMergeArguments(["3", "--user-approved", "--approved-head", "a".repeat(40)])).toEqual({
      pullRequest: 3,
      userApproved: true,
      approvedHead: "a".repeat(40)
    });
    expect(() => parseMergeArguments(["3", "--approved-head", "a".repeat(40)])).toThrow("--user-approved");
    expect(() => parseMergeArguments(["3", "--user-approved"])).toThrow("--approved-head");
    expect(() => parseMergeArguments(["3", "--user-approved", "--approved-head", "short"])).toThrow("40-character");
    expect(() => parseMergeArguments(["not-a-number", "--user-approved", "--approved-head", "a".repeat(40)])).toThrow("pull request number");
  });

  test("rejects drafts, non-main targets, and changed heads", () => {
    expect(() => assertMergeReady({ ...greenPullRequest, isDraft: true })).toThrow("Draft");
    expect(() => assertMergeReady({ ...greenPullRequest, baseRefName: "develop" })).toThrow("main");
    expect(() => assertMergeReady(greenPullRequest, "b".repeat(40))).toThrow("changed after user approval");
  });

  test("dispatches the trusted merge workflow instead of merging from the client", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(greenPullRequest))
      .mockResolvedValueOnce("");

    await mergeVerifiedPullRequest({
      pullRequest: 3,
      userApproved: true,
      approvedHead: "a".repeat(40)
    }, { execute });

    expect(execute).toHaveBeenNthCalledWith(1, [
      "pr", "view", "3", "--json",
      "number,isDraft,baseRefName,headRefName,headRefOid"
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, [
      "workflow", "run", "phase-merge.yml", "--ref", "main",
      "--field", "pr_number=3",
      "--field", `approved_head=${"a".repeat(40)}`,
      "--field", "user_approved=true"
    ]);
    expect(execute.mock.calls.flat().flat()).not.toContain("merge");
  });
});
