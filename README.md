# Dev Knowledge Hub

Private, clean-room developer knowledge service that snapshots a repository, builds cited knowledge releases, and exposes the current published release through an administration console and MCP.

This package is private and `UNLICENSED`. No permission is granted to copy, redistribute, or publish it.

## Requirements

- Node.js 22.9.0 or newer and npm 11 for local development
- PostgreSQL 16 for production and integration tests
- Docker Engine with Compose v2 for the container workflow
- Git for local and remote repository snapshots

## Local setup

```bash
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

`npm run dev` explicitly loads `.env` and starts the Fastify API on `http://127.0.0.1:3000`
plus the Vite console on `http://127.0.0.1:5173`. Use `npm run dev:api` or
`npm run dev:web` when only one process is needed. `npm start` always sets
`NODE_ENV=production` and loads `.env` before starting the built server.

Generate production values instead of using the placeholders:

```bash
openssl rand -base64 32   # DEVKH_MASTER_KEY: keep the canonical 32-byte base64 output
openssl rand -hex 32      # DEVKH_SESSION_SECRET
openssl rand -hex 24      # POSTGRES_PASSWORD
```

The development server listens on `HOST`/`PORT`. Production requires `DATABASE_URL`, `DEVKH_MASTER_KEY`, and `DEVKH_SESSION_SECRET`; startup runs checked-in migrations under a PostgreSQL advisory lock before accepting HTTP traffic.

## Docker Compose

```bash
cp .env.example .env
# Replace all security placeholders in .env.
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3000/api/health
docker compose --profile test run --rm integration
docker compose --profile test run --rm e2e
```

Compose runs the non-root Node 22 app and PostgreSQL 16. The app waits for database health, uses a read-only root filesystem and a no-exec temporary `/tmp`, and persists PostgreSQL data, immutable snapshots, and Git mirrors in separate named volumes. The image installs its Git askpass helper as a static executable under `/app/scripts`; PATs are passed only in the Git child environment. Stop gracefully with `docker compose down`; do not add `--volumes` unless deleting all retained state is intentional.

PostgreSQL initialization creates `dev_knowledge_hub` for the app and a separate `devkh_test` used only by the Compose integration profile. Existing PostgreSQL volumes created before this isolation was added need the test database once before running integration tests:

```bash
docker compose exec postgres createdb -U devkh devkh_test
```

Integration cleanup must target only `TEST_DATABASE_URL`; never point it at `dev_knowledge_hub`.

## Operating workflow

1. Open the console and complete one-time admin setup.
2. Connect a clean local Git worktree or a credential-free HTTPS remote plus optional PAT.
3. Sync an immutable commit snapshot, build knowledge, review the draft, and publish a release.
4. Create an MCP token in Settings. Its plaintext is shown once.
5. Review reported gaps in Feedback; acknowledge before rebuilding. Rebuild never auto-publishes.

`SIGTERM` and `SIGINT` stop HTTP intake, close active MCP sessions, drain pg-boss, and close the database pool. Compose grants 30 seconds for this path.

## MCP setup

HTTP uses Streamable HTTP at `http://127.0.0.1:3000/mcp` with `Authorization: Bearer <token>`. The following examples read the token from `DEVKH_MCP_TOKEN`; adapt the client’s supported environment interpolation if needed.

Codex HTTP (`~/.codex/config.toml`):

```toml
[mcp_servers.devkh]
url = "http://127.0.0.1:3000/mcp"
bearer_token_env_var = "DEVKH_MCP_TOKEN"
```

Claude Code or Cursor generic HTTP configuration:

```json
{
  "mcpServers": {
    "devkh": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${DEVKH_MCP_TOKEN}" }
    }
  }
}
```

Generic stdio configuration, suitable for clients that launch a local process:

```json
{
  "mcpServers": {
    "devkh": {
      "command": "node",
      "args": ["/absolute/path/to/dev-knowledge-hub/dist/server/server/mcp-stdio.js"],
      "env": {
        "DATABASE_URL": "${DATABASE_URL}",
        "DEVKH_MCP_TOKEN": "${DEVKH_MCP_TOKEN}"
      }
    }
  }
}
```

Build before stdio use with `npm run build`. Both transports expose the same eight tools documented in [docs/api.md](docs/api.md). Token authorization is rechecked before every tool call, so revocation also terminates established stdio use.

## Backup and restore

For a consistent backup, stop the app while leaving PostgreSQL running, then capture the database and both app volumes:

```bash
docker compose stop app
docker compose exec -T postgres pg_dump -U devkh -d dev_knowledge_hub -Fc > devkh.pgdump
docker run --rm -v dev-knowledge-hub_snapshot_data:/source:ro -v "$PWD":/backup alpine tar czf /backup/snapshots.tgz -C /source .
docker run --rm -v dev-knowledge-hub_repository_mirrors:/source:ro -v "$PWD":/backup alpine tar czf /backup/repositories.tgz -C /source .
docker compose start app
```

Restore only into an empty deployment running the same application version: restore both volume archives, run `pg_restore --clean --if-exists` into PostgreSQL, then start the app so forward migrations run. Keep the master key with the backup; encrypted provider and repository credentials cannot be recovered without it. Test restores regularly and encrypt backup media.

## Quality gates

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run test:integration       # requires TEST_DATABASE_URL
npm run build
npm run secrets:scan
npm run licenses:check
npm run licenses:report
npm run delivery:verify
npm run acceptance
npm run test:e2e
```

CI runs these gates with PostgreSQL 16 and uploads Playwright artifacts on failure. `licenses:report` prints a Markdown third-party dependency inventory; review it whenever the lockfile changes.

## Troubleshooting

- **Startup rejects environment:** ensure the master key is exactly 32 random bytes in canonical base64 and all production variables are present.
- **PostgreSQL remains unhealthy:** inspect `docker compose logs postgres`; verify the password and volume ownership before changing state.
- **Local sync reports a dirty worktree:** commit, stash, or remove every changed/untracked file. Snapshots intentionally reject dirty local repositories.
- **Remote sync fails:** use a credential-free HTTPS URL. Supply the PAT separately; never embed credentials in the URL.
- **MCP returns `UNAUTHORIZED`:** rotate/recreate the token in Settings and update the client environment. Revoked tokens stop working immediately.
- **MCP returns `UNPUBLISHED`:** publish a ready release in the console; drafts are not agent-visible.
- **Citations cannot be read:** restore the matching immutable snapshot volume and database backup together.
- **Build interrupted:** the restarted worker fails interrupted active builds and safely reenqueues only queued builds with present snapshots. Persisted queued work is also reconciled periodically after dispatch failures.

See [architecture](docs/architecture.md), [security](docs/security.md), [HTTP/MCP API](docs/api.md), [commercialization roadmap](docs/commercialization-roadmap.md), and [clean-room provenance](docs/provenance.md).
