import { z } from "zod";

const sharedEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATA_DIR: z.string().min(1).default("./data")
});

const productionEnvSchema = sharedEnvSchema.extend({
  DATABASE_URL: z.string().min(1),
  DEVKH_MASTER_KEY: z.string().min(1),
  DEVKH_SESSION_SECRET: z.string().min(1)
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
      sessionSecret: parsed.DEVKH_SESSION_SECRET
    };
  }

  const parsed = sharedEnvSchema.parse(env);
  return {
    nodeEnv: mode,
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir: parsed.DATA_DIR
  };
}
