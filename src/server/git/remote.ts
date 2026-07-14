import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import type { RepositoryRecord } from "../persistence/store.js";
import { assertAllowedGitUrl } from "../security/egress-policy.js";

export interface GitRunOptions {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export type GitRunner = (options: GitRunOptions) => Promise<Buffer>;

function gitChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  for (const key of Object.keys(childEnvironment)) {
    if (/^GIT_CONFIG(?:$|_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$)/.test(key)) {
      delete childEnvironment[key];
    }
  }
  return childEnvironment;
}

export const runGit: GitRunner = ({ cwd, args, env }) => new Promise((resolve, reject) => {
  execFile(
    "git",
    args,
    {
      cwd,
      env: gitChildEnvironment({ ...process.env, ...env }),
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024
    },
    (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    }
  );
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function prepareRemoteRepository({
  repository,
  dataDir,
  token,
  runner = runGit,
  environment = process.env,
  assertEgress = assertAllowedGitUrl
}: {
  repository: RepositoryRecord;
  dataDir: string;
  token?: string;
  runner?: GitRunner;
  environment?: NodeJS.ProcessEnv;
  assertEgress?: typeof assertAllowedGitUrl;
}): Promise<string> {
  if (repository.kind !== "git" || !repository.cloneUrl) {
    throw new Error("Remote repository metadata is invalid");
  }
  const parsedUrl = new URL(repository.cloneUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
    throw new Error("Remote repository must use a credential-free HTTPS URL");
  }
  await assertEgress(parsedUrl);

  const repositoriesDir = path.join(dataDir, "repos");
  const target = path.join(repositoriesDir, repository.id);
  await mkdir(repositoriesDir, { recursive: true });
  const askPassPath = process.env.DEVKH_GIT_ASKPASS_PATH
    ?? path.resolve(process.cwd(), "scripts/git-askpass.sh");
  await access(askPassPath, fsConstants.X_OK);
  const env = gitChildEnvironment({
    ...environment,
    GIT_ASKPASS: askPassPath,
    GIT_ASKPASS_REQUIRE: "force",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    DEVKH_GIT_TOKEN: token ?? ""
  });
  const credentialIsolation = ["-c", "credential.helper="];
  const redirectIsolation = ["-c", "http.followRedirects=false"];

  // Resolve immediately before network I/O as a DNS-rebinding defense.
  await assertEgress(parsedUrl);

  if (await exists(path.join(target, ".git"))) {
    await runner({
      cwd: target,
      args: [...credentialIsolation, ...redirectIsolation, "fetch", "--prune", "origin"],
      env
    });
  } else {
    await runner({
      cwd: repositoriesDir,
      args: [...credentialIsolation, ...redirectIsolation, "clone", "--no-checkout", repository.cloneUrl, target],
      env
    });
  }
  return target;
}
