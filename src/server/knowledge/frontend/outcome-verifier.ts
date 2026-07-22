import { z } from "zod";

const ciOutcomePayloadSchema = z.object({
  repositoryId: z.string().min(1),
  patternGroupId: z.string().min(1),
  evidenceId: z.string().min(1),
  sourceVersion: z.string().min(1),
  outcome: z.enum(["passed", "failed", "rolled_back", "partial"]),
  checks: z.array(z.object({
    name: z.string().min(1).max(240),
    status: z.enum(["passed", "failed", "skipped"])
  }).strict()).max(500),
  reportDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable()
}).strict();

export type VerifiedCiOutcome = z.infer<typeof ciOutcomePayloadSchema>;

export interface CiOutcomeVerificationInput {
  rawBody: Buffer;
  signature: string;
  expectedRepositoryId: string;
  expectedSourceVersion: string;
}

export interface CiOutcomeVerifier {
  verify(input: CiOutcomeVerificationInput): Promise<VerifiedCiOutcome>;
}

/**
 * Deterministic verifier for tests. Production signature verification is deliberately
 * absent until a provider and webhook secret are explicitly authorized.
 */
export class TestCiOutcomeVerifier implements CiOutcomeVerifier {
  constructor(private readonly acceptedSignature: string) {}

  async verify(input: CiOutcomeVerificationInput): Promise<VerifiedCiOutcome> {
    if (input.signature !== this.acceptedSignature) {
      throw new Error("CI outcome signature is invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      throw new Error("CI outcome payload is invalid");
    }
    const parsed = ciOutcomePayloadSchema.safeParse(value);
    if (!parsed.success) throw new Error("CI outcome payload is invalid");
    if (parsed.data.repositoryId !== input.expectedRepositoryId) {
      throw new Error("CI outcome repository does not match");
    }
    if (parsed.data.sourceVersion !== input.expectedSourceVersion) {
      throw new Error("CI outcome source version does not match");
    }
    return parsed.data;
  }
}

export function appliesOutcomeToRecommendation(outcome: {
  authority: "signed_ci" | "admin_confirmed" | "user_reported";
  outcome: "passed" | "failed" | "rolled_back" | "partial";
}): boolean {
  return outcome.authority === "signed_ci" && ["failed", "rolled_back"].includes(outcome.outcome)
    || outcome.authority === "admin_confirmed" && outcome.outcome === "rolled_back";
}
