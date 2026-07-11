export const APP_NAME = "Dev Knowledge Hub";
export const SERVICE_NAME = "dev-knowledge-hub";
export const APP_VERSION = "0.1.0";

export const BUILD_JOB_STATUSES = [
  "queued",
  "syncing",
  "parsing",
  "synthesizing",
  "validating",
  "ready",
  "published",
  "failed"
] as const;

export const AGENT_FEEDBACK_STATUSES = [
  "open",
  "acknowledged",
  "fixed",
  "dismissed"
] as const;
