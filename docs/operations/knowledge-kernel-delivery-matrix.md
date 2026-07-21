# Knowledge Kernel Delivery Matrix

Updated: 2026-07-20

## Phase A baseline

| Item | Value |
| --- | --- |
| Phase branch | `codex/phase-a-release-baseline` |
| Phase baseline commit | `ecfc5c7` |
| Merged `main` commit | `8cdde05` |
| Supplemental commits retained | `99ad06b`, `28408aa`, `94f8340` |
| Unit/component baseline | 81 files and 397 tests passed |
| Conditional skips | 1 PostgreSQL integration file and 9 tests skipped without `TEST_DATABASE_URL` |
| GitHub `verify` | Passed for PR #2 |
| GitHub `container-smoke` | Failed because Compose required `DEVKH_DOMAIN` during CI validation |

The supplemental commits remain separate commits in Phase A. They are existing work to verify, not work to reimplement.

## Phase A verification result

| Item | Result |
| --- | --- |
| Authoritative review target | [Phase A PR #3](https://github.com/wzfdhr/Dev-Knowledge-Hub/pull/3) current head at user approval |
| Commit binding | `phase:merge` requires reviewed 40-character `main` base and PR head SHAs; fresh checks require base ancestry, and the final job creates a merge commit then atomically updates `main` with a base-specific Git lease |
| GitHub checks | The trusted merge workflow reruns `verify` and `container-smoke` against the approved head; only those fresh jobs can unlock its merge job |
| `verify` | Passed, including real PostgreSQL integration, build, acceptance, and E2E |
| `container-smoke` | Passed, including container health and isolated recovery rehearsal |
| Recovery artifact | The current head's `container-smoke` artifact named `recovery-evidence`, schema version 2 |
| Representative database restore | workspace, user, project, project member, snapshot, release, release channel, and artifact counts are each `1` |
| Durable file restore | snapshot, repository, uploaded source, and artifact file counts are each `1`; all four archive SHA-256 values recorded |
| Integrity | orphaned release/channel/artifact and invalid project-membership counts are all `0`; every artifact content digest is verified |
| Production state | No production deployment or production volume access occurred |

## Original seven-stage status

| Stage | Current status | Verified implementation | Remaining delivery work |
| --- | --- | --- | --- |
| 0. Baseline hardening | Implemented; release evidence verified | MCP token rotation, scoped activity output, Vue console experiment, retrieval evaluation v2 | Keep the green container and PostgreSQL gates mandatory; remove the retired Vue console in Phase E while retaining Vue source parsing |
| 1. Security and operations | Implemented; isolated recovery verified | Persistent sessions, CSRF, administrator MFA, expiring scoped MCP tokens, Git egress policy, secret/license/runtime checks, backup and restore scripts | Retain production rollout as a later user-authorized action |
| 2. Durable pipeline foundation | Implemented and merged | Database-led stage runs, pg-boss delivery/reconciliation/retry recovery, all ten executors, content-addressed artifacts, immutable release provenance, legacy/shadow isolation, and stage API/SSE | F04 proves the same path on representative production projects; F05 is the only phase that may activate it. |
| 3. Knowledge IR and adapters | Implemented and merged | Immutable convert artifacts, Web/Vue/document/config extraction, bounded CSV/XLSX processing, deterministic synthesis, and opt-in manual-build LLM fallback | F04 validates production-sized representative sources and fallback evidence. |
| 4. Graph | Implemented and merged | Pipeline-produced Graph persistence, project-scoped REST/MCP reads, comparison output, Mermaid/Markmap artifacts, and React graph browsing | F04 compares representative legacy and shadow Graph results without publishing a pipeline release. |
| 5. Retrieval, quality and remediation | Implemented and merged | PostgreSQL search artifacts, Chinese-aware evaluation gates, explainable ranking, governance workbench, Trust/Lint, and scoped remediation candidates | F04 validates administrator/member/reader flows and preserves the project-admin publication boundary. |
| 6. Frontend migration | React-only console completed | React is the sole administration entry; Vue runtime/route assets are removed while `@vue/compiler-sfc` remains a server-side knowledge parser dependency | F04 performs desktop/mobile product acceptance on the retained React product. |
| 7. Shadow rollout and production | F01-F04 project gate ready for final review | Administrator-only shadow comparison, PostgreSQL-backed load guardrails, immutable legacy rollback, fresh trusted CI verification, production backup, `shadow` deployment, browser acceptance, and completed project-role observation | Technical-manager and product-manager final review remain; then begin the separate non-critical-project observation. Do not enable `active` before F05 authorization |

## Phase F rollout evidence

| Item | Result | Evidence boundary |
| --- | --- | --- |
| F01 shadow comparison | Implemented and merged | Workspace-administrator-only comparison API reads persisted legacy and pipeline artifacts without changing a release. |
| F02 load guardrails | Implemented and merged | Tests cover ignored dependency directories, valid-file limits, concurrent imports/builds/searches, memory, and search latency. |
| F03 rollback | Implemented and merged | Only a published legacy release can atomically become current again; provenance and pipeline artifacts remain immutable. |
| F04 server preparation | Complete | A verified backup ran before deployment; the production app is healthy with `DEVKH_KNOWLEDGE_KERNEL_MODE=shadow`. Legacy remains the formal read path. The post-deployment monitor also passed after the installed operations scripts were synchronized. |
| F04 operations follow-up | Remediated | The monitor and recovery helper incorrectly treated the first grouped `restic snapshots --latest 1` result as globally newest. `898b008` and `62bc177` now select the latest remote timestamp explicitly; the installed backup script and protected configuration also include artifact storage. A manual run and the next scheduled monitor run completed with no failures. |
| F04 project rollout | Ready for final review | The administrator test project completed import, legacy release and shadow comparison. Real temporary project-admin/member/reader API sessions verified role boundaries and a member-triggered ten-stage shadow build. The strict shadow technical observation is complete. Commit `1016a9d` was deployed in `shadow` mode after production browser acceptance found and fixed role-control presentation defects. Six desktop/mobile views then passed without overflow, post-login `500`, or console errors. The 15-minute role probe ran from `2026-07-20T01:24:08Z` through the completed window, with the final accepted run at `2026-07-21T01:21:11Z` passing all 24 checks; `latest.json` recorded `window_complete` at `2026-07-21T01:51:50Z`. The three temporary identities were disabled, sessions revoked, and three cleanup audit events recorded. See [the project role observation record](./phase-f-2026-07-20-role-observation.md). Technical-manager and product-manager final review are next; after approval, all non-critical projects require a separate 24-hour observation and explicit user confirmation before whole-workspace expansion. |
| F05 activation | Not started | `active` remains a configuration error before explicit user authorization after all F04 evidence is complete. |

## Release-gate policy

- Existing implementations are audited and completed in place; they are not rewritten without a failed requirement or test.
- A phase cannot merge while either `verify` or `container-smoke` is red. The private repository enforces this through `npm run phase:merge`, which dispatches the trusted `phase-merge.yml` workflow from `main` because its GitHub account plan does not provide private branch protection. The Phase B queued/running reconciliation and interrupted-run recovery gate is merged and remains covered by the PostgreSQL integration suite.
- PostgreSQL integration tests must execute with a real database for a release result; a conditional skip is not a release pass.
- A production change requires a separate user authorization during Phase F.
- `docker-compose.override.yml` is a local operator file and must remain untracked.
- A `shadow` deployment changes only future build processing. It cannot change the provenance or content read by an existing legacy release.
