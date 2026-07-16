export interface SharedConfig {
  workspace: string;
  retryCount: number;
}

export const sharedConfig: SharedConfig = {
  workspace: "fixture-b",
  retryCount: 3
};

export const retryCount = sharedConfig.retryCount;
