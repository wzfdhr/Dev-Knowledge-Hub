import { z } from "zod";

import type { SourceBlobCatalog, SourceFileRecord } from "../../persistence/store.js";
import type { SourceBlobStore } from "../../uploads/source-blob-store.js";

export const normalizedSourceReferenceSchema = z.object({
  snapshotId: z.string().min(1),
  path: z.string().min(1),
  sourceBlobId: z.string().min(1),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/u),
  byteSize: z.number().int().nonnegative(),
  language: z.string().nullable()
}).strict();

export const normalizedSourceReferencesSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotId: z.string().min(1),
  sources: z.array(normalizedSourceReferenceSchema)
}).strict();

export type NormalizedSourceReference = z.infer<typeof normalizedSourceReferenceSchema>;

type SourceBlobReadCatalog = SourceBlobCatalog & {
  findSourceFile(workspaceId: string, snapshotId: string, path: string): Promise<SourceFileRecord | null>;
};

export class SourceBlobReader {
  constructor(private readonly options: {
    catalog: SourceBlobReadCatalog;
    blobStore: SourceBlobStore;
  }) {}

  async read(workspaceId: string, value: NormalizedSourceReference): Promise<Buffer> {
    const reference = normalizedSourceReferenceSchema.parse(value);
    const record = await this.options.catalog.findSourceBlobById(workspaceId, reference.sourceBlobId);
    if (!record) throw new Error("Source blob reference is outside the pipeline workspace");
    if (record.contentHash !== reference.blobHash || record.byteSize !== reference.byteSize) {
      throw new Error("Source blob reference does not match persisted metadata");
    }
    const sourceFile = await this.options.catalog.findSourceFile(
      workspaceId,
      reference.snapshotId,
      reference.path
    );
    if (!sourceFile
      || sourceFile.sourceBlobId !== reference.sourceBlobId
      || sourceFile.contentHash !== reference.blobHash
      || sourceFile.byteSize !== reference.byteSize) {
      throw new Error("Source blob reference is not bound to the declared snapshot path");
    }
    return this.options.blobStore.read(record);
  }
}
