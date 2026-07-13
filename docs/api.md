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
| GET/POST | `/api/mcp/tokens` | List sanitized tokens; create `{name}` with one-time plaintext |
| POST | `/api/mcp/tokens/:id/revoke` | Revoke token |
| GET | `/api/mcp/connection` | Transport/tool metadata |
| POST | `/api/repositories` | Local `{kind,path,name}`, Git `{kind,url,name,token?}`, or upload `{kind:"upload",name}` |
| POST | `/api/repositories/current/replace` | Archive the current Git/local source and activate a replacement; upload replacements return a pending candidate |
| GET | `/api/repositories/archived` | Sanitized, read-only archived repository history |
| GET | `/api/repositories/current` | Current sanitized repository |
| GET | `/api/repositories/current/status` | Repository and latest snapshot |
| POST | `/api/repositories/current/sync` | Create/reuse immutable snapshot |
| POST | `/api/repositories/current/uploads` | Multipart `file`: import one ZIP into the active upload repository |
| POST | `/api/repositories/:repositoryId/uploads` | Multipart `file`: complete a pending upload replacement and atomically activate it |
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

Rate-limited write buckets are setup, login, MCP, ZIP upload, and feedback transition/rebuild. A limit response is HTTP 429 with `Retry-After` and error code `RATE_LIMITED`.

## ZIP uploads

`POST /api/repositories/current/uploads` requires an authenticated session and exactly one `multipart/form-data` file part named `file`. The compressed ZIP limit is 500 MiB. Archives are rejected when they exceed 50,000 entries or 2 GiB expanded, are encrypted, contain symbolic links, or contain absolute, traversal, backslash, duplicate, or conflicting file/directory paths. Accepted snapshots apply the Git snapshot source filters, including exclusion of `.env`, binary, generated, and text files over 1 MiB. A successful response is `{snapshotId,sourceVersion,fileCount,unchanged,ignored}`, where `ignored` reports the count and reason summary for excluded files, and `sourceVersion` is a deterministic 40-character hash of sorted accepted paths and contents. New snapshots return HTTP 201 and identical content returns HTTP 200. Raw ZIP bytes and upload staging are removed after every attempt.

The endpoint returns HTTP 409 `UPLOAD_REPOSITORY_REQUIRED` when no active repository exists or the active repository is not kind `upload`. A Git/local replacement is immediately archived and switched. An upload replacement first returns HTTP 202 with `{repository,pendingUpload:true}` while the existing repository remains current; upload the ZIP to `/api/repositories/:repositoryId/uploads` to atomically activate the candidate. Failed imports discard the empty candidate and leave the former repository current.

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
