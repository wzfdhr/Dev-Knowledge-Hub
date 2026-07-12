import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test, vi } from "vitest";

import type { RepositoryRecord } from "../persistence/store";
import { prepareRemoteRepository, type GitRunner } from "./remote";

const execute = promisify(execFile);

function executeWithInput(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env: options.env }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.end(options.input);
  });
}

const repository: RepositoryRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  kind: "git",
  name: "Remote",
  localPath: null,
  cloneUrl: "https://github.com/example/private.git",
  defaultBranch: "main",
  archivedAt: null,
  hasCredential: true
};

describe("HTTPS Git authentication", () => {
  test("uses the static askpass helper when temporary files are non-executable", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-remote-test-"));
    const token = "test-token-never-in-arguments";
    let askPassPath = "";
    const runner = vi.fn<GitRunner>(async ({ args, env }) => {
      expect(args.join(" ")).not.toContain(token);
      expect(args.join(" ")).toContain(repository.cloneUrl);
      expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env?.DEVKH_GIT_TOKEN).toBe(token);
      askPassPath = env?.GIT_ASKPASS ?? "";
      expect(askPassPath).toMatch(/scripts\/git-askpass\.sh$/);
      expect(askPassPath.startsWith(os.tmpdir())).toBe(false);
      await expect(access(askPassPath)).resolves.toBeUndefined();
      const username = await execute(askPassPath, ["Username for https://example.com"], { env });
      const password = await execute(askPassPath, ["Password for https://example.com"], { env });
      expect(username.stdout.trim()).toBe("x-access-token");
      expect(password.stdout.trim()).toBe(token);
      const target = args.at(-1);
      if (target) await mkdir(path.join(target, ".git"), { recursive: true });
      return Buffer.alloc(0);
    });

    try {
      const target = await prepareRemoteRepository({ repository, dataDir, token, runner });

      expect(target).toBe(path.join(dataDir, "repos", repository.id));
      expect(runner).toHaveBeenCalledOnce();
      await expect(access(askPassPath)).resolves.toBeUndefined();
      expect(await readFile(askPassPath, "utf8")).not.toContain(token);
    } finally {
      await rm(dataDir, { recursive: true });
    }
  });

  test("isolates Git from inherited credential helpers", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-remote-helper-test-"));
    const homeDir = path.join(dataDir, "home");
    const markerPath = path.join(dataDir, "credential-helper-called");
    const helperPath = path.join(dataDir, "recording-helper.sh");
    const token = "test-token-only-reaches-askpass";

    await mkdir(homeDir, { recursive: true });
    await writeFile(helperPath, `#!/bin/sh\nprintf '%s' "$DEVKH_GIT_TOKEN" > ${JSON.stringify(markerPath)}\n`);
    await chmod(helperPath, 0o700);
    await writeFile(path.join(homeDir, ".gitconfig"), [
      "[credential]",
      `\thelper = ${helperPath}`,
      ""
    ].join("\n"));

    const runner = vi.fn<GitRunner>(async ({ args, env }) => {
      expect(args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
      expect(env).toMatchObject({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: homeDir,
        DEVKH_GIT_TOKEN: token
      });
      expect(env?.GIT_CONFIG).toBeUndefined();
      expect(env?.GIT_CONFIG_COUNT).toBeUndefined();
      expect(env?.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(env?.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(env?.GIT_CONFIG_PARAMETERS).toBeUndefined();

      await executeWithInput("git", [
        ...args.slice(0, 2),
        "credential",
        "fill"
      ], {
        env,
        input: "protocol=https\nhost=github.com\n\n"
      });

      const target = args.at(-1);
      if (target) await mkdir(path.join(target, ".git"), { recursive: true });
      return Buffer.alloc(0);
    });

    try {
      await prepareRemoteRepository({
        repository,
        dataDir,
        token,
        runner,
        environment: {
          ...process.env,
          HOME: homeDir,
          GIT_CONFIG: path.join(homeDir, ".gitconfig"),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: helperPath,
          GIT_CONFIG_PARAMETERS: `'credential.helper=${helperPath}'`
        }
      });

      await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
