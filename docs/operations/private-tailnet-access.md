# Private Tailnet Access

## Team Onboarding

Install the official Tailscale client on the teammate's device and sign in to the owner's Tailnet. Open Dev Knowledge Hub at the server's `.ts.net` HTTPS address. Do not use a public IP address, port 8443, or Tailscale Funnel.

## Verify

On the server, run `tailscale status`, `tailscale serve status`, and `cd /opt/dev-knowledge-hub && docker compose ps`. The health endpoint at `/api/health` must return:

```json
{"status":"ok","service":"dev-knowledge-hub"}
```

## Remove a Teammate

Remove the user or device in the Tailscale administration console. Then remove the corresponding Dev Knowledge Hub account and revoke its MCP tokens in the application. Both actions are required: Tailnet removal blocks network access, and application revocation prevents reuse if access is restored later.

## Rollback

To stop Tailnet serving, run `tailscale serve reset`.

To restore the temporary self-signed endpoint while investigating, run:

```bash
ln -s /etc/nginx/sites-available/dev-knowledge-hub-ip /etc/nginx/sites-enabled/dev-knowledge-hub-ip && nginx -t && systemctl reload nginx
```

This rollback restores only the temporary `https://118.31.105.66:8443` endpoint. It is not browser-trusted and must not be treated as the normal team URL.

## Backup Boundary

Tailscale protects network access and encrypted transit. It does not encrypt source snapshots at rest and it does not create backups. Encrypted off-host backups and restore drills are a separate operational requirement.
