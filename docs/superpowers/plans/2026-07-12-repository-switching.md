# Repository Switching With Archived History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace a workspace's current repository without deleting the previous repository's knowledge history.

**Architecture:** Repositories gain an archive timestamp. PostgreSQL enforces exactly one non-archived repository per workspace. A store transaction inserts a replacement and its encrypted credential, archives the current repository, and records both identities in the audit trail. All current HTTP, build, release, search, and MCP flows continue to resolve only the non-archived repository.

**Tech Stack:** PostgreSQL 16, Drizzle migrations, Fastify 5, React 19, Vitest, Playwright.

## Global Constraints

- A workspace has exactly one current repository and may have archived repositories.
- Archived snapshots, releases, pages, citations, feedback, credentials, and audit history remain immutable.
- A failed replacement leaves the existing current repository unchanged.
- MCP reads only the current repository's published release.
- Credentials stay encrypted and never appear in API responses.
- No multi-active-repository mode, cross-repository search, or archived MCP access.

---

### Task 1: Repository Archive Persistence and Atomic Switch

**Files:**
- Create: drizzle/0009_repository_archives.sql
- Modify: src/db/schema.ts
- Modify: src/server/persistence/store.ts
- Modify: src/server/persistence/memory-store.ts
- Modify: src/server/persistence/postgres-store.ts
- Test: src/db/task-2-schema.test.ts
- Test: src/server/persistence/postgres-store.test.ts
- Test: src/server/persistence/atomic-mutations.test.ts

**Interfaces:**
- RepositoryRecord gains archivedAt: Date | null.
- AppStore gains listArchivedRepositories(workspaceId) and switchRepositoryWithAudit(workspaceId, input, actorId).
- currentRepository(workspaceId) returns the sole record with archived_at IS NULL.

- [ ] **Step 1: Write failing persistence tests**

Test that an original repository stays associated with its release after a switch, the replacement becomes current, and the original appears in archived history. Add a transaction failure fixture where replacement credential creation throws and verify the original remains current.

- [ ] **Step 2: Run the focused persistence suite**

Run: npx vitest run src/db/task-2-schema.test.ts src/server/persistence/postgres-store.test.ts src/server/persistence/atomic-mutations.test.ts

Expected: FAIL because the schema has a workspace-wide unique repository index and no archive state.

- [ ] **Step 3: Implement the database and store change**

Migration requirements:
- add repositories.archived_at as nullable timestamptz;
- drop repositories_workspace_unique_idx;
- create a partial unique index on workspace_id where archived_at is null;
- backfill all existing repository rows as current.

In both stores, create replacement first, then archive the old current repository and write one repository.switched audit event with oldRepositoryId and newRepositoryId. Roll back all changes when candidate creation or credential creation fails.

- [ ] **Step 4: Verify focused persistence tests**

Run the command from Step 2.

Expected: PASS with immutable old releases and exactly one current repository.

- [ ] **Step 5: Commit**

Commit message: feat: archive repositories during workspace switch

### Task 2: Repository Replacement HTTP API and MCP Isolation

**Files:**
- Modify: src/server/app.ts
- Modify: src/server/repository-routes.test.ts
- Modify: src/server/mcp-access.test.ts
- Modify: src/server/knowledge/releases.test.ts
- Modify: docs/api.md

**Interfaces:**
- POST /api/repositories/current/replace accepts the existing local or HTTPS Git connection schema.
- GET /api/repositories/archived returns sanitized archive records.
- Existing current repository endpoints and MCP tools retain their paths and select only the current repository.

- [ ] **Step 1: Write failing route and MCP tests**

Cover successful replacement, no-current-repository failure, sanitized credential response, replacement rollback, and an MCP release lookup that returns the replacement release rather than an archived release.

- [ ] **Step 2: Run focused server tests**

Run: npx vitest run src/server/repository-routes.test.ts src/server/mcp-access.test.ts src/server/knowledge/releases.test.ts

Expected: FAIL because replacement and archive-list routes do not exist.

- [ ] **Step 3: Implement the routes**

Reuse repositorySchema, encrypt a supplied Git token before passing it to the store, return repositoryDto only, and invalidate no prior release records. Archive-list responses include id, name, kind, archivedAt, and read-only release summary; they contain no paths with credentials, tokens, or encrypted values.

- [ ] **Step 4: Verify focused server tests**

Run the command from Step 2.

Expected: PASS; ordinary MCP queries cannot select archived history.

- [ ] **Step 5: Commit**

Commit message: feat: add safe repository replacement routes

### Task 3: Settings Replacement and Archived History UI

**Files:**
- Modify: src/client/api/types.ts
- Modify: src/client/api/client.ts
- Modify: src/client/pages/settings-page.tsx
- Modify: src/client/app.test.tsx
- Test: tests/e2e/console.spec.ts

**Interfaces:**
- ApiClient gains replaceRepository(input) and listArchivedRepositories().
- The repository connection form supports initial connection and explicit replacement modes.
- Replacing requires a confirmation dialog naming the outgoing repository.

- [ ] **Step 1: Write failing UI tests**

Assert that a connected repository has a Chinese 更换仓库 command; confirmation names the outgoing repository and explains that history is retained read-only; success renders the archived repository under 已归档仓库; failure leaves current repository information visible.

- [ ] **Step 2: Run focused client tests**

Run: npx vitest run src/client/app.test.tsx -t "repository replacement"

Expected: FAIL because Settings has no replacement control or archive list.

- [ ] **Step 3: Implement UI behavior**

Show the existing connection form only for first connection. On replacement, require confirmation, submit only after confirmation, close the dialog on success, and invalidate repository, builds, releases, feedback, and archive-list queries. Do not automatically sync the replacement. Render archive name, kind, archive time, and latest published version as read-only history.

- [ ] **Step 4: Verify focused UI tests**

Run the command from Step 2.

Expected: PASS with no plaintext token rendering.

- [ ] **Step 5: Extend E2E**

Connect a first fixture, publish it, replace it with a second fixture, verify archived history is visible, then verify Overview requires syncing the replacement. At 390px, verify the replacement command and confirmation dialog remain within the viewport.

- [ ] **Step 6: Run final verification**

Run separately:

    npm test
    npm run typecheck
    npm run lint
    npm run build
    npm run test:e2e

Expected: every command exits 0; PostgreSQL integration remains explicitly skipped only when TEST_DATABASE_URL is unset.

- [ ] **Step 7: Commit**

Commit message: feat: let administrators replace repositories
