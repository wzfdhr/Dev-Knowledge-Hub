import { createHash } from "node:crypto";

import { z } from "zod";

import { sourceRefSchema } from "./api-contracts.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const unknownReasonSchema = z.enum(["dynamic", "unresolved", "limit", "unsupported", "unsupported_version"]);

function profileValue<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("known"), value: valueSchema }).strict(),
    z.object({ state: z.literal("unknown"), reason: unknownReasonSchema }).strict(),
    z.object({
      state: z.literal("unsupported"),
      reason: z.string().min(1),
      value: valueSchema.optional()
    }).strict()
  ]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sourceProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("git"),
    gitCommitSha: z.string().min(1),
    contentVersion: z.string().min(1),
    ref: z.string().min(1),
    remoteIdentityDigest: z.string().min(1)
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("upload"),
    gitCommitSha: z.null(),
    contentVersion: z.string().min(1),
    ref: z.literal("upload"),
    attestation: z.enum(["unverified", "admin_attested", "git_linked"]),
    linkedGitCommitSha: z.string().min(1).optional(),
    remoteIdentityDigest: z.string().min(1).optional()
  }).strict().superRefine((value, context) => {
    if (value.attestation === "git_linked"
      && (!value.linkedGitCommitSha || !value.remoteIdentityDigest)) {
      context.addIssue({ code: "custom", message: "Git-linked upload provenance is incomplete" });
    }
    if (value.attestation !== "git_linked"
      && (value.linkedGitCommitSha || value.remoteIdentityDigest)) {
      context.addIssue({ code: "custom", message: "Unlinked upload cannot claim Git identity" });
    }
  })
]);

const frameworkSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  supported: z.boolean()
}).strict();

const profilePayloadShape = {
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  sourceProvenance: sourceProvenanceSchema,
  analyzerManifestDigest: digestSchema,
  framework: profileValue(frameworkSchema),
  rendering: profileValue(z.object({
    modes: z.array(z.enum(["csr", "ssr", "ssg", "rsc", "worker", "server"])).min(1)
  }).strict()),
  router: profileValue(z.object({ libraries: z.array(z.string().min(1)), routeCount: z.number().int().nonnegative() }).strict()),
  state: profileValue(z.object({ libraries: z.array(z.string().min(1)), storeCount: z.number().int().nonnegative() }).strict()),
  data: profileValue(z.object({ libraries: z.array(z.string().min(1)), operationCount: z.number().int().nonnegative() }).strict()),
  formLibrary: profileValue(z.object({ libraries: z.array(z.string().min(1)).min(1) }).strict()),
  tooling: profileValue(z.object({ buildTools: z.array(z.string().min(1)), configs: z.array(z.string().min(1)) }).strict()),
  styles: profileValue(z.object({ systems: z.array(z.string().min(1)), tokenCount: z.number().int().nonnegative(), componentLibraries: z.array(z.string().min(1)) }).strict()),
  visualizations: profileValue(z.object({ libraries: z.array(z.string().min(1)), count: z.number().int().nonnegative() }).strict()),
  tests: profileValue(z.object({ tools: z.array(z.string().min(1)), kinds: z.array(z.string().min(1)), caseCount: z.number().int().nonnegative() }).strict()),
  workspace: profileValue(z.object({
    kind: z.enum(["single-package", "monorepo"]),
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "unknown"]),
    packages: z.array(z.string())
  }).strict()),
  sourceRefs: z.array(sourceRefSchema)
};

export const frontendProjectProfilePayloadSchema = z.object(profilePayloadShape).strict();

export function frontendProjectProfileDigest(
  value: z.infer<typeof frontendProjectProfilePayloadSchema>
): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export const frontendProjectProfileSchema = frontendProjectProfilePayloadSchema.extend({
  profileDigest: digestSchema
}).strict().superRefine((value, context) => {
  const { profileDigest, ...payload } = value;
  if (frontendProjectProfileDigest(payload) !== profileDigest) {
    context.addIssue({ code: "custom", message: "frontend project profile digest does not match" });
  }
});

export type SourceProvenanceV1 = z.infer<typeof sourceProvenanceSchema>;
export type FrontendProjectProfile = z.infer<typeof frontendProjectProfileSchema>;
export type FrontendProjectProfilePayload = z.infer<typeof frontendProjectProfilePayloadSchema>;
