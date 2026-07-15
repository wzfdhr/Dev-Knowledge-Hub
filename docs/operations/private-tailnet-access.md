# Public Team Access

## Team Onboarding

Open `https://hub.starking.icu`. Access is invitation-only: a workspace administrator creates the member account and provides its initial password through an approved private channel. There is no public registration endpoint.

## Verify

On the server, run `docker compose -f /opt/dev-knowledge-hub/docker-compose.yml ps` and verify the local application health endpoint. Through the public domain, `/api/health` must return:

```json
{"status":"ok","service":"dev-knowledge-hub"}
```

Nginx terminates TLS for `hub.starking.icu` and proxies only to the app's localhost listener. PostgreSQL remains private to Docker.

Active Git sources are synchronized at startup and then hourly. Each run creates a server-side import report, skips duplicate commits, and records a sanitized audit result.

## Remove a Teammate

In the Members page, disable the account. This immediately invalidates its active browser sessions and prevents future login. Remove its project memberships and revoke its project MCP tokens where appropriate. Resetting a member password also invalidates existing sessions.

## Recovery

The public endpoint is the normal production route. Do not use a public IP address, port `8443`, or Tailscale Serve as an operational fallback. Restore from the documented encrypted backup only after a verified restore drill.

## Backup Boundary

HTTPS protects data in transit. It does not encrypt source snapshots at rest and does not create backups. Encrypted off-host backups and restore drills remain a separate operational requirement.
