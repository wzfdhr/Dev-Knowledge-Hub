import { createHash, randomBytes } from "node:crypto";

import type { AppStore, WorkspaceMcpTokenRecord } from "../persistence/store.js";

export type WorkspaceMcpAuthenticationFailure =
  | "UNAUTHORIZED"
  | "WORKSPACE_TOKEN_EXPIRED"
  | "WORKSPACE_SESSION_CHANGED";

export function hashWorkspaceMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateWorkspaceMcpToken(): string {
  return `dkhw_${randomBytes(32).toString("base64url")}`;
}

export async function authenticateWorkspaceMcpTokenDetailed(
  store: AppStore,
  plaintext: string,
  now = new Date()
): Promise<{
  token: WorkspaceMcpTokenRecord | null;
  failure: WorkspaceMcpAuthenticationFailure | null;
}> {
  const token = await store.findWorkspaceMcpTokenByHash(hashWorkspaceMcpToken(plaintext));
  if (!token || token.revokedAt !== null) return { token: null, failure: "UNAUTHORIZED" };
  if (token.expiresAt <= now) return { token: null, failure: "WORKSPACE_TOKEN_EXPIRED" };
  const owner = await store.findAdminById(token.userId, token.workspaceId);
  if (!owner || owner.disabledAt !== null || owner.sessionVersion !== token.sessionVersion) {
    return { token: null, failure: "WORKSPACE_SESSION_CHANGED" };
  }
  void store.touchWorkspaceMcpToken(token.id).catch(() => undefined);
  return { token, failure: null };
}

export function createWorkspaceMcpAuthorizationGuard(store: AppStore, plaintext: string) {
  return async (): Promise<boolean> =>
    (await authenticateWorkspaceMcpTokenDetailed(store, plaintext)).token !== null;
}

export function sanitizedWorkspaceMcpToken(token: WorkspaceMcpTokenRecord) {
  return {
    id: token.id, userId: token.userId, name: token.name,
    tokenPrefix: token.tokenPrefix, scopes: token.scopes,
    sessionVersion: token.sessionVersion, expiresAt: token.expiresAt,
    createdAt: token.createdAt, lastUsedAt: token.lastUsedAt, revokedAt: token.revokedAt
  };
}
