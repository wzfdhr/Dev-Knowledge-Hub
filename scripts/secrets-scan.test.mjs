import { describe, expect, test } from "vitest";

import { scanFileEntries } from "./secrets-scan.mjs";

describe("secret scan", () => {
  test.each([
    ["committed environment file", ".env", "DATABASE_URL=placeholder", "committed-env"],
    ["private key", "key.txt", ["-----BEGIN RSA", " PRIVATE KEY-----"].join(""), "private-key"],
    ["GitHub token", "notes.txt", `ghp_${"A".repeat(36)}`, "github-token"],
    ["OpenAI token", "notes.txt", `sk-proj-${"A".repeat(48)}`, "openai-token"],
    ["Anthropic token", "notes.txt", `sk-ant-${"A".repeat(48)}`, "anthropic-token"],
    ["credentialized remote", "notes.txt", ["https://build-user", "s3cret@example.com/org/repo.git"].join(":"), "remote-credentials"]
  ])("rejects %s", (_label, file, contents, type) => {
    expect(scanFileEntries([[file, contents]])).toContainEqual({ path: file, type });
  });

  test("allows the documented placeholder environment template", () => {
    expect(scanFileEntries([[".env.example", "DATABASE_URL=postgres://app:password@postgres/app"]]))
      .toEqual([]);
  });
});
