import { z } from "zod";

import type { SourceBlobCatalog } from "../../persistence/store.js";
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

export class SourceBlobReader {
  constructor(private readonly options: {
    catalog: SourceBlobCatalog;
    blobStore: SourceBlobStore;
  }) {}

  async read(workspaceId: string, value: NormalizedSourceReference): Promise<Buffer> {
    const reference = normalizedSourceReferenceSchema.parse(value);
    const record = await this.options.catalog.findSourceBlobById(workspaceId, reference.sourceBlobId);
    if (!record) throw new Error("Source blob reference is outside the pipeline workspace");
    if (record.contentHash !== reference.blobHash || record.byteSize !== reference.byteSize) {
      throw new Error("Source blob reference does not match persisted metadata");
    }
    return this.options.blobStore.read(record);
  }
}
