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

## 24-hour technical observation

At `2026-07-19T23:49:56Z`, more than 43 hours after the corrected app restart,
the production system was checked again without changing data or configuration:

- `/var/lib/devkh-monitor/status.json` reported `result=success` with no
  failures for the scheduled run completed at `2026-07-19T23:45:08.972Z`;
- the running app still reported `DEVKH_KNOWLEDGE_KERNEL_MODE=shadow`;
- both the loopback application health endpoint and the server-local public
  HTTPS route returned the expected health payload, with the public route
  returning `200`;
- the preceding 24-hour window contained zero builds with a failed shadow stage;
  and
- post-fix build `19f860a1-e5c9-4536-a073-fa923527f61c` still had ten stage
  runs, all ten successful or reused, and zero failed stages.

This closes the strict 24-hour shadow technical-observation gate. It does not by
itself prove the complete F04 role rollout: desktop/mobile browser acceptance
and evidence from one real project covering administrator, member, and reader
flows continuously for 24 hours remain required. After that project-level gate
passes, all non-critical projects must complete a separate 24-hour observation.
Expansion to the whole workspace requires explicit user confirmation. Any
permission leak, data corruption, invalid citation, golden-flow failure, or two
consecutive new-kernel build failures triggers an immediate rollback to `shadow`
and the last legacy release. `active` therefore remains forbidden until every
F04 rollout layer is accepted and F05 receives separate authorization.
