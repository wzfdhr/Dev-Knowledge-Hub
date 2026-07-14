import type { Pool } from "pg";

export interface SessionRecord {
  idHash: string;
  userId: string;
  workspaceId: string;
  csrfSecretHash: string;
  sessionVersion: number;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionStore {
  create(session: SessionRecord): Promise<void>;
  findActive(idHash: string, now?: Date): Promise<SessionRecord | null>;
  revoke(idHash: string, revokedAt?: Date): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async create(session: SessionRecord): Promise<void> {
    this.sessions.set(session.idHash, { ...session });
  }

  async findActive(idHash: string, now = new Date()): Promise<SessionRecord | null> {
    const session = this.sessions.get(idHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    return { ...session };
  }

  async revoke(idHash: string, revokedAt = new Date()): Promise<void> {
    const session = this.sessions.get(idHash);
    if (session && !session.revokedAt) session.revokedAt = revokedAt;
  }
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async create(session: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_sessions (id_hash, user_id, workspace_id, csrf_secret_hash, session_version, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        session.idHash, session.userId, session.workspaceId, session.csrfSecretHash,
        session.sessionVersion, session.expiresAt, session.revokedAt
      ]
    );
  }

  async findActive(idHash: string, now = new Date()): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<{
      id_hash: string; user_id: string; workspace_id: string; csrf_secret_hash: string; session_version: number; expires_at: Date; revoked_at: Date | null;
    }>(
      `SELECT id_hash, user_id, workspace_id, csrf_secret_hash, session_version, expires_at, revoked_at
       FROM auth_sessions
       WHERE id_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [idHash, now]
    );
    const row = rows[0];
    return row ? {
      idHash: row.id_hash, userId: row.user_id, workspaceId: row.workspace_id, csrfSecretHash: row.csrf_secret_hash,
      sessionVersion: row.session_version, expiresAt: row.expires_at, revokedAt: row.revoked_at
    } : null;
  }

  async revoke(idHash: string, revokedAt = new Date()): Promise<void> {
    await this.pool.query(
      "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id_hash = $1",
      [idHash, revokedAt]
    );
  }
}
