export const FRONTEND_KNOWLEDGE_MODES = ["legacy", "shadow", "active"] as const;
export type FrontendKnowledgeMode = (typeof FRONTEND_KNOWLEDGE_MODES)[number];

const modeRank: Record<FrontendKnowledgeMode, number> = {
  legacy: 0,
  shadow: 1,
  active: 2
};

export function validateFrontendModeConfiguration(input: {
  kernelMode: FrontendKnowledgeMode;
  systemMode: FrontendKnowledgeMode;
}): void {
  if (modeRank[input.systemMode] > modeRank[input.kernelMode]) {
    throw new Error("Frontend knowledge mode exceeds knowledge kernel mode");
  }
}

export function effectiveFrontendKnowledgeMode(input: {
  kernelMode: FrontendKnowledgeMode;
  systemMode: FrontendKnowledgeMode;
  projectMode?: FrontendKnowledgeMode;
}): FrontendKnowledgeMode {
  validateFrontendModeConfiguration(input);
  const requested = input.projectMode ?? "legacy";
  return modeRank[requested] > modeRank[input.systemMode] ? input.systemMode : requested;
}

export function validateProjectFrontendMode(input: {
  kernelMode: FrontendKnowledgeMode;
  systemMode: FrontendKnowledgeMode;
  projectMode: FrontendKnowledgeMode;
}): void {
  validateFrontendModeConfiguration(input);
  if (modeRank[input.projectMode] > modeRank[input.systemMode]) {
    throw new Error("Project frontend knowledge mode exceeds frontend system mode");
  }
}
