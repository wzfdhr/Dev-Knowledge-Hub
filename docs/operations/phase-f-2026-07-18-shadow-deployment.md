# Phase F Shadow Deployment Evidence - 2026-07-18

## Scope

- Source baseline: `edd85d2` (`main` after graph explorer PR #10).
- Deployed mode: `DEVKH_KNOWLEDGE_KERNEL_MODE=shadow`.
- Formal read path: legacy releases only.
- Explicitly excluded: no `active` mode switch, no release provenance rewrite, no database or persistent-volume deletion, and no change to the server-only Compose override.

## Reason

The production monitor recorded a terminal shadow `graph` stage failure for build
`dd8cb347-d3cb-4054-bae9-cee84d844aef`: duplicate deterministic graph edges
violated `knowledge_graph_edges_pkey`. Commit `9b5a84a` merges duplicate graph
items while retaining their distinct citations. The merged graph explorer is
included in the same production image.

## Deployment and verification

1. Copied the tracked `origin/main` source archive to `/opt/dev-knowledge-hub`.
   Server-only `.env`, `docker-compose.override.yml`, backup material, and Docker
   volumes were not included in the archive and were not changed.
2. Rebuilt the `app` service with the server's existing Compose override enabled.
   The first base-only Compose invocation removed the override's loopback port
   publication and returned `502` from Nginx; it was immediately corrected by
   recreating the app with both Compose files. No application data was changed.
3. Verified after the corrected restart:
   - app and PostgreSQL are healthy;
   - app exposes `127.0.0.1:3000` for the existing Nginx proxy;
   - `https://hub.starking.icu/api/health` returns `200` with the expected health
     payload;
   - Nginx is active;
   - the running app reports `shadow` mode; and
   - the production SPA serves `index-lhSdNtuU.js`, which contains the graph UI.

## Post-fix deployment

PR #11 was merged through the trusted merge workflow at `2f11bab`; its fresh
`verify` and `container-smoke` jobs both passed. The server was then synchronized
from that exact `main` commit. The first Compose rebuild retained the old app
container, so the app alone was deliberately recreated with both Compose files.
The resulting container started at `2026-07-18T04:26:54Z` and is healthy in
`shadow` mode. The server-local Nginx HTTPS route returned the public health
payload with `200`.

An authorized, temporary project-admin session then used the public application
API, a CSRF-protected session, and the existing default-project snapshot to
create build `19f860a1-e5c9-4536-a073-fa923527f61c`. All ten pipeline stages
(`convert` through `package`) completed as `reused`, including `graph` and the
previously failing `synthesize` stage. The legacy build became `ready`; no
release was created. The temporary account's sessions and memberships were
removed and the account was disabled; its audit history is intentionally
retained.

Before F04 can be accepted, perform desktop and mobile browser acceptance and
complete a new 24-hour project-role observation from the `2026-07-18T04:26:54Z`
restart without a terminal shadow-stage failure. `active` remains forbidden until
F05 receives separate authorization.

The production monitor intentionally remains failed during this observation:
`MAX_SHADOW_PIPELINE_FAILURES_24H=0` still counts the two pre-fix `synthesize`
failures at `2026-07-18T03:57Z` and `2026-07-18T03:59Z`. The post-fix build has
no failed stages. The threshold and historical records were left intact, so the
monitor will become green only after those failures age beyond its 24-hour window.
