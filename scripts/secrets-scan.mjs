import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["openai-token", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["anthropic-token", /\bsk-ant-[A-Za-z0-9_-]{32,}\b/],
  ["remote-credentials", /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+\//]
];

function isCommittedEnvironmentFile(file) {
  const name = path.basename(file);
  return name !== ".env.example" && (name === ".env" || name.startsWith(".env."));
}

export function scanFileEntries(entries) {
  const findings = [];
  for (const [file, contents] of entries) {
    if (isCommittedEnvironmentFile(file)) findings.push({ path: file, type: "committed-env" });
    if (contents.includes("\0")) continue;
    for (const [type, pattern] of patterns) {
      if (pattern.test(contents)) findings.push({ path: file, type });
    }
  }
  return findings.sort((left, right) =>
    left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
}

export async function scanTrackedFiles(root = process.cwd()) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  const files = output.split("\0").filter(Boolean);
  const entries = await Promise.all(files.map(async (file) => [
    file,
    await readFile(path.join(root, file), "utf8")
  ]));
  return scanFileEntries(entries);
}

async function main() {
  const findings = await scanTrackedFiles();
  if (findings.length > 0) {
    for (const finding of findings) console.error(`${finding.path}: ${finding.type}`);
    process.exitCode = 1;
    return;
  }
  console.log("Secret scan passed for Git-tracked files.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
