# Phase F Project Role Observation - 2026-07-20

## Scope and safety boundary

- Production commit: `1016a9d`.
- Public endpoint: `https://hub.starking.icu`.
- Kernel mode remains `shadow`; legacy releases remain the formal read path.
- No database migration, release creation, publication, rollback, persistent-volume change, or server-only Compose override change occurred.
- The test identities are temporary project-admin, member, and reader accounts in one existing project. Their credentials remain in a root-only `0600` server file and never enter Git, screenshots, or observation results.

## Browser acceptance

The first production browser run exposed presentation-level permission defects: non-workspace-admin accounts saw workspace member/settings navigation and an administrator label, while a reader saw the current knowledge-version command. Backend enforcement remained intact. Commit `1016a9d` added regression tests and aligned the React controls with the existing server authorization contract.

After deployment, isolated browser contexts repeated the three role flows at `1440x900` and `390x844`:

- project admin: collaboration loaded and member management was available;
- member: knowledge versions loaded and the permitted build/review command remained available;
- reader: knowledge versions and build history remained readable, with no write command;
- non-workspace-admin identities did not see workspace member/settings navigation;
- all six views had no document or heading overflow, and the mobile menu was visible;
- no post-login HTTP `500` response or browser console error was recorded.

The root-only evidence directory is `/var/lib/devkh-monitor/f04-role-observation/acceptance-20260720T012055Z`. Its sanitized `acceptance.json` SHA-256 is `bed9895a063809579dc477586d22988a209cf4dbb4a3c26d638694418671c36b`; six PNG files are retained beside it with server-generated checksums.

## Continuous observation

`devkh-f04-role-observation.timer` runs every 15 minutes. Each run is isolated and performs only the following bounded checks:

- public health;
- login, session read, authorized project summary, and cross-project denial for all three roles;
- project-admin access to the available-member surface;
- member and reader repository/build reads;
- denial of project-admin membership controls for member and reader;
- denial of a reader build request before any build can be created; and
- CSRF-protected logout.

The timer does not create builds, releases, publications, members, uploads, or feedback. Results contain role names, check names, expected/actual HTTP status, timestamps, and pass/fail only.

- Window start: `2026-07-20T01:24:08Z`.
- Window deadline: `2026-07-21T01:24:08Z`.
- Final result: the deadline passed and `latest.json` is `window_complete` at `2026-07-21T01:51:50Z`.
- The recorded runs remained passed with 0 failed checks and 24 checks per run; the final accepted run at `2026-07-21T01:21:11Z` passed all checks.
- Evidence: `/var/lib/devkh-monitor/f04-role-observation/results.jsonl` and `latest.json`, both root-only.

After the deadline, the three identities were disabled in one database transaction, their session versions were incremented, any remaining sessions were revoked, and three `member.disabled` audit events were recorded with observation id `f04-roles-20260720T004205Z`. A post-cleanup query found zero active sessions for the identities. The technical-manager and product-manager reviews are the remaining project-level F04 gate. `active` remains forbidden.
