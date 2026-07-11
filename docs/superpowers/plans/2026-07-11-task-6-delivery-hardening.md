# Task 6 Delivery Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deterministic, documented, security-gated private MVP deployment without relying on unavailable Docker execution.

**Architecture:** Keep Fastify and the existing PostgreSQL/pg-boss composition, adding focused security and lifecycle modules around it. Package the built server in a multi-stage non-root Node 22 image, compose it with PostgreSQL 16 and persistent data, and make CI plus local scripts enforce release policy.

**Tech Stack:** Node.js 22, TypeScript, Fastify, PostgreSQL 16, pg-boss, Docker Compose, Vitest, Playwright, GitHub Actions.

## Global Constraints

- Work only in `/Users/start/Documents/New project/dev-knowledge-hub` on `codex/mvp`.
- Do not add or push a remote; do not modify the reference repository.
- Preserve `UNLICENSED`, private intent, and the untracked `.superpowers/` directory.
- Use TDD for behavior and security changes.
- Record Docker/PostgreSQL skips exactly and never claim a live database check.

---

### Task 1: HTTP Security And Lifecycle

**Files:**
- Create: `src/server/security/http.ts`
- Create: `src/server/security/http.test.ts`
- Create: `src/server/lifecycle.ts`
- Create: `src/server/lifecycle.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/bootstrap.ts`
- Modify: `src/server/main.ts`
- Modify: `src/server/mcp-stdio.ts`

- [ ] Write focused failing tests for route-specific rate limits, security headers, body limits, redaction, ordered resource cleanup, signal shutdown, and MCP transport/database cleanup.
- [ ] Run the focused tests and confirm expected failures.
- [ ] Implement the minimum security hooks and lifecycle ownership needed to pass.
- [ ] Run focused and full tests.

### Task 2: Container And Release Gates

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.dockerignore`
- Modify: `scripts/secrets-scan.mjs`
- Create: `scripts/secrets-scan.test.mjs`
- Modify: `scripts/licenses-check.mjs`
- Create: `config/license-allowlist.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] Write failing script fixtures for all required secret classes and credentialized remotes.
- [ ] Implement repository-wide tracked-file secret scanning and dependency-license allowlisting/reporting.
- [ ] Harden the image, Compose services, health checks, volumes, startup command, and CI stages.
- [ ] Validate JSON, YAML syntax, Dockerfile contracts, scans, and package scripts statically.

### Task 3: Deterministic Acceptance And Documentation

**Files:**
- Create: `acceptance/fixture-repo/**`
- Create: `acceptance/real-query.acceptance.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/security.md`
- Create: `docs/commercialization-roadmap.md`
- Create: `docs/api.md`

- [ ] Add a deterministic fixture and acceptance script with exact affected-module, convention, test, and citation assertions.
- [ ] Document operations, MCP clients/transports, backup/restore, security, API, architecture, troubleshooting, commercialization, and future-public gates against the actual implementation.
- [ ] Run acceptance and documentation consistency checks.

### Task 4: Verification And Delivery

**Files:**
- Create: `/tmp/devkh-sdd/task-6-report.md`

- [ ] Run `npm ci`, typecheck, lint, tests, build, scans, acceptance, and e2e.
- [ ] Record exact Docker/Compose/live PostgreSQL commands skipped because Docker is unavailable, plus independent static checks.
- [ ] Reconfirm clean-room provenance, original-repo cleanliness, remote isolation, and copied-hash absence.
- [ ] Write the report, commit as `chore: harden mvp delivery`, and confirm post-commit status contains only preserved `.superpowers/`.
