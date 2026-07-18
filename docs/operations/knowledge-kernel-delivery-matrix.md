# Knowledge Kernel Delivery Matrix

Updated: 2026-07-17

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
| 7. Shadow rollout and production | F01-F03 implemented; F04 in progress | Administrator-only shadow comparison, PostgreSQL-backed load guardrails, immutable legacy rollback, fresh trusted CI verification, production backup, and `shadow` deployment | Complete an administrator test project, then the project-level role rollout and its 24-hour observations; do not enable `active` before F05 authorization |

## Phase F rollout evidence

| Item | Result | Evidence boundary |
| --- | --- | --- |
| F01 shadow comparison | Implemented and merged | Workspace-administrator-only comparison API reads persisted legacy and pipeline artifacts without changing a release. |
| F02 load guardrails | Implemented and merged | Tests cover ignored dependency directories, valid-file limits, concurrent imports/builds/searches, memory, and search latency. |
| F03 rollback | Implemented and merged | Only a published legacy release can atomically become current again; provenance and pipeline artifacts remain immutable. |
| F04 server preparation | Complete | A verified backup ran before deployment; the production app is healthy with `DEVKH_KNOWLEDGE_KERNEL_MODE=shadow`. Legacy remains the formal read path. The post-deployment monitor also passed after the installed operations scripts were synchronized. |
| F04 operations follow-up | Remediated | The monitor and recovery helper incorrectly treated the first grouped `restic snapshots --latest 1` result as globally newest. `898b008` and `62bc177` now select the latest remote timestamp explicitly; the installed backup script and protected configuration also include artifact storage. A manual run and the next scheduled monitor run completed with no failures. |
| F04 project rollout | In progress | The administrator test project completed import, legacy release and shadow comparison. Real temporary project-admin/member/reader sessions verified project-admin member-role management (`200`), member read/build (`200`/`202`), reader read (`200`), and reader cross-project denial (`403 PROJECT_ACCESS_DENIED`); the member-triggered shadow build completed all 10 stages. `15fe4b3` makes Compose pass the production `shadow` mode into the app, which was rechecked from the running container. On 2026-07-18, the deployed `9b5a84a` graph-edge deduplication fix and merged graph explorer replaced the prior image after a terminal shadow `graph` failure caused by duplicate deterministic edges. PR #11 then fixed deterministic content-address reuse in `synthesize`; its trusted merge gates passed and commit `2f11bab` was deployed. The app was deliberately recreated at `2026-07-18T04:26:54Z` with both production Compose files, preserving the Nginx loopback mapping. A new CSRF-protected temporary project-admin API session created build `19f860a1-e5c9-4536-a073-fa923527f61c`; all 10 stages, including `graph` and `synthesize`, completed as `reused`, and no release was created. That identity has no sessions or memberships and is disabled; audit history remains. Desktop/mobile browser acceptance and a new 24-hour role observation remain required before claiming completion. A workstation command-line TLS reset is a local tooling symptom, not evidence that the public site is unavailable. |
| F05 activation | Not started | `active` remains a configuration error before explicit user authorization after all F04 evidence is complete. |

## Release-gate policy

- Existing implementations are audited and completed in place; they are not rewritten without a failed requirement or test.
- A phase cannot merge while either `verify` or `container-smoke` is red. The private repository enforces this through `npm run phase:merge`, which dispatches the trusted `phase-merge.yml` workflow from `main` because its GitHub account plan does not provide private branch protection. The Phase B queued/running reconciliation and interrupted-run recovery gate is merged and remains covered by the PostgreSQL integration suite.
- PostgreSQL integration tests must execute with a real database for a release result; a conditional skip is not a release pass.
- A production change requires a separate user authorization during Phase F.
- `docker-compose.override.yml` is a local operator file and must remain untracked.
- A `shadow` deployment changes only future build processing. It cannot change the provenance or content read by an existing legacy release.
