import { z } from "zod";

const cacheKeySchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  sessionVersion: z.number().int().nonnegative(),
  aclRevision: z.number().int().nonnegative(),
  visibleReleaseSetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  currentProjectId: z.string().min(1),
  currentProjectProfileDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  queryIntentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  experienceSchemaVersion: z.number().int().positive(),
  rankingVersion: z.number().int().positive()
}).strict();

export type ExperienceProjectionCacheKeyInput = z.infer<typeof cacheKeySchema>;

export function experienceProjectionCacheKey(input: ExperienceProjectionCacheKeyInput): string {
  const value = cacheKeySchema.parse(input);
  return [
    value.workspaceId, value.userId, value.sessionVersion, value.aclRevision,
    value.visibleReleaseSetDigest, value.currentProjectId, value.currentProjectProfileDigest,
    value.queryIntentDigest, value.experienceSchemaVersion, value.rankingVersion
  ].join(":");
}

export class ExperienceProjectionCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(options: { capacity: number; ttlMs: number }) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1 || options.capacity > 10_000) {
      throw new Error("Experience projection cache capacity is invalid");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 300_000) {
      throw new Error("Experience projection cache TTL is invalid");
    }
    this.capacity = options.capacity;
    this.ttlMs = options.ttlMs;
  }

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return structuredClone(existing.value);
    }
    if (existing) this.entries.delete(key);
    const value = await loader();
    this.entries.set(key, { value: structuredClone(value), expiresAt: now + this.ttlMs });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return structuredClone(value);
  }

  clear(): void {
    this.entries.clear();
  }
}
