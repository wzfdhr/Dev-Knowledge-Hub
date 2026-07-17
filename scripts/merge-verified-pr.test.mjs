import { describe, expect, test, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertMergeReady,
  mergeVerifiedPullRequest,
  parseMergeArguments
} from "./merge-verified-pr.mjs";

const greenPullRequest = {
  number: 3,
  isDraft: false,
  baseRefName: "main",
  baseRefOid: "c".repeat(40),
  headRefName: "codex/phase-a-release-baseline",
  headRefOid: "a".repeat(40)
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureGitIdentity(cwd) {
  git(cwd, ["config", "user.email", "phase-a-test@example.test"]);
  git(cwd, ["config", "user.name", "Phase A Test"]);
}

describe("private-repository merge gate", () => {
  test("requires an explicit user approval flag and both reviewed commit SHAs", () => {
    expect(parseMergeArguments([
      "3", "--user-approved", "--approved-head", "a".repeat(40), "--approved-base", "c".repeat(40)
    ])).toEqual({
      pullRequest: 3,
      userApproved: true,
      approvedHead: "a".repeat(40),
      approvedBase: "c".repeat(40)
    });
    expect(() => parseMergeArguments(["3", "--approved-head", "a".repeat(40), "--approved-base", "c".repeat(40)])).toThrow("--user-approved");
    expect(() => parseMergeArguments(["3", "--user-approved"])).toThrow("--approved-head");
    expect(() => parseMergeArguments(["3", "--user-approved", "--approved-head", "a".repeat(40)])).toThrow("--approved-base");
    expect(() => parseMergeArguments(["3", "--user-approved", "--approved-head", "short", "--approved-base", "c".repeat(40)])).toThrow("40-character");
    expect(() => parseMergeArguments(["not-a-number", "--user-approved", "--approved-head", "a".repeat(40), "--approved-base", "c".repeat(40)])).toThrow("pull request number");
  });

  test("rejects drafts, non-main targets, and changed heads", () => {
    expect(() => assertMergeReady({ ...greenPullRequest, isDraft: true })).toThrow("Draft");
    expect(() => assertMergeReady({ ...greenPullRequest, baseRefName: "develop" })).toThrow("main");
    expect(() => assertMergeReady({ ...greenPullRequest, baseRefOid: "invalid" }, "a".repeat(40), "c".repeat(40))).toThrow("base");
    expect(() => assertMergeReady({ ...greenPullRequest, baseRefOid: "b".repeat(40) }, "a".repeat(40), "c".repeat(40))).toThrow("base changed after user approval");
    expect(() => assertMergeReady(greenPullRequest, "b".repeat(40), "c".repeat(40))).toThrow("changed after user approval");
  });

  test("dispatches the trusted merge workflow instead of merging from the client", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(greenPullRequest))
      .mockResolvedValueOnce("");

    await mergeVerifiedPullRequest({
      pullRequest: 3,
      userApproved: true,
      approvedHead: "a".repeat(40),
      approvedBase: "c".repeat(40)
    }, { execute });

    expect(execute).toHaveBeenNthCalledWith(1, [
      "pr", "view", "3", "--json",
      "number,isDraft,baseRefName,baseRefOid,headRefName,headRefOid"
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, [
      "workflow", "run", "phase-merge.yml", "--ref", "main",
      "--field", "pr_number=3",
      "--field", `approved_head=${"a".repeat(40)}`,
      "--field", `approved_base=${"c".repeat(40)}`,
      "--field", "user_approved=true"
    ]);
    expect(execute.mock.calls.flat().flat()).not.toContain("merge");
  });

  test("rejects the compare-and-swap push when main advances after review", { timeout: 15_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "devkh-merge-lease-"));
    const remote = join(root, "remote.git");
    const writer = join(root, "writer");
    const merger = join(root, "merger");

    try {
      git(root, ["init", "--bare", remote]);
      git(root, ["clone", remote, writer]);
      configureGitIdentity(writer);
      git(writer, ["checkout", "-b", "main"]);
      writeFileSync(join(writer, "README.md"), "base\n");
      git(writer, ["add", "README.md"]);
      git(writer, ["commit", "-m", "base"]);
      git(writer, ["push", "origin", "main"]);
      const reviewedBase = git(writer, ["rev-parse", "HEAD"]);

      git(root, ["clone", remote, merger]);
      configureGitIdentity(merger);
      git(merger, ["checkout", "-b", "phase-a", "origin/main"]);
      git(merger, ["commit", "--allow-empty", "-m", "phase merge"]);

      git(writer, ["commit", "--allow-empty", "-m", "advance main"]);
      git(writer, ["push", "origin", "main"]);
      const advancedMain = git(writer, ["rev-parse", "HEAD"]);

      const push = spawnSync("git", [
        "push", "origin", "HEAD:refs/heads/main",
        `--force-with-lease=refs/heads/main:${reviewedBase}`
      ], { cwd: merger, encoding: "utf8" });

      expect(push.status).not.toBe(0);
      expect(`${push.stdout}\n${push.stderr}`).toMatch(/stale info|fetch first|rejected/i);
      expect(git(root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(advancedMain);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
