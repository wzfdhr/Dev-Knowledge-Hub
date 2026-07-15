# Dev Knowledge Hub

Private, clean-room developer knowledge service that snapshots a repository, builds cited knowledge releases, and exposes the current published release through an administration console and MCP.

This package is private and `UNLICENSED`. No permission is granted to copy, redistribute, or publish it.

## Requirements

- Node.js 22.13.0 or newer and npm 11 for local development
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

### Server preflight

- Point the chosen public DNS name at the server's public IPv4/IPv6 address before deployment. Caddy uses that name to obtain and renew the TLS certificate automatically.
- Allow inbound TCP `80` and `443` at the host and cloud firewall. Do not publish PostgreSQL or the app port.
- Install Docker Engine with Compose v2 and ensure no other process owns ports `80` or `443`.
- Keep this checkout and its `.env` readable only by the deployment operator. Do not place it in a publicly served directory.

### Secrets and deployment

```bash
cd /absolute/path/to/dev-knowledge-hub
DEVKH_COMPOSE_FILE="$PWD/docker-compose.yml"
cp .env.example .env
# Set DEVKH_DOMAIN and PUBLIC_BASE_URL=https://<your-public-domain> to the same public hostname.
# Set ACME_EMAIL to an operator address.
# Generate each secret locally; do not paste output into chat, tickets, or commits.
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -base64 32   # DEVKH_MASTER_KEY
openssl rand -hex 32      # DEVKH_SESSION_SECRET
# Put the generated values in .env, then restrict the file.
chmod 600 .env

# This validates Compose without needing a real domain or contacting ACME.
DEVKH_DOMAIN=example.test ACME_EMAIL=operator@example.test docker compose -f "$DEVKH_COMPOSE_FILE" config --quiet
docker compose -f "$DEVKH_COMPOSE_FILE" build --pull
docker compose -f "$DEVKH_COMPOSE_FILE" up -d
docker compose -f "$DEVKH_COMPOSE_FILE" ps
curl --fail --resolve "$DEVKH_DOMAIN:443:127.0.0.1" "https://$DEVKH_DOMAIN/api/health"
```

Compose exposes only Caddy on host ports `80` and `443`; Caddy forwards traffic to the app on the private Compose network and obtains HTTPS certificates for `DEVKH_DOMAIN`. PostgreSQL and the app have no host port mappings. The app waits for database health, uses a read-only root filesystem and a no-exec temporary `/tmp`, and persists PostgreSQL data, immutable snapshots, Git mirrors, uploads, and artifacts in separate named volumes. The image installs its Git askpass helper as a static executable under `/app/scripts`; PATs are passed only in the Git child environment. Stop gracefully with `docker compose -f "$DEVKH_COMPOSE_FILE" down`; do not add `--volumes` unless deleting all retained state is intentional.

For a deployed server, confirm the public health endpoint and Caddy certificate path after DNS has propagated:

```bash
curl --fail "https://$DEVKH_DOMAIN/api/health"
docker compose -f "$DEVKH_COMPOSE_FILE" logs --tail=100 caddy
docker compose -f "$DEVKH_COMPOSE_FILE" ps
```

Compose integration and browser tests are optional deployment checks and can run without a public domain:

```bash
docker compose -f "$DEVKH_COMPOSE_FILE" --profile test run --rm integration
docker compose -f "$DEVKH_COMPOSE_FILE" --profile test run --rm e2e
```

PostgreSQL initialization creates `dev_knowledge_hub` for the app and a separate `devkh_test` used only by the Compose integration profile. Existing PostgreSQL volumes created before this isolation was added need the test database once before running integration tests:

```bash
docker compose -f "$DEVKH_COMPOSE_FILE" exec postgres createdb -U devkh devkh_test
```

Integration cleanup must target only `TEST_DATABASE_URL`; never point it at `dev_knowledge_hub`.

## Operating workflow

1. Open the console and complete one-time admin setup.
2. Enter a project from Project Center and open **Data Upload**. Select the original project folder; the browser filters dependencies, build output, binary files, and sensitive files before direct folder upload. Git HTTPS and server-local paths remain alternative sources.
3. Open **Knowledge Versions**, build the immutable source snapshot, review the cited draft, and explicitly publish it.
4. Open the project's **Codex Integration** page, create a project-scoped MCP token, and install the generated `.codex/config.toml` and `AGENTS.md` snippets. Token plaintext is shown once.
5. Use **Team Collaboration** to inspect workspace members and project-isolated audit activity. Review reported gaps in Feedback; acknowledge before rebuilding. Rebuild never auto-publishes.

Folder imports accept up to 50,000 accepted files and 2 GiB of accepted source. Dependency and build directories are excluded before their contents are read or uploaded; the server repeats the same filtering before it creates an immutable snapshot. ZIP imports are not supported.

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

Use the automated encrypted OSS backup and restore procedure in
[encrypted offsite backups](docs/operations/encrypted-offsite-backups.md). Back up the
database and four durable application volumes (snapshots, repository mirrors, uploaded sources,
and artifacts) as one set, test restores regularly, and keep
`DEVKH_MASTER_KEY` separately from the restic repository: it is required to decrypt restored
provider and repository credentials. Never put `.env`, database dumps, master keys, session
secrets, tokens, or generated passwords in chat, tickets, or source control.

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
- **PostgreSQL remains unhealthy:** inspect `docker compose -f "$DEVKH_COMPOSE_FILE" logs postgres`; verify the password and volume ownership before changing state.
- **Local sync reports a dirty worktree:** commit, stash, or remove every changed/untracked file. Snapshots intentionally reject dirty local repositories.
- **Remote sync fails:** use a credential-free HTTPS URL. Supply the PAT separately; never embed credentials in the URL.
- **MCP returns `UNAUTHORIZED`:** rotate/recreate the token under the project's Codex Integration page and update the client environment. Revoked tokens stop working immediately.
- **MCP returns `UNPUBLISHED`:** publish a ready release in the console; drafts are not agent-visible.
- **Citations cannot be read:** restore the matching immutable snapshot volume and database backup together.
- **Build interrupted:** the restarted worker fails interrupted active builds and safely reenqueues only queued builds with present snapshots. Persisted queued work is also reconciled periodically after dispatch failures.

See [architecture](docs/architecture.md), [security](docs/security.md), [HTTP/MCP API](docs/api.md), [commercialization roadmap](docs/commercialization-roadmap.md), and [clean-room provenance](docs/provenance.md).
