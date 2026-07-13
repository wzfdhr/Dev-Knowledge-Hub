# Private Tailnet Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dev Knowledge Hub private to the fixed team through trusted Tailnet HTTPS, then remove its temporary public self-signed endpoint.

**Architecture:** Tailscale Serve terminates HTTPS at the server's `*.ts.net` name and proxies only to `127.0.0.1:3000`. Docker app and PostgreSQL stay private; Nginx blog port 80 is untouched.

**Tech Stack:** Ubuntu 24.04, Tailscale stable, Tailscale Serve, Nginx, Docker Compose, Fastify, PostgreSQL.

## Global Constraints

- Use `tailscale serve`, never `tailscale funnel`.
- Do not expose Docker port 3000 or PostgreSQL publicly.
- Do not alter the existing `starry-blog` Nginx virtual host on port 80.
- Do not disable Nginx 8443 until Tailnet HTTPS is verified.
- Do not print or commit authorization URLs, credentials, passwords, or secrets.
- Tailnet protects transit and access only; it does not encrypt source snapshots at rest.

---

## File Map

- Create: `/etc/apt/sources.list.d/tailscale.list` on the server; signed stable apt source.
- Create: `/usr/share/keyrings/tailscale-archive-keyring.gpg` on the server; repository signing key.
- Modify: `/opt/dev-knowledge-hub/docker-compose.override.yml` on the server; Tailnet `PUBLIC_BASE_URL`.
- Modify: `/etc/nginx/sites-enabled/dev-knowledge-hub-ip` on the server; remove only its symlink after cutover.
- Create: `docs/operations/private-tailnet-access.md`; access and rollback runbook.

### Task 1: Install and Enroll the Server

**Files:**
- Create: `/etc/apt/sources.list.d/tailscale.list`
- Create: `/usr/share/keyrings/tailscale-archive-keyring.gpg`
- Test: `tailscale version`, `systemctl is-active tailscaled`, `tailscale status --json`

**Interfaces:**
- Consumes: owner-completed Tailscale browser authorization.
- Produces: a connected server with `.Self.DNSName` and a Tailnet IP.

- [ ] **Step 1: Record the pre-install state**

```bash
command -v tailscale || true; systemctl is-active tailscaled || true; ss -ltnp | rg ':(80|8443|3000|5432)'
```

Expected: Tailscale is absent or inactive, app is only `127.0.0.1:3000`, and the temporary endpoint is 8443.

- [ ] **Step 2: Install the signed stable package**

```bash
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg; curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list; apt-get update; apt-get install -y tailscale; systemctl enable --now tailscaled; tailscale version; systemctl is-active tailscaled
```

Expected: a stable version prints and `tailscaled` is `active`.

- [ ] **Step 3: Authorize the server**

```bash
tailscale up --ssh=false
```

Expected: a one-time browser authorization URL is displayed. Give it only to the owner in the interactive session; never save it in a file, repository, or log.

- [ ] **Step 4: Confirm Tailnet enrollment**

```bash
tailscale status --json | jq '{backendState, dnsName: .Self.DNSName, tailscaleIPs: .Self.TailscaleIPs}'
```

Expected: `backendState` is `Running`, the DNS name ends in `.ts.net.`, and at least one Tailnet IP exists.

### Task 2: Configure the Private HTTPS Proxy

**Files:**
- Modify: `/opt/dev-knowledge-hub/docker-compose.override.yml`
- Test: `tailscale serve status --json`, Tailnet health endpoint, Docker Compose health

**Interfaces:**
- Consumes: `.Self.DNSName` from Task 1.
- Produces: `https://<server>.ts.net` forwarding only to `http://127.0.0.1:3000`.

- [ ] **Step 1: Capture the healthy app state**

```bash
cd /opt/dev-knowledge-hub; docker compose ps; curl -fsS http://127.0.0.1:3000/api/health; cp docker-compose.override.yml docker-compose.override.yml.before-tailnet
```

Expected: app and PostgreSQL are healthy and health returns `{"status":"ok","service":"dev-knowledge-hub"}`.

- [ ] **Step 2: Configure persistent private HTTPS**

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000; tailscale serve status --json
```

Expected: Serve lists the machine's HTTPS `.ts.net` endpoint and proxy target `http://127.0.0.1:3000`.

- [ ] **Step 3: Update the app public URL**

Set `PUBLIC_BASE_URL` in `/opt/dev-knowledge-hub/docker-compose.override.yml` to `https://<server>.ts.net`, then run:

```bash
cd /opt/dev-knowledge-hub; docker compose up -d --no-deps app; docker compose ps app
```

Expected: the app is healthy and generated MCP connection URLs use the Tailnet address.

- [ ] **Step 4: Verify trusted HTTPS and routing**

```bash
TAILNET_DNS_NAME="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\\.$//')"; curl -fsS "https://${TAILNET_DNS_NAME}/api/health"; curl -fsSI "https://${TAILNET_DNS_NAME}/"
```

Expected: both requests are HTTP 200 without `-k`. A team device must initialize/login once and confirm `devkh_session` is `Secure`, `HttpOnly`, and `SameSite=Lax`.

### Task 3: Close the Public Endpoint and Document Operations

**Files:**
- Modify: `/etc/nginx/sites-enabled/dev-knowledge-hub-ip` by removing its symlink
- Create: `docs/operations/private-tailnet-access.md`
- Test: listener list, blog response, Tailnet health response

**Interfaces:**
- Consumes: verified Tailnet endpoint from Task 2.
- Produces: no public knowledge-hub listener and a concise team runbook.

- [ ] **Step 1: Disable only the temporary listener**

```bash
rm -f /etc/nginx/sites-enabled/dev-knowledge-hub-ip; nginx -t; systemctl reload nginx; ss -ltnp | rg ':8443' && exit 1 || true
```

Expected: Nginx validates, no process listens on 8443, and `/etc/nginx/sites-available/dev-knowledge-hub-ip` remains for rollback.

- [ ] **Step 2: Verify service separation**

```bash
curl -fsS -o /dev/null -w 'blog=%{http_code}\\n' http://127.0.0.1/; TAILNET_DNS_NAME="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\\.$//')"; curl -fsS -o /dev/null -w 'knowledge-hub=%{http_code}\\n' "https://${TAILNET_DNS_NAME}/api/health"; cd /opt/dev-knowledge-hub && docker compose ps
```

Expected: blog and knowledge hub both return 200; app and PostgreSQL are healthy.

- [ ] **Step 3: Write the runbook and commit only operation documents**

Create `docs/operations/private-tailnet-access.md` with sections for team onboarding, verification, Tailnet and app access revocation, rollback with `tailscale serve reset` plus the preserved Nginx site, and the separate encrypted-offsite-backup boundary.

```bash
git add docs/operations/private-tailnet-access.md docs/superpowers/plans/2026-07-13-private-tailnet-access.md; git commit -m "docs: add private tailnet operations"
```

Expected: the commit contains only these operation documents and preserves pre-existing package and test changes.
