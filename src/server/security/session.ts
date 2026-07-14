import { jwtVerify, SignJWT } from "jose";

const SESSION_DURATION_SECONDS = 8 * 60 * 60;

export interface SessionIdentity {
  adminId: string;
  workspaceId: string;
  sessionVersion?: number;
}

export interface Session extends SessionIdentity {
  expiresAt: Date;
  sessionVersion: number;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(
  identity: SessionIdentity,
  secret: string,
  now = new Date()
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({ workspaceId: identity.workspaceId, sessionVersion: identity.sessionVersion ?? 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(identity.adminId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_DURATION_SECONDS)
    .sign(secretKey(secret));
}

export async function verifySessionToken(
  token: string,
  secret: string,
  now = new Date()
): Promise<Session> {
  const { payload } = await jwtVerify(token, secretKey(secret), { currentDate: now });
  if (!payload.sub || typeof payload.workspaceId !== "string" || !payload.exp
    || (payload.sessionVersion !== undefined
      && (typeof payload.sessionVersion !== "number"
        || !Number.isInteger(payload.sessionVersion)
        || payload.sessionVersion < 1))) {
    throw new Error("Invalid session payload");
  }
  return {
    adminId: payload.sub,
    workspaceId: payload.workspaceId,
    sessionVersion: typeof payload.sessionVersion === "number" ? payload.sessionVersion : 1,
    expiresAt: new Date(payload.exp * 1000)
  };
}
