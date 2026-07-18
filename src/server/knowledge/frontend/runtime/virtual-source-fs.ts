import { createHash } from "node:crypto";
import path from "node:path";

export interface VirtualSourceInput {
  path: string;
  contentBase64: string;
  blobHash: string;
}

export interface VirtualSourceLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_VIRTUAL_SOURCE_LIMITS: VirtualSourceLimits = {
  maxFiles: 5_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024
};

function safeVirtualPath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new Error("Virtual source path must be a safe relative POSIX path");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    throw new Error("Virtual source path must be a safe relative POSIX path");
  }
  return normalized;
}

export class VirtualSourceFs {
  readonly #sources = new Map<string, Buffer>();

  constructor(
    sources: readonly VirtualSourceInput[],
    limits: VirtualSourceLimits = DEFAULT_VIRTUAL_SOURCE_LIMITS
  ) {
    if (sources.length > limits.maxFiles) throw new Error("Virtual source file count exceeds limit");
    let totalBytes = 0;
    for (const source of sources) {
      const sourcePath = safeVirtualPath(source.path);
      if (this.#sources.has(sourcePath)) throw new Error("Virtual source contains duplicate path");
      const bytes = Buffer.from(source.contentBase64, "base64");
      if (bytes.byteLength > limits.maxFileBytes) throw new Error("Virtual source exceeds file byte limit");
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.maxTotalBytes) throw new Error("Virtual sources exceed total byte limit");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (!/^[a-f0-9]{64}$/i.test(source.blobHash) || digest !== source.blobHash.toLowerCase()) {
        throw new Error("Virtual source does not match declared blob hash");
      }
      this.#sources.set(sourcePath, bytes);
    }
  }

  paths(): string[] {
    return [...this.#sources.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  }

  readBytes(sourcePath: string): Buffer {
    const bytes = this.#sources.get(safeVirtualPath(sourcePath));
    if (!bytes) throw new Error("Virtual source path is unavailable");
    return Buffer.from(bytes);
  }

  readText(sourcePath: string): string {
    return this.readBytes(sourcePath).toString("utf8");
  }
}
