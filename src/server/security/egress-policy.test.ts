import { describe, expect, test } from "vitest";

import { assertAllowedGitUrl, GitEgressDeniedError, type GitDnsResolver } from "./egress-policy";

const publicDns: GitDnsResolver = { resolve4: async () => ["8.8.8.8"], resolve6: async () => [] };

describe("Git outbound policy", () => {
  test.each(["https://127.0.0.1/repo.git", "https://[::1]/repo.git", "https://169.254.169.254/repo.git", "https://10.0.0.1/repo.git", "http://example.com/repo.git", "https://user:pass@example.com/repo.git", "https://example.com:8443/repo.git"])("rejects %s", async (value) => {
    await expect(assertAllowedGitUrl(new URL(value), publicDns)).rejects.toBeInstanceOf(GitEgressDeniedError);
  });

  test("rejects DNS answers containing private addresses and accepts only public HTTPS", async () => {
    await expect(assertAllowedGitUrl(new URL("https://example.com/repo.git"), {
      resolve4: async () => ["8.8.8.8", "192.168.0.1"], resolve6: async () => []
    })).rejects.toBeInstanceOf(GitEgressDeniedError);
    await expect(assertAllowedGitUrl(new URL("https://example.com/repo.git"), publicDns)).resolves.toBeUndefined();
  });
});
