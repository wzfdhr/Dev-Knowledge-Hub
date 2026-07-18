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

## Follow-up

The corrected application restart occurred at `2026-07-18T03:07:04Z`. The F04
24-hour observation therefore starts from that restart. Before F04 can be
accepted, run a representative authorized shadow build through all ten stages,
perform desktop and mobile browser acceptance, and complete the project-role
observation without a terminal shadow-stage failure. `active` remains forbidden
until F05 receives separate authorization.
