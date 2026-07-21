# HTTP and MCP API

## Conventions

The administration API uses JSON under `/api`. Except health, setup status, setup, and login, routes require the `devkh_session` cookie. Errors use `{ "error": { "code": string, "message": string } }`. JSON bodies are limited to 1 MiB. Source line ranges are inclusive and capped at 500 lines. List routes accept `limit` (1-100, default 50) and `offset` (default 0) and return stable ordering.

## HTTP routes

| Method | Path | Purpose / primary input |
| --- | --- | --- |
| GET | `/api/health` | Liveness payload |
| GET | `/api/setup/status` | Whether initial setup is required |
| POST | `/api/setup` | `{email,password}`; single-use setup |
| POST | `/api/session` | `{email,password}`; set session cookie |
| GET/DELETE | `/api/session` | Read or clear session |
| GET/PUT | `/api/settings/model` | Sanitized config; PUT `{provider,model,apiKey?}` |
| GET | `/api/settings/mfa` | Administrator MFA state: enabled, pending enrollment, and temporary lock |
| POST | `/api/settings/mfa/enroll` | Verify `{currentPassword}` and issue a one-time TOTP enrollment secret |
| POST | `/api/settings/mfa/verify` | Confirm pending `{code}` and return one-time recovery codes |
| DELETE | `/api/settings/mfa` | Disable MFA using `{currentPassword,code}`; revokes all sessions |
| GET/POST | `/api/projects` | List projects or create `{name,slug}` |
| GET | `/api/projects/:projectId/summary` | Project source, latest snapshot/build, current release, and team count |
| GET | `/api/projects/:projectId/activity` | Paginated project-isolated audit activity plus workspace members |
| POST | `/api/projects/:projectId/repositories` | Attach the project's initial upload, Git HTTPS, or server-local source |
| GET | `/api/projects/:projectId/codex-connection` | Generated project-scoped Codex config and `AGENTS.md` templates |
| GET/POST | `/api/members` | List workspace members or create `{email,password,role}` as administrator |
| GET/POST | `/api/mcp/tokens` | List sanitized tokens, optionally by `projectId`; create `{name,projectId,scopes?}` with one-time plaintext, fixed 90-day expiry, and only `search` / `source.read` scopes |
| POST | `/api/mcp/tokens/:id/revoke` | Revoke token |
| GET | `/api/mcp/connection` | Transport/tool metadata |
| POST | `/api/repositories` | Local `{kind,path,name}`, Git `{kind,url,name,token?}`, or upload `{kind:"upload",name}` |
| POST | `/api/repositories/current/replace` | Archive the current Git/local source and activate a replacement; upload replacements return a pending candidate |
| GET | `/api/repositories/archived` | Sanitized, read-only archived repository history |
| GET | `/api/repositories/current` | Current sanitized repository |
| GET | `/api/repositories/current/status` | Repository and latest snapshot |
| POST | `/api/repositories/current/sync` | Create/reuse immutable snapshot |
| POST | `/api/projects/:projectId/upload-sessions` | Create a 24-hour resumable session with `{repositoryId,entryCount}` and `Idempotency-Key` |
| PUT | `/api/projects/:projectId/upload-sessions/:sessionId/manifest-pages/:page` | Submit up to 500 ordered source/asset manifest entries with `Idempotency-Key` |
| PUT | `/api/projects/:projectId/upload-sessions/:sessionId/files/:ordinal` | Submit one server-required source file as `application/octet-stream` with `Idempotency-Key` |
| POST | `/api/projects/:projectId/upload-sessions/:sessionId/commit` | Verify and commit `{manifestDigest}` with `Idempotency-Key` |
| DELETE | `/api/projects/:projectId/upload-sessions/:sessionId` | Cancel an unfinished session with `Idempotency-Key` |
| POST | `/api/projects/:projectId/folder-import` | Compatibility-only multipart folder import |
| POST | `/api/repositories/:repositoryId/folder-import` | Compatibility-only multipart replacement import |
| GET/POST | `/api/builds` | List newest-first or start `{snapshotId}` |
| GET | `/api/builds/:id` | Build details |
| GET | `/api/builds/:id/comparison` | Workspace-admin-only, read-only comparison of legacy and persisted shadow-pipeline output for one build |
| POST | `/api/builds/:id/cancel` | Request cancellation |
| GET | `/api/builds/:id/events` | SSE history/live stream; `once=true` returns buffered events |
| GET | `/api/knowledge/search` | `q`, optional `releaseId` |
| GET | `/api/knowledge/metadata` | Required `releaseId` symbol/dependency metadata |
| GET | `/api/knowledge/pages` | Optional `releaseId` |
| GET | `/api/knowledge/pages/:id` | Page and chunks/citations |
| GET | `/api/knowledge/source` | `path,startLine,endLine,releaseId?` hash-verified excerpt |
| GET/POST | `/api/releases` | List or draft `{buildId,version}` |
| GET | `/api/releases/current` | Current published release plus commit |
| GET | `/api/releases/:id` | Exact workspace-scoped release plus commit; stable `RELEASE_NOT_FOUND` |
| POST | `/api/releases/:id/publish` | Explicit publication |
| POST | `/api/releases/:id/rollback` | Workspace-admin only: repoint `current` to an already published legacy release, returning the prior release ID; `409 ROLLBACK_NOT_ALLOWED` for an ineligible target |
| GET | `/api/feedback` | Optional `status` filter |
| PATCH | `/api/feedback/:id` | `{status}` constrained transition |
| POST | `/api/feedback/:id/rebuild` | Rebuild acknowledged feedback against published snapshot |
| * | `/mcp` | Bearer-authenticated Streamable HTTP MCP |

