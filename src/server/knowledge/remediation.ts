import type { LintIssue } from "../../shared/api-contracts.js";

export type RemediationState = LintIssue["remediationState"];

const transitions: Readonly<Record<RemediationState, readonly RemediationState[]>> = {
  open: ["accepted", "dismissed"],
  accepted: ["rebuilding"],
  rebuilding: ["resolved"],
  resolved: [],
  dismissed: []
};

export function transitionRemediation(current: RemediationState, next: RemediationState): RemediationState {
  if (!transitions[current].includes(next)) throw new Error(`Invalid remediation transition: ${current} -> ${next}`);
  return next;
}
