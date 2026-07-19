# Security Model

## Trust model

Dev Knowledge Hub is a private, single-deployment service for a trusted, administrator-created team. It is available through the authenticated `hub.starking.icu` reverse proxy, but it is not suitable for untrusted public signup, arbitrary tenant hosting, or anonymous internet use.

## Controls

- Admin passwords use Argon2id. Sessions are signed, expire after eight hours, and use `HttpOnly`, `SameSite=Lax`, production `Secure` cookies.
- Provider API keys and remote Git PATs are encrypted with AES-256-GCM under `DEVKH_MASTER_KEY`. Plaintext PATs are supplied only in the Git child environment to the checked-in static askpass executable and are not stored in temporary scripts, process arguments, logs, or Git URLs.
- MCP tokens contain 256 random bits, are persisted only as SHA-256 hashes/prefixes, are disclosed once, and are revocable. HTTP and stdio authorization is rechecked before every tool call.
- PostgreSQL queries and composite tenant keys enforce workspace ownership. Sensitive mutations and audit records share transactions.
- Published source reads are path-contained, release/snapshot-scoped, hash-verified, and limited to 500 lines.
- Request bodies are capped at 1 MiB. Fixed-window per-IP limits cover setup, login, all MCP requests, and feedback writes. Default one-minute limits are 5, 10, 120, and 30 respectively. Limiter state sweeps expired buckets every minute and is capped at 10,000 deterministic least-recently-used entries per process.
- Responses set CSP, frame denial, MIME sniff prevention, opener isolation, and no-referrer policy. Production logs redact authorization, cookies, passwords, tokens, API keys, secrets, and credential fields.
- The app container runs as the image `node` user with a read-only root filesystem, no-new-privileges, bounded temporary storage, health checks, and persistent writable data mounts only. Nginx terminates TLS for `hub.starking.icu`; the app binds only to `127.0.0.1:3000` and PostgreSQL remains on the private Compose network.
- CI scans every Git-tracked file for committed env files, complete and encrypted private-key blocks, GitHub/OpenAI/Anthropic token forms, and credentialized HTTP remotes. Dependency license expressions must match the checked-in allowlist.

## Secret handling

Never commit `.env` files. `.env.example` contains non-secret placeholders only. Generate each production secret independently on the deployment host, limit environment access, rotate session/MCP/provider/repository credentials after suspected exposure, and retain the master key separately from encrypted database backups. Do not paste generated passwords, keys, tokens, `.env` contents, database dumps, or backup archives into chat, tickets, logs, or source control.

Changing `DEVKH_MASTER_KEY` without re-encrypting stored credentials makes those credentials unreadable. There is no automated key rotation in this MVP.

## Known limits

- Rate limits are in-process and per replica; a shared limiter is required before horizontal scaling.
- Administrator-created accounts have no MFA, SSO, self-service account recovery, or session revocation list. Do not expose the setup endpoint as a signup workflow.
- The app does not terminate TLS. The production Nginx virtual host terminates HTTPS for `hub.starking.icu`; DNS must resolve to the server and inbound TCP `80`/`443` must be available for certificate issuance and renewal.
- Remote repository host allowlisting, egress controls, malware scanning, and webhook signature ingestion are not implemented.
- Security headers are application defaults, not a substitute for proxy/network controls.
- The application trusts exactly one reverse-proxy hop. Keep the application port private; only Caddy/Nginx may reach it directly, and clients must use the public proxy endpoint.

## Incident response

1. Stop external access and preserve logs/audit data.
2. Revoke MCP tokens and rotate session, provider, repository, and database credentials.
3. If the master key may be exposed, export/re-enter provider and repository credentials under a new key.
4. Inspect tracked-file scan output, audit events, published release/snapshot hashes, and deployment changes.
5. Restore the database and both file volumes from one verified backup set if integrity is uncertain.

Report vulnerabilities privately to the repository owner. Do not open public issues containing exploit details or credentials.

## Future-public checklist

- Independent threat model, penetration test, dependency/SBOM and image vulnerability scanning
- TLS/HSTS at a hardened reverse proxy, trusted proxy configuration, CSRF review, shared distributed rate limiting
- MFA/SSO, RBAC, tenant lifecycle/deletion/export, session revocation, recovery, and abuse controls
- Managed secret service, envelope encryption/key rotation, scoped provider credentials, repository host/egress allowlists
- Backup retention policy, automated restore drills, disaster recovery objectives, monitoring/alerting, audit export
- Privacy policy, terms, DPA/subprocessor inventory, data residency and retention controls
- License/copyright review and an explicit replacement for `UNLICENSED` before any source distribution
