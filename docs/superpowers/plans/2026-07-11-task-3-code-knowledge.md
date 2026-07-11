# Cited Code Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic, cited code knowledge from immutable snapshots, expose durable build/search APIs, and publish immutable releases manually.

**Architecture:** A compiler-backed intelligence layer extracts symbols, relationships, and structured configuration from snapshot files. A deterministic generator produces cited pages and chunks, while an injected optional enhancer can improve prose without becoming required. A build service coordinates persisted state and queue jobs; repository-scoped stores own atomic release publication and weighted search.

**Tech Stack:** TypeScript, TypeScript compiler API, Fastify, pg-boss, PostgreSQL/Drizzle, Vitest, AI SDK provider adapters.

## Global Constraints

- Keep clean-room separation and existing module boundaries; do not inspect any reference repository.
- Use TDD and real fixture repositories; unit tests require neither Docker nor a live model.
- Build from one immutable snapshot and never move the current release on failure.
- Preserve concurrent work and `.superpowers/`.

---

### Task 1: Code intelligence

**Files:**
- Create: `src/server/knowledge/intelligence.ts`
- Create: `src/server/knowledge/intelligence.test.ts`
- Create: `src/test/fixtures/code-intelligence/*`

**Interfaces:**
- Produces: `analyzeSnapshot(rootPath, commitSha): Promise<CodeIndex>` with exact citation ranges, symbols, edges, headings, structured config keys, and package scripts.

- [ ] Write fixture-backed tests asserting TS/JS symbols and import/export/call/test/dependency edges with exact lines.
- [ ] Run `npm test -- src/server/knowledge/intelligence.test.ts` and verify missing-module failure.
- [ ] Implement extraction with the TypeScript compiler API plus JSON/YAML/Markdown/config readers.
- [ ] Re-run the focused test to green and refactor only with the test green.

### Task 2: Deterministic synthesis and validation

**Files:**
- Create: `src/server/knowledge/generator.ts`
- Create: `src/server/knowledge/generator.test.ts`
- Create: `src/server/knowledge/enhancer.ts`

**Interfaces:**
- Consumes: `CodeIndex` from Task 1.
- Produces: `generateKnowledge(index, enhancer?)`, `chunkPage(page)`, and `validateKnowledge(output, snapshot)`; `KnowledgeEnhancer` is injected and failures become warnings.

- [ ] Write tests for all required deterministic pages, chunk boundaries, complete citations, invalid-path rejection, and enhancer fallback warnings.
- [ ] Run the focused generator test and verify expected missing-module failure.
- [ ] Implement deterministic pages/chunks and strict citation validation.
- [ ] Implement optional OpenAI-compatible and Anthropic AI SDK adapter factories without network use in tests.
- [ ] Re-run focused tests to green.

### Task 3: Build lifecycle and durable queue

**Files:**
- Create: `src/server/knowledge/build-service.ts`
- Create: `src/server/knowledge/build-service.test.ts`
- Create: `src/server/knowledge/job-queue.ts`

**Interfaces:**
- Produces: `BuildService` state transitions, cancellation/event subscription, one-active-build exclusion, recovery, and a `BuildJobQueue` implemented by pg-boss in production and fakes in tests.

- [ ] Write state transition, idempotent exclusion, cancellation, enhancer-warning, restart recovery, and failure-preservation tests.
- [ ] Run focused tests and verify expected missing-module failure.
- [ ] Implement stage-checked orchestration and queue adapters with cancellation between stages.
- [ ] Re-run focused tests to green.

### Task 4: Immutable persistence, weighted search, and releases

**Files:**
- Modify: `src/server/persistence/store.ts`
- Modify: `src/server/persistence/memory-store.ts`
- Modify: `src/server/persistence/postgres-store.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/0003_cited_knowledge_releases.sql`
- Create: `src/server/knowledge/search.test.ts`
- Create: `src/server/knowledge/releases.test.ts`

**Interfaces:**
- Produces store methods for build persistence, event history, immutable pages/chunks, ranked search, draft release creation, atomic publication, current/history reads, and source excerpts.

- [ ] Write failing memory-store behavioral tests and PostgreSQL SQL-contract tests for rank order and transactional publication.
- [ ] Run focused tests and verify failures identify missing store behavior.
- [ ] Extend contracts, schema, migration, and both stores; use repository/build-scoped immutable uniqueness and a transaction for channel updates.
- [ ] Re-run focused tests to green.

### Task 5: Authenticated HTTP and SSE contracts

**Files:**
- Modify: `src/server/app.ts`
- Create: `src/server/knowledge-routes.test.ts`

**Interfaces:**
- Consumes injected build/search/release services through `ServerOptions`.
- Produces build start/status/list/cancel/events, knowledge search/pages/source excerpt, and draft/publish/current/history endpoints.

- [ ] Write authenticated Fastify injection tests, including SSE framing and service injection.
- [ ] Run focused route tests and verify 404/missing route failures.
- [ ] Add schemas and routes while preserving existing authentication and error envelopes.
- [ ] Re-run focused route and existing server tests to green.

### Task 6: Verification and delivery

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `/tmp/devkh-sdd/task-3-report.md`

- [ ] Run focused tests, then `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- [ ] Review the diff for citation completeness, release immutability, atomicity, secret leakage, and concurrent-work preservation.
- [ ] Write red/green evidence, command results, concerns, and final commit SHA to the report.
- [ ] Commit only Task 3 files as `feat: build and publish cited code knowledge`.
