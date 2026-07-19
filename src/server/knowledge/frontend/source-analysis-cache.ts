import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  JsonValue,
  SourceAnalysisArtifactKey,
  SourceAnalysisArtifactRecord,
  SourceAnalysisArtifactStore
} from "../../persistence/store.js";

const MAX_SOURCE_ANALYSIS_FACTS_BYTES = 8 * 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const keySchema = z.object({
  workspaceId: z.string().min(1),
  contentHash: digestSchema,
  analyzerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  analyzerVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/),
  parserConfigDigest: digestSchema
}).strict();
const factsSchema = z.record(z.string(), z.json());
const forbiddenContextKeys = new Set([
  "workspaceid", "projectid", "snapshotid", "path", "filepath", "canonicalpath", "sourcepath",
  "sourceref", "sourcerefs"
]);

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertProjectIndependent(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) assertProjectIndependent(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenContextKeys.has(key.toLowerCase())) {
      throw new Error("Source analysis facts must be project-independent");
    }
    assertProjectIndependent(item);
  }
}

function prepareFacts(factsInput: Record<string, unknown>): {
  facts: { [key: string]: JsonValue };
  factsDigest: string;
} {
  const facts = factsSchema.parse(factsInput) as { [key: string]: JsonValue };
  assertProjectIndependent(facts);
  const canonical = canonicalJson(facts);
  if (Buffer.byteLength(canonical, "utf8") > MAX_SOURCE_ANALYSIS_FACTS_BYTES) {
    throw new Error("Source analysis facts exceed 8 MiB");
  }
  return {
    facts,
    factsDigest: createHash("sha256").update(canonical, "utf8").digest("hex")
  };
}

export class SourceAnalysisCache {
  constructor(private readonly store: SourceAnalysisArtifactStore) {}

  async get(keyInput: SourceAnalysisArtifactKey): Promise<Record<string, JsonValue> | null> {
    const key = keySchema.parse(keyInput);
    return (await this.store.findSourceAnalysisArtifact(key))?.facts ?? null;
  }

  async put(
    keyInput: SourceAnalysisArtifactKey,
    factsInput: Record<string, unknown>
  ): Promise<SourceAnalysisArtifactRecord> {
    const key = keySchema.parse(keyInput);
    const prepared = prepareFacts(factsInput);
    return this.store.putSourceAnalysisArtifact({ ...key, ...prepared });
  }

  async getOrCompute(
    key: SourceAnalysisArtifactKey,
    compute: () => Promise<Record<string, unknown>>
  ): Promise<Record<string, JsonValue>> {
    const cached = await this.get(key);
    if (cached) return cached;
    return (await this.put(key, await compute())).facts;
  }
}
