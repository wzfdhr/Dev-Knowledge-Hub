import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { filterImportFile, importLanguageForPath } from "../../shared/import-filter.js";

import type {
  AppStore,
  GitSynchronizationLease,
  RepositoryRecord,
  SourceFileRecord,
  SourceSnapshotRecord
} from "../persistence/store.js";
import type { SourceBlobStore } from "../uploads/source-blob-store.js";
import { removeReadOnlyTree } from "../uploads/folder-import.js";
import { prepareRemoteRepository, runGit } from "./remote.js";

const repositorySyncs = new Map<string, Promise<void>>();

export class DirtyWorktreeError extends Error {
  readonly code = "DIRTY_WORKTREE";

  constructor(readonly changedPaths: string[]) {
    super("Local repository worktree has uncommitted changes");
    this.name = "DirtyWorktreeError";
  }
}

export class GitSynchronizationLeaseExpiredError extends Error {
  readonly code = "SCHEDULED_SYNC_LEASE_EXPIRED";

  constructor() {
    super("Git synchronization lease expired before the snapshot could be persisted");
    this.name = "GitSynchronizationLeaseExpiredError";
  }
}

async function optionalGitText(cwd: string, args: string[], timeoutMs?: number): Promise<string | null> {
  try {
    return (await runGit({ cwd, args, timeoutMs })).toString("utf8").trim() || null;
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
  textBytes: number;
  ignored: { total: number; reasons: Record<string, number> };
  unchanged: boolean;
}

function recordIgnored(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

async function withRepositorySync<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = repositorySyncs.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  repositorySyncs.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repositorySyncs.get(key) === queued) repositorySyncs.delete(key);
  }
}

