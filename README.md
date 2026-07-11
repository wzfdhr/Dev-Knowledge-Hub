# Dev Knowledge Hub

Dev Knowledge Hub is a clean-room TypeScript modular monolith for turning repository snapshots into reviewable internal knowledge assets.

## MVP foundation

This repository currently includes:

- a Fastify API entrypoint with a health route
- a React 19 + Vite client shell with TanStack Query wired in
- a PostgreSQL/Drizzle database contract and checked-in SQL migration
- environment validation, migration runner, and baseline tooling

## Local commands

- `npm install`
- `npm run dev`
- `npm run dev:web`
- `npm run db:migrate`
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`

## Clean-room policy

Implementation in this repository is independent from the reference repository located elsewhere in the workspace. See `docs/provenance.md` for the explicit provenance policy.
