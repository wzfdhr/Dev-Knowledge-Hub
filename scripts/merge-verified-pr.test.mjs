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
  headRefOid: "a".repeat(40),
  statusCheckRollup: [
    { name: "verify", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "container-smoke", status: "COMPLETED", conclusion: "SUCCESS" }
  ]
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

  test("rejects drafts, non-main targets, and missing or failed checks", () => {
    expect(() => assertMergeReady({ ...greenPullRequest, isDraft: true })).toThrow("Draft");
    expect(() => assertMergeReady({ ...greenPullRequest, baseRefName: "develop" })).toThrow("main");
    expect(() => assertMergeReady(greenPullRequest, "b".repeat(40))).toThrow("changed after user approval");
    expect(() => assertMergeReady({
      ...greenPullRequest,
      statusCheckRollup: greenPullRequest.statusCheckRollup.slice(0, 1)
    }, "a".repeat(40))).toThrow("container-smoke");
    expect(() => assertMergeReady({
      ...greenPullRequest,
      statusCheckRollup: greenPullRequest.statusCheckRollup.map((check) =>
        check.name === "verify" ? { ...check, conclusion: "FAILURE" } : check)
    }, "a".repeat(40))).toThrow("verify");
  });

  test("uses a merge commit only after the remote PR state is verified", async () => {
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
      "number,isDraft,baseRefName,headRefName,headRefOid,statusCheckRollup"
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, [
      "pr", "merge", "3", "--merge", "--delete-branch", "--match-head-commit", "a".repeat(40)
    ]);
  });
});