async function syncRepositoryUnlocked({
  repository,
  dataDir,
  store,
  token,
  actorId,
  prepareRemote = prepareRemoteRepository,
  gitTimeoutMs,
  gitSynchronizationLease,
  sourceStorageMode = "legacy",
  sourceBlobStore
}: {
  repository: RepositoryRecord;
  dataDir: string;
  store: AppStore;
  token?: string;
  actorId?: string;
  prepareRemote?: typeof prepareRemoteRepository;
  gitTimeoutMs?: number;
  gitSynchronizationLease?: GitSynchronizationLease;
  sourceStorageMode?: "legacy" | "shadow" | "active";
  sourceBlobStore?: SourceBlobStore;
}): Promise<SnapshotSummary> {
  const repositoryPath = repository.kind === "local"
    ? repository.localPath
    : await prepareRemote({ repository, dataDir, token, timeoutMs: gitTimeoutMs });
  if (!repositoryPath) throw new Error("Repository path is missing");
  let resolvedRemoteRef: string | null = null;
  if (repository.kind === "local") {
    const status = await runGit({
      cwd: repositoryPath,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      timeoutMs: gitTimeoutMs
    });
    if (status.length > 0) throw new DirtyWorktreeError(changedPaths(status));
  } else {
    resolvedRemoteRef = await optionalGitText(repositoryPath, [
      "symbolic-ref", "--short", "refs/remotes/origin/HEAD"
    ], gitTimeoutMs) ?? `origin/${repository.defaultBranch}`;
    await runGit({ cwd: repositoryPath, args: ["checkout", "--detach", resolvedRemoteRef], timeoutMs: gitTimeoutMs });
  }

  const commitSha = (await runGit({ cwd: repositoryPath, args: ["rev-parse", "HEAD"], timeoutMs: gitTimeoutMs }))
    .toString("utf8").trim();
  const existing = await store.findSnapshotByCommit(
    repository.workspaceId,
    repository.id,
    commitSha
  );
  if (existing) {
    if (actorId) {
      await store.recordAudit({
        workspaceId: repository.workspaceId,
        actorId,
        action: "repository.sync_succeeded",
        resourceType: "repository",
        resourceId: repository.id,
        metadata: { commitSha, unchanged: true }
      });
    }
    return {
      snapshotId: existing.id,
      commitSha,
      ref: existing.ref,
      fileCount: await store.countSnapshotFiles(existing.id),
      textBytes: await store.snapshotTextBytes(existing.id),
      ignored: { total: 0, reasons: {} },
      unchanged: true
    };
  }

  const ref = resolvedRemoteRef
    ?? await optionalGitText(repositoryPath, ["symbolic-ref", "--short", "HEAD"], gitTimeoutMs)
    ?? commitSha;
  const remoteUrl = sanitizeRemoteUrl(
    repository.kind === "git"
      ? repository.cloneUrl
      : await optionalGitText(repositoryPath, ["config", "--get", "remote.origin.url"])
  );
  const commitTimestamp = new Date(
    (await runGit({ cwd: repositoryPath, args: ["show", "-s", "--format=%cI", commitSha], timeoutMs: gitTimeoutMs }))
      .toString("utf8").trim()
  );
  const tracked = (await runGit({ cwd: repositoryPath, args: ["ls-files", "-z"], timeoutMs: gitTimeoutMs }))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();

  const snapshotId = randomUUID();
  const snapshotDirectory = path.join(dataDir, "snapshots", snapshotId);
  const files: SourceFileRecord[] = [];
  const linkedFiles: Array<{
    path: string;
    blob: Awaited<ReturnType<SourceBlobStore["put"]>>["record"];
  }> = [];
  const ignoredReasons: Record<string, number> = {};
  for (const filePath of tracked) {
    const byteSize = Number((await runGit({
      cwd: repositoryPath,
      args: ["cat-file", "-s", `${commitSha}:${filePath}`],
      timeoutMs: gitTimeoutMs
    })).toString("utf8").trim());
    if (!Number.isSafeInteger(byteSize)) {
      recordIgnored(ignoredReasons, "file_too_large");
      continue;
    }
    const pathDecision = filterImportFile({ path: filePath, byteSize });
    if (!pathDecision.accepted) {
      recordIgnored(ignoredReasons, pathDecision.reason);
      continue;
    }

    const content = await runGit({
      cwd: repositoryPath,
      args: ["show", `${commitSha}:${filePath}`],
      timeoutMs: gitTimeoutMs
    });
    const contentDecision = filterImportFile({ path: filePath, byteSize, content });
    if (!contentDecision.accepted) {
      recordIgnored(ignoredReasons, contentDecision.reason);
      continue;
    }

    let sourceBlobId: string | null = null;
    if (sourceStorageMode === "legacy") {
      const outputPath = path.join(snapshotDirectory, "files", ...filePath.split("/"));
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content, { flag: "wx" });
    } else {
      if (!sourceBlobStore) throw new Error("Source blob storage is unavailable");
      const { record } = await sourceBlobStore.put({ workspaceId: repository.workspaceId, bytes: content });
      sourceBlobId = record.id;
      linkedFiles.push({ path: filePath, blob: record });
    }
    files.push({
      id: randomUUID(),
      workspaceId: repository.workspaceId,
      snapshotId,
      path: filePath,
      byteSize: content.length,
      contentHash: createHash("sha256").update(content).digest("hex"),
      language: importLanguageForPath(filePath),
      sourceBlobId
    });
  }

  const storagePath = sourceStorageMode === "legacy"
    ? path.join(snapshotDirectory, "files")
    : await sourceBlobStore!.materializeSnapshotView({
        workspaceId: repository.workspaceId,
        snapshotId,
        files: linkedFiles
      });

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
  let persisted: SourceSnapshotRecord;
  try {
    const written = gitSynchronizationLease
      ? await store.createSnapshotWithGitSynchronizationLease({ snapshot, files }, gitSynchronizationLease)
      : actorId
        ? await store.createSnapshotWithAudit({ snapshot, files }, actorId)
        : await store.createSnapshot({ snapshot, files });
    if (!written) throw new GitSynchronizationLeaseExpiredError();
    persisted = written;
  } catch (error) {
    await removeReadOnlyTree(path.dirname(storagePath)).catch(() => undefined);
    throw error;
  }
  if (persisted.id !== snapshot.id) {
    await removeReadOnlyTree(path.dirname(storagePath)).catch(() => undefined);
    return {
      snapshotId: persisted.id,
      commitSha: persisted.commitSha,
      ref: persisted.ref,
      fileCount: await store.countSnapshotFiles(persisted.id),
      textBytes: await store.snapshotTextBytes(persisted.id),
      ignored: { total: 0, reasons: {} },
      unchanged: true
    };
  }
  const textBytes = files.reduce((total, file) => total + file.byteSize, 0);
  return {
    snapshotId,
    commitSha,
    ref,
    fileCount: files.length,
    textBytes,
    ignored: {
      total: Object.values(ignoredReasons).reduce((total, count) => total + count, 0),
      reasons: ignoredReasons
    },
    unchanged: false
  };
}

export function syncRepository(
  options: Parameters<typeof syncRepositoryUnlocked>[0]
): Promise<SnapshotSummary> {
  const key = `${options.repository.workspaceId}:${options.repository.id}`;
  return withRepositorySync(key, () => syncRepositoryUnlocked(options));
}
