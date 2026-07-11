import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { RepositoryRecord } from "../persistence/store";
import { prepareRemoteRepository, type GitRunner } from "./remote";

const repository: RepositoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  kind: "git",
  name: "Remote",
  localPath: null,
  cloneUrl: "https://github.com/example/private.git",
  defaultBranch: "main",
  hasCredential: true
};

describe("HTTPS Git authentication", () => {
  test("clones with temporary askpass environment and never credentializes the URL", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-remote-test-"));
    const token = "github_pat_NEVER_IN_ARGUMENTS";
    let askPassPath = "";
    const runner = vi.fn<GitRunner>(async ({ args, env }) => {
      expect(args.join(" ")).not.toContain(token);
      expect(args.join(" ")).toContain(repository.cloneUrl);
      expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env?.DEVKH_GIT_TOKEN).toBe(token);
      askPassPath = env?.GIT_ASKPASS ?? "";
      await expect(access(askPassPath)).resolves.toBeUndefined();
      const target = args.at(-1);
      if (target) await mkdir(path.join(target, ".git"), { recursive: true });
      return Buffer.alloc(0);
    });

    try {
      const target = await prepareRemoteRepository({ repository, dataDir, token, runner });

      expect(target).toBe(path.join(dataDir, "repos", repository.id));
      expect(runner).toHaveBeenCalledOnce();
      await expect(access(askPassPath)).rejects.toThrow();
    } finally {
      await rm(dataDir, { recursive: true });
    }
  });
});
