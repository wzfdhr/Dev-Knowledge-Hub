# Upload Staging Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically reclaim expired resumable upload staging data without deleting active uploads.

**Architecture:** Keep cleanup rules inside `ResumableUploadSessionManager`, then have production bootstrap invoke it once and on an hourly timer. All deletion remains constrained to the existing upload-staging root.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Fastify lifecycle hooks.

## Global Constraints

- Expiry is 24 hours based on filesystem modification time.
- The cleanup task must not block server startup when it fails.
- No external alert provider is configured in this task.

---

### Task 1: Add safe upload-staging cleanup

**Files:**
- Modify: `src/server/uploads/resumable-upload.ts`
- Test: `src/server/uploads/resumable-upload.test.ts`

**Interfaces:**
- Produces: `ResumableUploadSessionManager.cleanupExpired(now?: Date): Promise<{ sessions: number; completed: number }>`.

- [ ] Add a failing unit test with one old session, one fresh session, one old orphaned completed upload, and one completed upload referenced by the fresh session.
- [ ] Run `npx vitest run src/server/uploads/resumable-upload.test.ts` and observe the missing cleanup method failure.
- [ ] Implement root-constrained expiry cleanup using `lstat`, `readdir`, metadata validation, and 24-hour age checks.
- [ ] Re-run the focused test and verify all upload tests pass.

### Task 2: Schedule cleanup in production bootstrap

**Files:**
- Modify: `src/server/bootstrap.ts`
- Test: `src/server/bootstrap.test.ts`

**Interfaces:**
- Consumes: `ResumableUploadSessionManager.cleanupExpired`.
- Produces: a startup cleanup pass, hourly interval, and interval cancellation in the Fastify close hook.

- [ ] Add a failing bootstrap test using injected cleanup and timer dependencies.
- [ ] Run `npx vitest run src/server/bootstrap.test.ts` and observe the missing lifecycle behavior.
- [ ] Add best-effort startup cleanup, hourly scheduling, error logging, and close-hook cleanup.
- [ ] Re-run the focused test and verify all bootstrap tests pass.

### Task 3: Verify the production build

**Files:**
- Modify: `docs/operations/encrypted-offsite-backups.md` only if operational behavior needs clarification.

- [ ] Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run test:backup`.
- [ ] Build and deploy the changed application image to `/opt/dev-knowledge-hub` without replacing server-only backup configuration.
- [ ] Verify the app and PostgreSQL health checks, then confirm cleanup startup appears in the service log.
