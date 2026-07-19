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

export type FrontendSourceDescriptors = ReadonlyMap<string, FrontendSourceDescriptor>;

const SOURCE_VALIDATION_CONCURRENCY = 4;

function physicalLineCount(content: string): number {
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") lines += 1;
    else if (content[index] === "\r") {
      lines += 1;
      if (content[index + 1] === "\n") index += 1;
    }
  }
  return Math.max(1, lines - (/\r\n$|\n$|\r$/u.test(content) ? 1 : 0));
}

export async function loadFrontendSourceDescriptors(input: {
  snapshot: { id: string; storagePath: string };
  files: Array<{ path: string; contentHash: string }>;
}): Promise<FrontendSourceDescriptors> {
  const root = await fs.realpath(input.snapshot.storagePath);
  const descriptors = new Map<string, FrontendSourceDescriptor>();
  let cursor = 0;
  const validateNext = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      const file = input.files[index];
      if (!file) return;
      const absolute = await fs.realpath(path.resolve(root, file.path)).catch(() => null);
      if (!absolute || (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))) continue;
      const bytes = await fs.readFile(absolute).catch(() => null);
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== file.contentHash) continue;
      const content = (() => {
        try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
      })();
      if (content === null) continue;
      descriptors.set(file.path, {
        path: file.path,
        blobHash: file.contentHash.toLowerCase(),
        lineCount: physicalLineCount(content)
      });
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(SOURCE_VALIDATION_CONCURRENCY, input.files.length) },
    () => validateNext()
  ));
  return descriptors;
}

export function frontendSourceReferenceIsValid(
  reference: CandidateSourceRef,
  snapshotId: string,
  sources: FrontendSourceDescriptors
): boolean {
  const source = sources.get(reference.path);
  return reference.snapshotId === snapshotId
    && Number.isInteger(reference.startLine) && Number.isInteger(reference.endLine)
    && reference.startLine > 0 && reference.endLine >= reference.startLine
    && Boolean(source) && source!.blobHash === reference.blobHash.toLowerCase()
    && reference.endLine <= source!.lineCount;
}
