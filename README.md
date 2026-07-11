# Dev Knowledge Hub

Dev Knowledge Hub is a clean-room TypeScript modular monolith for turning repository snapshots into reviewable internal knowledge assets.

## MVP foundation

This repository currently includes:

- a Fastify API entrypoint with a health route
- a React 19 + Vite client shell with TanStack Query wired in
- a PostgreSQL/Drizzle database contract and checked-in SQL migration
- environment validation, migration runner, and baseline tooling

## Local commands

- `npm install` installs the locked dependencies.
- `npm run dev` starts the Fastify API in watch mode.
- `npm run dev:web` starts the Vite client development server.
- `npm run build` creates the client bundle and compiles the Node entrypoints.
- `npm run start` starts the compiled Fastify API.
- `npm test` runs the Vitest suite once.
- `npm run test:watch` runs Vitest in watch mode.
- `npm run typecheck` checks client and Node TypeScript projects without emitting files.
- `npm run lint` checks the repository with ESLint.
- `npm run db:migrate` applies pending checked-in SQL migrations using `DATABASE_URL`.
- `npm run mcp:stdio` starts the MCP stdio server; it advertises an empty tool list until tool work is implemented.
- `npm run test:e2e` runs the Playwright end-to-end suite.
- `npm run licenses:check` checks installed package manifests for license metadata.
- `npm run secrets:scan` scans tracked documentation and environment examples for credential patterns.

## Clean-room policy

Implementation in this repository is independent from the reference repository located elsewhere in the workspace. See `docs/provenance.md` for the explicit provenance policy.
