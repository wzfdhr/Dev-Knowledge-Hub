import { createHash } from "node:crypto";

import type { BuildStage } from "./contracts.js";
import { canonicalJson } from "./artifact-store.js";

export const PIPELINE_VERSION = 1;

type DigestPurpose =
  | { kind: "standard"; feedbackIds?: readonly string[]; remediationIds?: readonly string[] }
  | { kind: "feedback"; feedbackIds: readonly string[]; remediationIds?: readonly string[] }
  | { kind: "remediation"; feedbackIds?: readonly string[]; remediationIds: readonly string[] };

export function pipelineInputDigest(input: {
  stage: BuildStage;
  snapshotId: string;
  upstreamManifestIds: readonly string[];
  parserConfigVersion: string;
  purpose: DigestPurpose;
}): string {
  const purpose = {
    kind: input.purpose.kind,
    feedbackIds: [...(input.purpose.feedbackIds ?? [])].sort(),
    remediationIds: [...(input.purpose.remediationIds ?? [])].sort()
  };
  return createHash("sha256").update(canonicalJson({
    pipelineVersion: PIPELINE_VERSION,
    stage: input.stage,
    snapshotId: input.snapshotId,
    upstreamManifestIds: [...input.upstreamManifestIds].sort(),
    parserConfigVersion: input.parserConfigVersion,
    purpose
  })).digest("hex");
}
