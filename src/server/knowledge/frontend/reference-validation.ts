import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

interface CandidateSourceRef {
  snapshotId: string;
  path: string;
  startLine: number;
  endLine: number;
  blobHash: string;
}

export interface FrontendSourceDescriptor {
  path: string;
  blobHash: string;
  lineCount: number;
}

export async function loadFrontendSourceDescriptors(input: {
  snapshot: { id: string; storagePath: string };
  files: Array<{ path: string; contentHash: string }>;
}): Promise<FrontendSourceDescriptor[]> {
  const root = await fs.realpath(input.snapshot.storagePath);
  const descriptors = await Promise.all(input.files.map(async (file) => {
    const absolute = await fs.realpath(path.resolve(root, file.path)).catch(() => null);
    if (!absolute || (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))) return null;
    const bytes = await fs.readFile(absolute).catch(() => null);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== file.contentHash) return null;
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      path: file.path,
      blobHash: file.contentHash.toLowerCase(),
      lineCount: content.length === 0 ? 1 : Math.max(1,
        content.split(/\r\n|\n|\r/).length - (/\r\n$|\n$|\r$/.test(content) ? 1 : 0))
    };
  }));
  return descriptors.filter((item): item is FrontendSourceDescriptor => item !== null);
}

export function frontendSourceReferenceIsValid(
  reference: CandidateSourceRef,
  snapshotId: string,
  sources: readonly FrontendSourceDescriptor[]
): boolean {
  const source = sources.find((item) => item.path === reference.path);
  return reference.snapshotId === snapshotId
    && Number.isInteger(reference.startLine) && Number.isInteger(reference.endLine)
    && reference.startLine > 0 && reference.endLine >= reference.startLine
    && Boolean(source) && source!.blobHash === reference.blobHash.toLowerCase()
    && reference.endLine <= source!.lineCount;
}
