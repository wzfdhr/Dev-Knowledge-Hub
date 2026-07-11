import { createHash, randomBytes } from "node:crypto";

import type { AppStore, McpTokenRecord } from "../persistence/store.js";

export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateMcpToken(): string {
  return `dkh_${randomBytes(32).toString("base64url")}`;
}

export async function authenticateMcpToken(
  store: AppStore,
  plaintext: string
): Promise<McpTokenRecord | null> {
  const token = await store.findActiveMcpToken(hashMcpToken(plaintext));
  if (token) void store.touchMcpToken(token.id).catch(() => undefined);
  return token;
}

export function sanitizedMcpToken(token: McpTokenRecord) {
  return {
    id: token.id,
    name: token.name,
    prefix: token.tokenPrefix,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt
  };
}
