import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const executeFile = promisify(execFile);
const requiredChecks = ["verify", "container-smoke"];

async function executeGh(args) {
  const result = await executeFile("gh", args, { encoding: "utf8" });
  return result.stdout;
}

export function parseMergeArguments(args) {
  const pullRequest = Number(args.find((argument) => /^\d+$/.test(argument)));
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) {
    throw new Error("A positive pull request number is required");
  }
  const userApproved = args.includes("--user-approved");
  if (!userApproved) {
    throw new Error("The --user-approved flag is required after explicit user confirmation");
  }
  const approvedHeadIndex = args.indexOf("--approved-head");
  const approvedHead = approvedHeadIndex >= 0 ? args[approvedHeadIndex + 1] : undefined;
  if (!approvedHead) {
    throw new Error("The --approved-head value is required to bind confirmation to the reviewed commit");
  }
  if (!/^[a-f0-9]{40}$/i.test(approvedHead)) {
    throw new Error("The approved head must be a 40-character Git commit SHA");
  }
  return { pullRequest, userApproved, approvedHead: approvedHead.toLowerCase() };
}

export function assertMergeReady(pullRequest, approvedHead) {
  if (pullRequest.isDraft) throw new Error(`PR #${pullRequest.number} is still a Draft`);
  if (pullRequest.baseRefName !== "main") {
    throw new Error(`PR #${pullRequest.number} must target main`);
  }
  if (pullRequest.headRefOid !== approvedHead) {
    throw new Error(`PR #${pullRequest.number} changed after user approval`);
  }
  for (const name of requiredChecks) {
    const check = pullRequest.statusCheckRollup.find((candidate) =>
      (candidate.name ?? candidate.context) === name);
    if (!check) throw new Error(`Required check ${name} is missing`);
    if (check.status !== "COMPLETED" || check.conclusion !== "SUCCESS") {
      throw new Error(`Required check ${name} is not successful`);
    }
  }
}

export async function mergeVerifiedPullRequest(input, options = {}) {
  if (!input.userApproved) throw new Error("Explicit user confirmation is required");
  if (!/^[a-f0-9]{40}$/i.test(input.approvedHead ?? "")) {
    throw new Error("A valid approved head commit is required");
  }
  const execute = options.execute ?? executeGh;
  const fields = "number,isDraft,baseRefName,headRefName,headRefOid,statusCheckRollup";
  const raw = await execute(["pr", "view", String(input.pullRequest), "--json", fields]);
  const pullRequest = JSON.parse(raw);
  assertMergeReady(pullRequest, input.approvedHead.toLowerCase());
  await execute([
    "pr", "merge", String(input.pullRequest), "--merge", "--delete-branch",
    "--match-head-commit", input.approvedHead.toLowerCase()
  ]);
}

export async function main(args = process.argv.slice(2)) {
  await mergeVerifiedPullRequest(parseMergeArguments(args));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
