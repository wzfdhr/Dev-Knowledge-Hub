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
  const { token } = await authenticateMcpTokenDetailed(store, plaintext);
  return token;
}

export async function authenticateMcpTokenDetailed(
  store: AppStore,
  plaintext: string,
  now = new Date()
): Promise<{ token: McpTokenRecord | null; expired: boolean }> {
  const token = await store.findActiveMcpToken(hashMcpToken(plaintext));
  if (token?.expiresAt && token.expiresAt <= now) return { token: null, expired: true };
  if (token) void store.touchMcpToken(token.id).catch(() => undefined);
  return { token, expired: false };
}

export function createMcpAuthorizationGuard(store: AppStore, plaintext: string) {
  return async (): Promise<boolean> => Boolean(await authenticateMcpToken(store, plaintext));
}

export function sanitizedMcpToken(token: McpTokenRecord) {
  return {
    id: token.id,
    projectId: token.projectId,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt
  };
}
