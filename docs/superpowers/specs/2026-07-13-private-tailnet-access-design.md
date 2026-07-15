# Private Tailnet Access Design

## Goal

Replace the temporary public self-signed IP endpoint with a private, browser-trusted HTTPS endpoint for a fixed internal team, without changing the existing blog service.

## Scope

- Install and authenticate the Tailscale client on the application server.
- Publish Dev Knowledge Hub only through Tailscale Serve at the server's `*.ts.net` name.
- Keep the application and PostgreSQL bound to localhost/private Docker networking.
- Set the application's public base URL to its Tailnet HTTPS address so generated MCP instructions are correct.
- Remove the public Nginx `8443` listener only after the Tailnet endpoint is verified.
- Document team-member onboarding and the emergency rollback procedure.

## Non-goals

- No public domain, ICP filing, Cloudflare Tunnel, or public signup.
- No changes to the blog's Nginx port 80 configuration.
- No new application authentication, role, backup, monitoring, or source-at-rest encryption features. Those are separate follow-up deliverables.

## Architecture

The Docker app remains published only as `127.0.0.1:3000`. The Tailscale daemon joins the owner's Tailnet and `tailscale serve` terminates a trusted TLS connection for the machine's Tailnet DNS name, then proxies it to `http://127.0.0.1:3000`. The browser sees HTTPS, so the existing production `Secure` session cookie continues to work without application changes.

The public Nginx blog virtual host remains unchanged on port 80. Once Tailnet access is confirmed, the separate public Nginx `8443` virtual host and its self-signed certificate are disabled. PostgreSQL remains reachable only from the Docker network.

## Data Flow

1. A permitted team device signs into the same Tailnet and resolves the server's MagicDNS name.
2. The device creates an encrypted Tailscale connection to the server.
3. Tailscale Serve accepts HTTPS at the machine's `*.ts.net` hostname and proxies only to `127.0.0.1:3000`.
4. Fastify applies the existing authentication, authorization, upload filtering, and audit controls.
5. Source uploads and session cookies never traverse a public Nginx port; Tailscale may use encrypted relay transport when a direct peer-to-peer path is unavailable.

## Operational Behavior

- Initial server enrollment requires the owner to complete the one-time Tailscale browser login from the displayed authorization URL.
- Each teammate receives Tailnet access from the owner, installs Tailscale, and accesses the single Tailnet URL. Removing a member's Tailnet access removes network access to the knowledge hub.
- Tailscale Serve state persists across service restarts. Docker application restarts do not expose a public port.
- If the Tailnet service fails, the app remains healthy on localhost but is unreachable to team devices; the rollback is to re-enable the already-tested Nginx `8443` virtual host temporarily while the Tailnet issue is repaired.

## Security Constraints

- Do not expose Docker port 3000 or PostgreSQL to the public network.
- Do not keep public port 8443 open after Tailnet verification.
- Do not store Tailscale auth keys, URLs containing credentials, application secrets, or team identities in repository files or logs.
- Keep the Tailscale ACL limited to the known team and this server; do not enable public Funnel.
- Do not claim source data is encrypted at rest: this work protects transport and network exposure only.

## Verification

1. `tailscale status` shows the server as connected to the intended Tailnet.
2. `tailscale serve status` shows an HTTPS handler forwarding only to `127.0.0.1:3000`.
3. The Tailnet URL returns `/api/health` with HTTP 200 and a valid browser-trusted certificate.
4. An authenticated browser session succeeds over the Tailnet URL and has a `Secure`, `HttpOnly`, `SameSite=Lax` session cookie.
5. `docker compose -f /opt/dev-knowledge-hub/docker-compose.yml ps` reports healthy app and PostgreSQL services.
6. No process listens on public TCP 8443 after cutover; Nginx's blog port 80 still responds normally.

## Rollback

Keep the existing Nginx `dev-knowledge-hub-ip` configuration file disabled rather than deleting it. If Tailnet access must be rolled back, disable Tailscale Serve, re-enable that Nginx site, reload Nginx, and use the known temporary `https://118.31.105.66:8443` endpoint while diagnosing the Tailnet configuration.
