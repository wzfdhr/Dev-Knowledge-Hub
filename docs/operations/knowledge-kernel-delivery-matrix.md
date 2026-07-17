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
| 2. Durable pipeline foundation | Foundation implemented; full pipeline not wired | Stage contracts, stage/event tables, content-addressed artifacts, pg-boss worker, stage API/SSE, invalidation planning | Add kernel modes, database-led orchestration, retry/reconciliation, all ten executors, release provenance and shadow compatibility |
| 3. Knowledge IR and adapters | Parsers implemented; durable execution incomplete | Web and Vue extraction, document/config parsing, bounded CSV/XLSX extraction, optional validated LLM enhancement | Run adapters through immutable stage artifacts and verify production limits and fallback behavior |
| 4. Graph | Core implementation present; pipeline integration incomplete | Graph construction, persistence, release-scoped queries, REST/MCP reads, Mermaid/Markmap exports and React graph page | Produce Graph through the durable pipeline, compare it with legacy output and keep visualization non-blocking |
| 5. Retrieval, quality and remediation | Partially implemented | Chinese-aware evaluation, Graph-aware ranking foundations, deterministic lint/trust, remediation persistence/API, quality artifacts and stage status | Complete the quality workbench, local rebuild semantics, PostgreSQL search artifacts, CI quality thresholds and explainable ranking |
| 6. Frontend migration | Vue experiment only; migration cancelled by product decision | Isolated Vue shell and CSP/build proof | Remove the Vue administration entry and dependencies in Phase E; keep the React product and `@vue/compiler-sfc` knowledge adapter |
| 7. Shadow rollout and production | F01-F03 implemented; F04 in progress | Administrator-only shadow comparison, PostgreSQL-backed load guardrails, immutable legacy rollback, fresh trusted CI verification, production backup, and `shadow` deployment | Complete an administrator test project, then the project-level role rollout and its 24-hour observations; do not enable `active` before F05 authorization |

## Phase F rollout evidence

| Item | Result | Evidence boundary |
| --- | --- | --- |
| F01 shadow comparison | Implemented and merged | Workspace-administrator-only comparison API reads persisted legacy and pipeline artifacts without changing a release. |
| F02 load guardrails | Implemented and merged | Tests cover ignored dependency directories, valid-file limits, concurrent imports/builds/searches, memory, and search latency. |
| F03 rollback | Implemented and merged | Only a published legacy release can atomically become current again; provenance and pipeline artifacts remain immutable. |
| F04 server preparation | Complete | A verified backup ran before deployment; the production app is healthy with `DEVKH_KNOWLEDGE_KERNEL_MODE=shadow`. Legacy remains the formal read path. |
| F04 project rollout | Pending | The administrator test-project flow and the subsequent 24-hour role observations require an externally reachable, authenticated administrator session. The current workstation's public network injects/resets TLS for the domain, so this evidence is intentionally not claimed yet. |
| F05 activation | Not started | `active` remains a configuration error before explicit user authorization after all F04 evidence is complete. |

## Release-gate policy

- Existing implementations are audited and completed in place; they are not rewritten without a failed requirement or test.
- A phase cannot merge while either `verify` or `container-smoke` is red. The private repository enforces this through `npm run phase:merge`, which dispatches the trusted `phase-merge.yml` workflow from `main` because its GitHub account plan does not provide private branch protection. Phase B must additionally close the queued/running stage reconciliation and interrupted-run recovery gate before its own review can pass.
- PostgreSQL integration tests must execute with a real database for a release result; a conditional skip is not a release pass.
- A production change requires a separate user authorization during Phase F.
- `docker-compose.override.yml` is a local operator file and must remain untracked.
- A `shadow` deployment changes only future build processing. It cannot change the provenance or content read by an existing legacy release.
