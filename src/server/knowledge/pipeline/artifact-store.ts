import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { artifactManifestSchema, buildStageSchema, type ArtifactManifest } from "./contracts.js";
import type { PipelineArtifactStore } from "../../persistence/store.js";

export class ArtifactStoreCancelledError extends Error {
  constructor() {
    super("Artifact write cancelled before manifest commit");
    this.name = "ArtifactStoreCancelledError";
  }
}

export class ArtifactStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreIntegrityError";
  }
}

export interface PutJsonInput {
  manifest: ArtifactManifest;
  value: unknown;
  actorId?: string;
  signal?: AbortSignal;
}

export interface PutJsonResult {
  manifest: ArtifactManifest;
  reused: boolean;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Artifact JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
      if (record[key] === undefined) throw new TypeError(`Artifact JSON cannot contain undefined: ${key}`);
      result[key] = canonicalize(record[key]);
    }
    return result;
  }
  throw new TypeError("Artifact JSON supports only JSON values");
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new ArtifactStoreIntegrityError(`Unsafe artifact ${name}`);
  }
  return value;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArtifactStoreCancelledError();
}

export class ArtifactStore {
  readonly root: string;

  constructor(root: string, private readonly persistence: PipelineArtifactStore) {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  storageKeyFor(manifest: Pick<ArtifactManifest, "projectId" | "snapshotId" | "stage" | "contentDigest">): string {
    const stage = buildStageSchema.parse(manifest.stage);
    const projectId = safeSegment(manifest.projectId, "project id");
    const snapshotId = safeSegment(manifest.snapshotId, "snapshot id");
    if (!/^[a-f0-9]{64}$/.test(manifest.contentDigest)) throw new ArtifactStoreIntegrityError("Unsafe artifact content digest");
    return path.posix.join(projectId, snapshotId, stage, `${manifest.contentDigest}.json`);
  }

  private absolutePath(manifest: ArtifactManifest): string {
    const expected = this.storageKeyFor(manifest);
    if (manifest.storageKey !== expected) throw new ArtifactStoreIntegrityError("Artifact storage key does not match its manifest");
    const absolute = path.resolve(this.root, ...expected.split("/"));
    if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new ArtifactStoreIntegrityError("Artifact path escapes the store");
    return absolute;
  }

  async getJson(manifestInput: ArtifactManifest): Promise<unknown> {
    const manifest = artifactManifestSchema.parse(manifestInput);
    const file = this.absolutePath(manifest);
    let contents: Buffer;
    try {
      contents = await fs.readFile(file);
    } catch {
      throw new ArtifactStoreIntegrityError("Artifact content is unavailable");
    }
    if (sha256(contents) !== manifest.contentDigest) throw new ArtifactStoreIntegrityError("Artifact content digest mismatch");
    try {
      return JSON.parse(contents.toString("utf8"));
    } catch {
      throw new ArtifactStoreIntegrityError("Artifact content is not valid JSON");
    }
  }

  async findReusable(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
    stage: ArtifactManifest["stage"],
    kind: string,
    inputDigest: string
  ): Promise<ArtifactManifest | null> {
    const existing = await this.persistence.findReusableArtifact(
      workspaceId, projectId, snapshotId, stage, kind, inputDigest
    );
    if (!existing) return null;
    await this.getJson(existing);
    return existing;
  }

  async putJson(input: PutJsonInput): Promise<PutJsonResult> {
    abortIfRequested(input.signal);
    const canonical = canonicalJson(input.value);
    const contentDigest = sha256(canonical);
    const candidate = artifactManifestSchema.parse({
      ...input.manifest,
      contentDigest,
      storageKey: this.storageKeyFor({ ...input.manifest, contentDigest })
    });
    const reusable = await this.findReusable(
      candidate.workspaceId, candidate.projectId, candidate.snapshotId,
      candidate.stage, candidate.kind, candidate.inputDigest
    );
    if (reusable) return { manifest: reusable, reused: true };

    const destination = this.absolutePath(candidate);
    const directory = path.dirname(destination);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let wroteDestination = false;
    let temporary: string | null = null;
    try {
      let existing: Buffer | null = null;
      try {
        existing = await fs.readFile(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing && sha256(existing) !== candidate.contentDigest) {
        throw new ArtifactStoreIntegrityError("Artifact path contains conflicting content");
      }
      if (!existing) {
        temporary = path.join(directory, `.${candidate.contentDigest}.${randomUUID()}.tmp`);
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(canonical, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        abortIfRequested(input.signal);
        await fs.rename(temporary, destination);
        temporary = null;
        wroteDestination = true;
      }
      abortIfRequested(input.signal);
      const persisted = await this.persistence.createArtifactWithAudit(candidate, input.actorId);
      return { manifest: persisted, reused: persisted.id !== candidate.id };
    } catch (error) {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined);
      if (wroteDestination) await fs.rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
