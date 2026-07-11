import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AppStore,
  RepositoryRecord,
  SourceFileRecord,
  SourceSnapshotRecord
} from "../persistence/store.js";
import { prepareRemoteRepository, runGit } from "./remote.js";

const MAX_FILE_BYTES = 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next"
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".md", ".json", ".yaml", ".yml"
]);

export class DirtyWorktreeError extends Error {
  readonly code = "DIRTY_WORKTREE";

  constructor(readonly changedPaths: string[]) {
    super("Local repository worktree has uncommitted changes");
    this.name = "DirtyWorktreeError";
  }
}

async function optionalGitText(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit({ cwd, args })).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

function changedPaths(status: Buffer): string[] {
  const entries = status.toString("utf8")
    .split("\0")
    .filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const statusCode = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(statusCode) && entries[index + 1]) {
      paths.push(entries[index + 1]);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

function isCandidate(filePath: string): boolean {
  const segments = filePath.split("/");
  if (segments.some((segment) => SKIPPED_DIRECTORIES.has(segment))) return false;
  if (filePath === ".env") return false;
  if (filePath === ".env.example") return true;

  const basename = path.posix.basename(filePath);
  if (/^package(?:-lock)?\.json$/.test(basename)) return true;
  if (["pnpm-lock.yaml", "yarn.lock"].includes(basename)) return true;
  if (/^tsconfig(?:\.[^.]+)?\.json$/.test(basename)) return true;
  if (/^(?:vitest|jest|playwright|cypress)\.config\.(?:ts|js|tsx|jsx)$/.test(basename)) return true;
  return SOURCE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

function isGenerated(content: Buffer): boolean {
  const header = content.subarray(0, 2048).toString("utf8").toLowerCase();
  return header.includes("@generated")
    || header.includes("generated file")
    || header.includes("do not edit");
}

function languageFor(filePath: string): string | null {
  const extension = path.posix.extname(filePath).toLowerCase();
  return ({
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml"
  } as Record<string, string>)[extension] ?? null;
}

function sanitizeRemoteUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

export interface SnapshotSummary {
  snapshotId: string;
  commitSha: string;
  ref: string;
  fileCount: number;
  unchanged: boolean;
}

export async function syncRepository({
  repository,
  dataDir,
  store,
  token,
  prepareRemote = prepareRemoteRepository
}: {
  repository: RepositoryRecord;
  dataDir: string;
  store: AppStore;
  token?: string;
  prepareRemote?: typeof prepareRemoteRepository;
}): Promise<SnapshotSummary> {
  const repositoryPath = repository.kind === "local"
    ? repository.localPath
    : await prepareRemote({ repository, dataDir, token });
  if (!repositoryPath) throw new Error("Repository path is missing");
  let resolvedRemoteRef: string | null = null;
  if (repository.kind === "local") {
    const status = await runGit({
      cwd: repositoryPath,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    });
    if (status.length > 0) throw new DirtyWorktreeError(changedPaths(status));
  } else {
    resolvedRemoteRef = await optionalGitText(repositoryPath, [
      "symbolic-ref", "--short", "refs/remotes/origin/HEAD"
    ]) ?? `origin/${repository.defaultBranch}`;
    await runGit({ cwd: repositoryPath, args: ["checkout", "--detach", resolvedRemoteRef] });
  }

  const commitSha = (await runGit({ cwd: repositoryPath, args: ["rev-parse", "HEAD"] }))
    .toString("utf8").trim();
  const existing = await store.findSnapshotByCommit(
    repository.workspaceId,
    repository.id,
    commitSha
  );
  if (existing) {
    return {
      snapshotId: existing.id,
      commitSha,
      ref: existing.ref,
      fileCount: await store.countSnapshotFiles(existing.id),
      unchanged: true
    };
  }

  const ref = resolvedRemoteRef
    ?? await optionalGitText(repositoryPath, ["symbolic-ref", "--short", "HEAD"])
    ?? commitSha;
  const remoteUrl = sanitizeRemoteUrl(
    repository.kind === "git"
      ? repository.cloneUrl
      : await optionalGitText(repositoryPath, ["config", "--get", "remote.origin.url"])
  );
  const commitTimestamp = new Date(
    (await runGit({ cwd: repositoryPath, args: ["show", "-s", "--format=%cI", commitSha] }))
      .toString("utf8").trim()
  );
  const tracked = (await runGit({ cwd: repositoryPath, args: ["ls-files", "-z"] }))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter(isCandidate)
    .sort();

  const snapshotId = randomUUID();
  const storagePath = path.join(dataDir, "snapshots", snapshotId);
  const files: SourceFileRecord[] = [];
  for (const filePath of tracked) {
    const content = await runGit({ cwd: repositoryPath, args: ["show", `${commitSha}:${filePath}`] });
    if (content.length > MAX_FILE_BYTES || content.includes(0) || isGenerated(content)) continue;

    const outputPath = path.join(storagePath, "files", ...filePath.split("/"));
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, { flag: "wx" });
    files.push({
      id: randomUUID(),
      workspaceId: repository.workspaceId,
      snapshotId,
      path: filePath,
      byteSize: content.length,
      contentHash: createHash("sha256").update(content).digest("hex"),
      language: languageFor(filePath)
    });
  }

  const snapshot: SourceSnapshotRecord = {
    id: snapshotId,
    workspaceId: repository.workspaceId,
    repositoryId: repository.id,
    commitSha,
    ref,
    remoteUrl,
    commitTimestamp,
    storagePath
  };
  await store.createSnapshot({ snapshot, files });
  return { snapshotId, commitSha, ref, fileCount: files.length, unchanged: false };
}
