import { z } from "zod";

const masterKeySchema = z.string().refine((value) => {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}, "Master key must be exactly 32 bytes encoded as base64");

const publicBaseUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "PUBLIC_BASE_URL must be an HTTPS URL without credentials");

const legacySessionReadUntilSchema = z.string().datetime({ offset: true })
  .refine((value) => new Date(value).getTime() <= Date.now() + 24 * 60 * 60 * 1_000,
    "DEVKH_LEGACY_SESSION_READ_UNTIL must be within 24 hours")
  .transform((value) => new Date(value));

const sharedEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATA_DIR: z.string().min(1).default("./data"),
  DATABASE_URL: z.string().min(1).optional(),
  DEVKH_MASTER_KEY: masterKeySchema.optional(),
  DEVKH_SESSION_SECRET: z.string().min(1).optional(),
  PUBLIC_BASE_URL: publicBaseUrlSchema.optional(),
  DEVKH_LEGACY_SESSION_READ_UNTIL: legacySessionReadUntilSchema.optional(),
  KNOWLEDGE_PIPELINE_V2: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
});

const productionEnvSchema = sharedEnvSchema.extend({
  DATABASE_URL: z.string().min(1),
  DEVKH_MASTER_KEY: masterKeySchema,
  DEVKH_SESSION_SECRET: z.string().min(32, "Session secret must be at least 32 characters")
});

export type EnvironmentMode = "development" | "production" | "test";

export interface AppEnv {
  nodeEnv: EnvironmentMode;
  host: string;
  port: number;
  dataDir: string;
  databaseUrl?: string;
  masterKey?: string;
  sessionSecret?: string;
  publicBaseUrl?: string;
  legacySessionReadUntil?: Date;
  knowledgePipelineV2: boolean;
}

export function loadEnv({
  mode,
  env
}: {
  mode: EnvironmentMode;
  env: NodeJS.ProcessEnv;
}): AppEnv {
  if (mode === "production") {
    const parsed = productionEnvSchema.parse(env);
    return {
      nodeEnv: mode,
      host: parsed.HOST,
      port: parsed.PORT,
      dataDir: parsed.DATA_DIR,
      databaseUrl: parsed.DATABASE_URL,
      masterKey: parsed.DEVKH_MASTER_KEY,
      sessionSecret: parsed.DEVKH_SESSION_SECRET,
      publicBaseUrl: parsed.PUBLIC_BASE_URL,
      legacySessionReadUntil: parsed.DEVKH_LEGACY_SESSION_READ_UNTIL,
      knowledgePipelineV2: parsed.KNOWLEDGE_PIPELINE_V2
    };
  }

  const parsed = sharedEnvSchema.parse(env);
  return {
    nodeEnv: mode,
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir: parsed.DATA_DIR,
    databaseUrl: parsed.DATABASE_URL,
    masterKey: parsed.DEVKH_MASTER_KEY,
    sessionSecret: parsed.DEVKH_SESSION_SECRET,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    legacySessionReadUntil: parsed.DEVKH_LEGACY_SESSION_READ_UNTIL,
    knowledgePipelineV2: parsed.KNOWLEDGE_PIPELINE_V2
  };
}
