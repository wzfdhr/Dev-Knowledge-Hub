# Upload Staging Cleanup Design

## Goal

Keep abandoned resumable-upload data from consuming persistent server disk while preserving
active uploads and completed files that are still being imported.

## Scope

- A resumable session is expired after 24 hours from its metadata file modification time.
- A completed upload file that has no matching resumable session finalization record is an
  orphan and is deleted after 24 hours from its own modification time.
- Cleanup never follows symlinks, deletes only entries beneath the configured upload-staging
  root, and treats malformed session metadata as expired after 24 hours.
- Production starts a periodic cleanup pass after the build service starts and stops that
  timer during graceful shutdown. A cleanup failure is logged but does not prevent the app
  from serving requests.

## Non-goals

- Do not delete active sessions based on upload progress alone.
- Do not add an external alert provider or store notification credentials. That requires a
  separately chosen delivery channel.
- Do not change upload limits, authorization, archive import behavior, or backup retention.

## Design

`ResumableUploadSessionManager` exposes `cleanupExpired(now)` so cleanup rules share the
same root-path and filename validation as normal upload operations. It first identifies
completed files referenced by non-expired sessions, then removes expired session directories,
and finally removes old unreferenced completed files. Recent completed files are retained to
avoid racing an in-progress import.

`bootstrapServer` owns the periodic lifecycle: it runs one best-effort pass at startup,
repeats every hour, and clears the interval in the existing Fastify close hook. The manager
and cleanup interval are injected through dependencies to keep bootstrap tests deterministic.

## Verification

- Unit tests prove expired sessions and orphaned completed files are removed, while fresh
  sessions and files referenced by fresh sessions remain.
- Bootstrap tests prove startup cleanup, hourly scheduling, failure logging, and shutdown
  cancellation without real timers.
- Existing upload, lint, typecheck, and full test suites remain green.
