# HTTP and MCP API

## Conventions

The administration API uses JSON under `/api`. Except health, setup status, setup, and login, routes require the `devkh_session` cookie. Errors use `{ "error": { "code": string, "message": string } }`. JSON bodies are limited to 1 MiB. Source line ranges are inclusive and capped at 500 lines.

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
| POST | `/api/repositories` | Local `{kind,path,name}` or Git `{kind,url,name,token?}` |
| GET | `/api/repositories/current` | Current sanitized repository |
| GET | `/api/repositories/current/status` | Repository and latest snapshot |
| POST | `/api/repositories/current/sync` | Create/reuse immutable snapshot |
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
| POST | `/api/releases/:id/publish` | Explicit publication |
| GET | `/api/feedback` | Optional `status` filter |
| PATCH | `/api/feedback/:id` | `{status}` constrained transition |
| POST | `/api/feedback/:id/rebuild` | Rebuild acknowledged feedback against published snapshot |
| * | `/mcp` | Bearer-authenticated Streamable HTTP MCP |

Rate-limited write buckets are setup, login, MCP, and feedback transition/rebuild. A limit response is HTTP 429 with `Retry-After` and error code `RATE_LIMITED`.

## MCP tools

Both HTTP and stdio expose exactly these tools:

| Tool | Input | Behavior |
| --- | --- | --- |
| `dkh_search` | `{query,limit?}` (1-20) | Search current published knowledge |
| `dkh_get_architecture` | `{}` | Architecture overview |
| `dkh_get_module` | `{moduleId}` | Module page by title/slug |
| `dkh_get_symbol` | `{name,path?}` | Symbol page, optionally path-scoped |
| `dkh_get_change_context` | `{task,paths?}` (max 20 paths) | Affected cited knowledge for a proposed change |
| `dkh_get_source` | `{path,startLine?,endLine?}` | Hash-verified excerpt, maximum 500 lines |
| `dkh_get_release` | `{}` | Current published release metadata |
| `dkh_report_gap` | `{query,reason,expected?}` | Only mutating tool; create cited feedback |

Successful tools return `{releaseId,commitSha,result,citations}` in structured content. Citations contain `path`, inclusive `startLine`/`endLine`, `commitSha`, and `blobHash`. Stable tool errors include `INVALID_INPUT`, `UNPUBLISHED`, `NOT_FOUND`, `CITATIONS_MISSING`, and `INTERNAL_ERROR`. Draft knowledge is never returned.

## Feedback transitions

Allowed transitions are `open -> acknowledged|dismissed` and `acknowledged -> fixed|dismissed`. Rebuild requires `acknowledged`, creates or reuses a build for the current published snapshot, and does not draft or publish a release.
