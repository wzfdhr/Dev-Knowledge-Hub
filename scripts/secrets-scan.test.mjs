import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { scanFileEntries, scanTrackedFiles } from "./secrets-scan.mjs";

const execute = promisify(execFile);
const temporaryDirectories = [];
const privateKeyHeader = (kind = "") => ["-----BEGIN", kind, "PRIVATE KEY-----"]
  .filter(Boolean).join(" ");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("secret scan", () => {
  test.each([
    ["committed environment file", ".env", "DATABASE_URL=placeholder", "committed-env"],
    ["private key", "key.txt", privateKeyHeader("RSA"), "private-key"],
    ["encrypted private key", "key.txt", privateKeyHeader("ENCRYPTED"), "private-key"],
    ["PKCS8 private key", "key.txt", privateKeyHeader(), "private-key"],
    ["OpenSSH private key", "key.txt", privateKeyHeader("OPENSSH"), "private-key"],
    ["EC private key", "key.txt", privateKeyHeader("EC"), "private-key"],
    ["DSA private key", "key.txt", privateKeyHeader("DSA"), "private-key"],
    ["GitHub token", "notes.txt", `ghp_${"A".repeat(36)}`, "github-token"],
    ["OpenAI token", "notes.txt", `sk-proj-${"A".repeat(48)}`, "openai-token"],
    ["Anthropic token", "notes.txt", `sk-ant-${"A".repeat(48)}`, "anthropic-token"],
    ["credentialized remote", "notes.txt", ["https://build-user", "s3cret@example.com/org/repo.git"].join(":"), "remote-credentials"],
    ["token-only remote", "notes.txt", ["https://", "repository-token", "@example.com/org/repo.git"].join(""), "remote-credentials"]
  ])("rejects %s", (_label, file, contents, type) => {
    expect(scanFileEntries([[file, contents]])).toContainEqual({ path: file, type });
  });

  test("allows the documented placeholder environment template", () => {
    expect(scanFileEntries([[".env.example", "DATABASE_URL=postgres://app:password@postgres/app"]]))
      .toEqual([]);
  });

  test.each([
    "https://example.com/org/repo.git",
    "http://example.com/org/repo.git",
    "ssh://git@example.com/org/repo.git",
    "git@example.com:org/repo.git"
  ])("allows credential-free remote %s", (remote) => {
    expect(scanFileEntries([["notes.txt", remote]])).toEqual([]);
  });

  test("scans staged blobs instead of replaced worktree contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-secret-index-"));
    temporaryDirectories.push(root);
    await execute("git", ["init"], { cwd: root });
    const stagedSecret = `ghp_${"S".repeat(36)}`;
    await writeFile(path.join(root, "config.txt"), stagedSecret);
    await execute("git", ["add", "config.txt"], { cwd: root });
    await writeFile(path.join(root, "config.txt"), "clean worktree content");

    expect(await scanTrackedFiles(root)).toContainEqual({
      path: "config.txt",
      type: "github-token"
    });
  });
});
