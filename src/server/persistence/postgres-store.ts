import type { Pool, QueryResultRow } from "pg";

import type {
  AdminRecord,
  AppStore,
  AuditEventInput,
  CreateSnapshotInput,
  RepositoryConnectionInput,
  RepositoryRecord,
  SetupResult,
  SourceSnapshotRecord,
  WorkspaceRecord
} from "./store.js";

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface RepositoryRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  kind: "local" | "git";
  name: string;
  local_path: string | null;
  clone_url: string | null;
  default_branch: string;
  has_credential: boolean;
}

interface SnapshotRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  ref: string;
  remote_url: string | null;
  commit_timestamp: Date;
  storage_path: string;
}

function repositoryRecord(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    localPath: row.local_path,
    cloneUrl: row.clone_url,
    defaultBranch: row.default_branch,
    hasCredential: row.has_credential
  };
}

function snapshotRecord(row: SnapshotRow): SourceSnapshotRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    commitSha: row.commit_sha,
    ref: row.ref,
    remoteUrl: row.remote_url,
    commitTimestamp: row.commit_timestamp,
    storagePath: row.storage_path
  };
}

export class PostgresAppStore implements AppStore {
  constructor(private readonly pool: Pool & Queryable) {}

  async isSetupComplete(): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM admin_users) AS exists"
    );
    return rows[0]?.exists ?? false;
  }

  async createInitialSetup(email: string, passwordHash: string): Promise<SetupResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('devkh_initial_setup'))");
      const existing = await client.query("SELECT 1 FROM admin_users LIMIT 1");
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const workspaceResult = await client.query<{
        id: string; name: string; slug: string;
      }>(
        "INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id, name, slug",
        ["Default Workspace", "default"]
      );
      const workspace = workspaceResult.rows[0];
      const adminResult = await client.query<{
        id: string; workspace_id: string; email: string; password_hash: string;
      }>(
        `INSERT INTO admin_users (workspace_id, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, workspace_id, email, password_hash`,
        [workspace.id, email, passwordHash]
      );
      const admin = adminResult.rows[0];
      await client.query("COMMIT");
      return {
        workspace,
        admin: {
          id: admin.id,
          workspaceId: admin.workspace_id,
          email: admin.email,
          passwordHash: admin.password_hash
        }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findAdminByEmail(email: string): Promise<AdminRecord | null> {
    const { rows } = await this.pool.query<{
      id: string; workspace_id: string; email: string; password_hash: string;
    }>(
      "SELECT id, workspace_id, email, password_hash FROM admin_users WHERE email = $1 LIMIT 1",
      [email]
    );
    const row = rows[0];
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      email: row.email,
      passwordHash: row.password_hash
    } : null;
  }

  async findAdminById(id: string, workspaceId: string): Promise<AdminRecord | null> {
    const { rows } = await this.pool.query<{
      id: string; workspace_id: string; email: string; password_hash: string;
    }>(
      `SELECT id, workspace_id, email, password_hash FROM admin_users
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    const row = rows[0];
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      email: row.email,
      passwordHash: row.password_hash
    } : null;
  }

  async defaultWorkspace(): Promise<WorkspaceRecord | null> {
    const { rows } = await this.pool.query<WorkspaceRecord>(
      "SELECT id, name, slug FROM workspaces WHERE slug = 'default' LIMIT 1"
    );
    return rows[0] ?? null;
  }

  async recordAudit(event: AuditEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events
       (workspace_id, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        event.workspaceId,
        event.actorId ?? null,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        JSON.stringify(event.metadata ?? {})
      ]
    );
  }

  async createRepository(
    workspaceId: string,
    input: RepositoryConnectionInput
  ): Promise<RepositoryRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RepositoryRow>(
        `INSERT INTO repositories (workspace_id, kind, name, local_path, clone_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id) DO NOTHING
         RETURNING id, workspace_id, kind, name, local_path, clone_url, default_branch`,
        [
          workspaceId,
          input.kind,
          input.name,
          input.kind === "local" ? input.path : null,
          input.kind === "git" ? input.url : null
        ]
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const encryptedToken = input.kind === "git" ? input.encryptedToken : undefined;
      if (encryptedToken) {
        await client.query(
          `INSERT INTO encrypted_credentials (workspace_id, repository_id, name, ciphertext)
           VALUES ($1, $2, $3, $4)`,
          [workspaceId, row.id, "repository-pat", encryptedToken]
        );
      }
      await client.query("COMMIT");
      return repositoryRecord({ ...row, has_credential: Boolean(encryptedToken) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async currentRepository(workspaceId: string): Promise<RepositoryRecord | null> {
    const { rows } = await this.pool.query<RepositoryRow>(
      `SELECT r.id, r.workspace_id, r.kind, r.name, r.local_path, r.clone_url,
              r.default_branch,
              EXISTS (
                SELECT 1 FROM encrypted_credentials c
                WHERE c.workspace_id = r.workspace_id AND c.repository_id = r.id
              ) AS has_credential
       FROM repositories r WHERE r.workspace_id = $1 LIMIT 1`,
      [workspaceId]
    );
    return rows[0] ? repositoryRecord(rows[0]) : null;
  }

  async findSnapshotByCommit(
    workspaceId: string,
    repositoryId: string,
    commitSha: string
  ): Promise<SourceSnapshotRecord | null> {
    const { rows } = await this.pool.query<SnapshotRow>(
      `SELECT id, workspace_id, repository_id, commit_sha, ref, remote_url,
              commit_timestamp, storage_path
       FROM source_snapshots
       WHERE workspace_id = $1 AND repository_id = $2 AND commit_sha = $3`,
      [workspaceId, repositoryId, commitSha]
    );
    return rows[0] ? snapshotRecord(rows[0]) : null;
  }

  async createSnapshot({ snapshot, files }: CreateSnapshotInput): Promise<SourceSnapshotRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<SnapshotRow>(
        `INSERT INTO source_snapshots
         (id, workspace_id, repository_id, commit_sha, ref, remote_url, commit_timestamp, storage_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (repository_id, commit_sha) DO NOTHING
         RETURNING id, workspace_id, repository_id, commit_sha, ref, remote_url,
                   commit_timestamp, storage_path`,
        [
          snapshot.id,
          snapshot.workspaceId,
          snapshot.repositoryId,
          snapshot.commitSha,
          snapshot.ref,
          snapshot.remoteUrl,
          snapshot.commitTimestamp,
          snapshot.storagePath
        ]
      );
      const insertedSnapshot = inserted.rows[0];
      if (!insertedSnapshot) {
        const existing = await client.query<SnapshotRow>(
          `SELECT id, workspace_id, repository_id, commit_sha, ref, remote_url,
                  commit_timestamp, storage_path
           FROM source_snapshots
           WHERE workspace_id = $1 AND repository_id = $2 AND commit_sha = $3`,
          [snapshot.workspaceId, snapshot.repositoryId, snapshot.commitSha]
        );
        if (!existing.rows[0]) throw new Error("Snapshot conflict winner was not found");
        await client.query("COMMIT");
        return snapshotRecord(existing.rows[0]);
      }
      for (const file of files) {
        await client.query(
          `INSERT INTO source_files
           (id, workspace_id, snapshot_id, path, language, content_hash, byte_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            file.id,
            file.workspaceId,
            file.snapshotId,
            file.path,
            file.language,
            file.contentHash,
            file.byteSize
          ]
        );
      }
      await client.query("COMMIT");
      return snapshotRecord(insertedSnapshot);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async countSnapshotFiles(snapshotId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM source_files WHERE snapshot_id = $1",
      [snapshotId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async repositoryCredential(workspaceId: string, repositoryId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM encrypted_credentials
       WHERE workspace_id = $1 AND repository_id = $2 AND name = 'repository-pat'`,
      [workspaceId, repositoryId]
    );
    return rows[0]?.ciphertext ?? null;
  }
}
