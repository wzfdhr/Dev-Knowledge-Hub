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
| POST | `/api/projects/:projectId/folder-import` | Multipart `files`: import a pre-filtered project folder into its active upload source |
| POST | `/api/repositories/:repositoryId/folder-import` | Multipart `files`: import a pre-filtered pending replacement and atomically activate it |
| GET/POST | `/api/builds` | List newest-first or start `{snapshotId}` |
| GET | `/api/builds/:id` | Build details |
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
| GET | `/api/feedback` | Optional `status` filter |
| PATCH | `/api/feedback/:id` | `{status}` constrained transition |
| POST | `/api/feedback/:id/rebuild` | Rebuild acknowledged feedback against published snapshot |
| * | `/mcp` | Bearer-authenticated Streamable HTTP MCP |

Rate-limited write buckets are setup, login, MCP, folder upload, and feedback transition/rebuild. A limit response is HTTP 429 with `Retry-After` and error code `RATE_LIMITED`.

## Folder uploads

The console scans and filters the selected directory in the browser, then sends only the accepted source and documentation files as multipart file parts with validated relative paths. Dependency directories such as `node_modules`, build output, binary files, generated files, secrets, and files over 1 MiB are excluded before transfer and are not included in snapshots, builds, or knowledge algorithms. The server repeats the path and content filtering before creating a snapshot.

Folder upload accepts at most 50,000 files and 2 GiB of accepted text. Every part must be named `files` and carry a safe, non-duplicate relative path. A successful response is `{snapshotId,sourceVersion,fileCount,unchanged,ignored}`, where `ignored` reports the server-side reason summary and `sourceVersion` is a deterministic 40-character hash of sorted accepted paths and contents. New snapshots return HTTP 201 and identical content returns HTTP 200. No ZIP archive is created or retained.

The endpoint returns HTTP 409 `UPLOAD_REPOSITORY_REQUIRED` when no active repository exists or the active repository is not kind `upload`. A Git/local replacement is immediately archived and switched. An upload replacement first returns HTTP 202 with `{repository,pendingUpload:true}` while the existing repository remains current; send its accepted folder files to `/api/repositories/:repositoryId/folder-import` to atomically activate the candidate. Failed imports discard the empty candidate and leave the former repository current.

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