Rate-limited write buckets are setup, login, MCP, folder upload, and feedback transition/rebuild. A limit response is HTTP 429 with `Retry-After` and error code `RATE_LIMITED`.

## Folder uploads

The console scans and filters the selected directory before transfer. Dependency directories such as `node_modules`, build output, generated files, secrets, and oversized source files are excluded without reading their contents. Local pre-filter totals are shown for the current selection but are not persisted as trusted audit data; import report `ignored` totals contain only server-verified manifest filtering. Images, fonts, and media are represented only by path, byte size, and media type; their bytes are neither read nor uploaded, their content hash is `null`, and their trust is fixed to `client_unverified`. Asset metadata cannot create knowledge facts, Graph edges, or citations.

The browser hashes accepted source files with Web Crypto in a module Worker, creates a session, submits manifest pages out of order if needed, and uploads only entries returned as `upload_required`. Every mutation is idempotent. The session is bound to workspace, project, repository, actor, session version, current source, and the latest published snapshot observed at creation; a stale session cannot replace newer imported content, while identical content reuses the published snapshot. Every request rechecks authorization, and disablement, membership removal, password/session rotation, cancellation, or expiry invalidates unfinished work. Browser resume hints contain only an idempotency key and creation time, never source bytes.

Folder upload accepts at most 50,000 accepted source files, 100,000 total manifest entries, 32 MiB of canonical manifest metadata, and 2 GiB of accepted text. The browser uploads source decisions page by page instead of retaining the complete decision set. The server revalidates paths, content bytes, hashes, filters, and limits before creating a snapshot. A successful response is `{snapshotId,sourceVersion,fileCount,textBytes,unchanged,ignored,assetCount}`. `sourceVersion` is a deterministic 40-character hash of sorted accepted paths and contents. New snapshots return HTTP 201 and identical content returns HTTP 200. No ZIP archive is created or retained. Expired unfinished sessions and staged bytes are cleaned periodically.

Production PostgreSQL pools must allow at least four connections. Upload body permits are acquired only after session and project authorization; incomplete requests are bounded by the server connection and request timeouts.

An upload replacement first returns HTTP 202 with `{repository,pendingUpload:true}` while the existing repository remains current. Create the upload session with that repository ID; a successful commit atomically activates the candidate. Failed or interrupted imports leave the former repository current. The multipart routes remain temporarily available for compatibility, but the React console no longer uses them.

## Git outbound policy

Git synchronization only permits credential-free public `https` remotes on port `443`. The server validates literal IP hosts and every DNS answer before repository preparation, validates again immediately before `clone` or `fetch`, and disables Git HTTP redirect following. Loopback, link-local, private, carrier-grade NAT, unique-local IPv6, and unspecified addresses return `GIT_EGRESS_DENIED` without exposing the resolved address.

## MCP tools

Both HTTP and stdio expose exactly these tools:

| Tool | Input | Behavior |
| --- | --- | --- |
| `dkh_search` | `{query,limit?}` (1-20) | Search current published knowledge |
| `dkh_get_architecture` | `{}` | Architecture overview |
| `dkh_get_module` | `{moduleId}` | Module page by title/slug |
| `dkh_get_symbol` | `{name,path?}` | Symbol page, optionally path-scoped |
| `dkh_get_change_context` | `{task,paths?}` (max 3 optional hints) | Discovers affected modules, relationships, tests, and conventions from task terms; every accepted path refines context |
| `dkh_get_source` | `{path,startLine?,endLine?}` | Hash-verified excerpt, maximum 500 lines |
| `dkh_get_release` | `{}` | Current published release metadata plus page/chunk/citation counts |
| `dkh_report_gap` | `{query,reason,expected?}` | Only mutating tool; create feedback with at least one validated current-release citation |

Successful tools return `{releaseId,commitSha,result,citations}` in structured content. Citations contain `path`, inclusive `startLine`/`endLine`, `commitSha`, and `blobHash`. Tool strings are bounded (500 characters for queries, names, modules, and paths; 2,000 for task/reason/expected text), search results are capped at 20, page chunks at 50, citations per chunk at 8, and envelope citations at 50. `dkh_get_release` returns counts rather than every release citation. Stable tool errors include `INVALID_INPUT`, `UNAUTHORIZED`, `UNPUBLISHED`, `NOT_FOUND`, `CITATIONS_MISSING`, and `INTERNAL_ERROR`. Draft knowledge is never returned. Authorization is rechecked before every HTTP or stdio tool call.

## Feedback transitions

Allowed transitions are `open -> acknowledged|dismissed` and `acknowledged -> fixed|dismissed`. Rebuild requires `acknowledged`, persists the feedback IDs plus query/reason/expected/citations as generation context, and does not draft or publish a release. An active build is reused only when snapshot, build purpose, and feedback identity all match.
