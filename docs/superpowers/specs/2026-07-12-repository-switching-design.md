# Repository Switching With Archived History

## Goal

Allow an administrator to replace a workspace's current repository without deleting previous repository knowledge. The outgoing repository becomes archived; its snapshots, releases, pages, citations, and feedback remain available to the administrator as read-only history.

## User Flow

1. In Settings, the administrator selects **更换仓库** from the current repository section.
2. The replacement form accepts the same local-path or HTTPS Git connection data as first-time setup.
3. The form clearly identifies the current repository that will be archived.
4. On a successful connection, the old repository is archived and the new repository becomes the sole current repository in one transaction.
5. The administrator explicitly syncs, builds, reviews, and publishes knowledge for the new repository.
6. Settings lists archived repositories and permits read-only historical inspection.

## Data and API Rules

- A workspace may contain multiple repository records, but exactly one is current.
- Repository records receive an archival marker and retain their original IDs.
- Existing snapshots, releases, knowledge pages, chunks, citations, feedback, encrypted credentials, and audit events retain their original repository association.
- `GET /api/repositories/current`, synchronization, build, publish, overview, and standard Knowledge views resolve only the current repository.
- A replacement endpoint validates and creates the candidate repository before archiving the current record. Candidate failure leaves the existing current repository unchanged.
- Repository credentials remain encrypted; clients never receive plaintext credentials.

## Agent and History Boundaries

- MCP tools continue to read only the current repository's published release.
- Archived repository history is administrator-only and read-only.
- The MVP does not add cross-repository search, multi-repository builds, or Agent selection of archived repositories.

## UI Rules

- The Settings repository section has one primary command: **更换仓库** when a current repository exists.
- The replacement operation requires explicit confirmation naming the outgoing repository.
- The archived-history list shows repository name, kind, archive time, and last published version when one exists.
- Failed replacement connection or initial validation preserves the existing screen and current repository.

## Tests and Acceptance

- Unit and PostgreSQL integration coverage proves one-current-repository enforcement, atomic switch, archived history retention, and failed-switch rollback.
- Route tests cover authorization, sanitized responses, and never returning credentials.
- MCP contract tests prove an archived repository is not readable through normal tools.
- Playwright covers connect, switch confirmation, archived history visibility, new-repository sync, and mobile controls.

## Non-Goals

- No deletion or mutation of archived knowledge history.
- No multiple active repositories per workspace.
- No archived-repository access through MCP in this MVP.
