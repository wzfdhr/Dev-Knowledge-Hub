# FK18 Local TDD and Verification Report

## Status

FK18 is implemented locally on `codex/frontend-experience-kernel-design`. No deployment, push, merge, credential operation, production access, or `DEVKH_FRONTEND_KNOWLEDGE_MODE` change was performed. Product capability status remains `implemented-gated`; nothing in this change marks the new capabilities active in a production release.

## Requirement Scope

Implemented the files named by the FK18 brief:

- Created `src/server/knowledge/frontend/react-ecosystem-analyzer.ts`.
- Created `src/server/knowledge/frontend/react-ecosystem-analyzer.test.ts`.
- Created split evaluation evidence in `evaluation/frontend/train/react-trial.jsonl` and `evaluation/frontend/held-out/react-trial.jsonl`.
- Extended `src/shared/frontend-ir.ts` with precise relation kinds while retaining existing canonical entity kinds.
- Deepened Redux Toolkit and TanStack Query extraction in `state-data-analyzer.ts`.
- Deepened complete Storybook main-config extraction while preserving partial recognition for incomplete Storybook and V1.1 tooling in `tooling-test-analyzer.ts`.
- Linked CSS custom-property consumers to design-token definitions in `style-analyzer.ts`.
- Expanded the approved React 18 fixture with Redux Toolkit, TanStack Query, GraphQL/OpenAPI, React Hook Form/Zod, permission guard, Storybook story metadata, and component-wrapper evidence.
- Added machine-readable gated capability statuses to `evaluation/frontend/versions.json`.
- Corrected the product matrix so the seven approved V1 Trial capabilities are gated deep-support candidates and Webpack/Rspack/Rollup, Nx/Turbo, i18n, accessibility, error monitoring, and Web Vitals remain basic recognition targeted at V1.1.

The requested report is the only artifact outside the brief's implementation file list.

## Analyzer Design

### Canonical IR compatibility

The first implementation introduced dedicated canonical entity kinds for actions, selectors, queries, fields, validators, guards, and stories. `npm run typecheck` showed that this would require changing the exhaustive search mapping in `src/server/knowledge/frontend/search.ts`, which is outside the FK18 file boundary. The implementation was therefore refactored to preserve existing canonical kinds and express FK18 semantics through analyzer facets:

- Redux actions and selectors use `state_field` with `role=action|selector`.
- TanStack queries and mutations use `api_operation` with `queryKind`, static key, and fetcher facets.
- Zod validators use `data_schema` with `role=validator`.
- React Hook Form fields use `state_field` with `role=form-field`.
- Permission guards use `component` with `role=permission-guard`.
- CSF stories use `test_fixture` with `role=component-story`.

The IR adds explicit `dispatches`, `selects`, `invalidates`, `uses_token`, `documents`, `validates`, `guards`, and `wraps` edge kinds. This keeps graph semantics precise without changing exhaustive entity consumers outside the brief.

### Static-analysis boundaries

- Redux Toolkit extraction models `createSlice`, initial-state fields, reducer actions, selectors, `configureStore` slice wiring, `useSelector`, and dispatched known actions.
- TanStack Query extraction models statically named `useQuery`/`useMutation` variables, literal/identifier keys, fetcher names, consumers, and prefix-matched invalidation.
- GraphQL extraction accepts static `gql` documents and creates operation and fragment-schema facts.
- OpenAPI extraction requires a resolved import whose module name contains `openapi`, a known HTTP method call, and a static path for a complete operation.
- React Hook Form extraction requires a JSX form, static `register("field")` calls, and a statically linked resolver identifier.
- Permission guard facts require a guard-shaped function name and static JSX permission attributes.
- Storybook deep config requires a parseable `.storybook/main.*` default object with at least one story glob and an explicit framework. Incomplete configs remain partial basic recognition.
- Component-library wrapping requires a `forwardRef` wrapper rendering a resolved imported component.
- i18n, axe/accessibility, Sentry/error monitoring, and Web Vitals imports produce only partial parser-backed adoption evidence targeted at V1.1.
- Dynamic values remain partial or unknown; no source is evaluated and no network access is used by analyzers.

## TDD Record

### Cycle 1: existing analyzer expansion and delivery gates

1. Added `react-ecosystem-analyzer.test.ts` tests for Redux Toolkit, TanStack Query, Storybook promotion/basic recognition, token-use edges, split evaluation evidence, fixture dependencies, and gated product claims.
2. Added train and held-out evaluation files before production analyzer changes.
3. Ran:

   `npm test -- src/server/knowledge/frontend/react-ecosystem-analyzer.test.ts`

4. RED result: 6 tests executed; 5 failed and 1 passed. Failures were exactly the absent Redux/Query entities and edges, partial Storybook output, absent `uses_token` edges, and absent gated capability metadata.
5. Implemented the minimum IR, state, tooling, style, fixture, version-manifest, and matrix changes.
6. Re-ran the same command.
7. GREEN result: 1 test file passed, 6 tests passed.

### Cycle 2: new React ecosystem analyzer

1. Added tests for GraphQL/OpenAPI, form-validation/guard chains, CSF stories/component wrappers, and deferred-package basic recognition.
2. Used a dynamic module import so the missing analyzer produced a feature-attributable test failure.
3. Ran:

   `npm test -- src/server/knowledge/frontend/react-ecosystem-analyzer.test.ts`

4. RED result: 10 tests executed; the 4 new tests failed because `react-ecosystem-analyzer.js` did not exist, while the 6 prior tests stayed green.
5. Added the AST-based analyzer with stable IDs, source refs, provenance, bounded partial facts, and no runtime evaluation.
6. Re-ran the same command.
7. GREEN result: 1 test file passed, 10 tests passed.

### Regression-driven refinements

- The four-file focused suite initially found the old Storybook test expected an incomplete config to remain basic. The promotion condition was tightened to require both stories and framework evidence. Re-run: 4 files passed, 22 tests passed.
- Initial typecheck found canonical entity-kind expansion would force an out-of-scope `search.ts` edit. The representation was refactored to existing kinds plus facets. Re-run: 4 files passed, 22 tests passed; typecheck passed.
- The first full `npm test` found 6 failures because existing analyzer versions had been changed to `1.1.0` without an allowed registry edit. Existing versions were restored to registered `1.0.0`; changed parser config digests still invalidate provenance/cache identities.
- The focused compatibility re-run then found one fixture regression: the existing React analyzer expected local consumer names `loading` and `error`. Stable aliases were restored while retaining the TanStack Query implementation. Re-run: 3 files passed, 15 tests passed.

## Final Verification

All commands below were run from `/Users/start/Desktop/知识库系统/dev-knowledge-hub/.worktrees/frontend-experience-kernel-design` after the final implementation changes.

| Command | Result |
|---|---|
| `npm test -- src/server/knowledge/frontend/react-ecosystem-analyzer.test.ts src/server/knowledge/frontend/state-data-analyzer.test.ts src/server/knowledge/frontend/tooling-test-analyzer.test.ts src/server/knowledge/frontend/style-analyzer.test.ts` | PASS: 4 files, 22 tests |
| `npm test -- src/server/knowledge/frontend/runtime/analyzer-worker.test.ts src/server/knowledge/frontend/graph-builder.test.ts src/server/knowledge/pipeline/b02-shadow-pipeline.test.ts` | PASS: 3 files, 15 tests |
| `npm test` | PASS: 154 files passed, 1 skipped; 975 tests passed, 34 skipped |
| `npm run typecheck` | PASS: client and node TypeScript projects |
| `npm run lint` | PASS: ESLint exit 0 |
| `git diff --check` | PASS: no whitespace errors in tracked diff |

The full test run emitted the repository's existing jsdom `getComputedStyle()` pseudo-element warnings; they did not fail tests.

## Scope and Safety Audit

- Implementation changes are limited to the FK18 brief files.
- The report file was added at the explicitly requested path.
- No production configuration or active mode was changed.
- No migration, deployment, push, merge, PR, credential, or external environment action was performed.
- Existing worktree changes were preserved; the worktree was clean before FK18 edits.

## Residual Concerns

1. The new `react-ecosystem-core` analyzer is intentionally not registered in `analyzer-worker.ts` because that file is outside the FK18 brief. Its behavior is directly tested and ready for a later explicitly scoped runtime-registration step; no product deep-support claim is made until that occurs and the release manifest passes all cross-cutting gates.
2. The two new trial JSONL files are parsed and fixture-reference validated by the FK18 test, but the central evaluation CLI's hard-coded dataset list is outside this task. A later evaluation-gate task must add these files to the production evaluation run before promotion.
3. Each approved trial area has separated train and held-out evidence, but `implemented-gated` is not equivalent to a released deep-support result. The product matrix and version manifest deliberately preserve that distinction.

---

# FK18 Authorized Scope Expansion Follow-up (2026-07-22)

## Status

The user-approved FK18 scope expansion is implemented and verified locally on `codex/frontend-experience-kernel-design`. This follow-up resolves the first two residual concerns above: `react-ecosystem-core` now participates in the runtime worker pipeline, and the FK18 train/held-out files now participate in the actual frontend evaluation CLI and all three quality gates.

No production action, deployment, push, merge, pull request, credential operation, or active worktree switch was performed. `DEVKH_FRONTEND_KNOWLEDGE_MODE` was not changed. The seven V1 Trial capabilities remain `implemented-gated`; the six deferred V1.1 technologies remain `basic-recognition`.

## Review Findings Resolved

### Runtime registration and canonical merge

- Registered `react-ecosystem-core@1.0.0` in `runtime/analyzer-worker.ts` and dispatch it for typed JavaScript/TypeScript sources when requested.
- Added the analyzer to the frontend evaluation CLI's production analyzer list.
- Added a narrowly bounded canonical refinement rule in `analyzer-registry.ts`. It activates only after both `react-core` and `react-ecosystem-core` own the same stable entity ID, permits `unknown` attributes to refine to a consistent `known` value, retains the more complete valid entity, and rejects conflicting known values.
- Preserved the existing hard-fail behavior for unrelated core analyzer conflicts. Additional TypeScript/state-data contributors may merge only when their canonical values are equal or less informative than the already proven React refinement.
- Added order-reversal registry coverage and a real worker request that merges React component and ecosystem wrapper facts into one deterministic IR.

### Import provenance and analyzer completeness

- Replaced local-spelling checks with import binding records containing local name, exported name, module specifier, resolution, and import node.
- Zod `object` facts require a binding imported from `zod` as `z` or a namespace import.
- React Hook Form extraction requires `useForm` imported from `react-hook-form`; complete Zod validation links additionally require `zodResolver` imported from `@hookform/resolvers/*`.
- GraphQL complete operation/fragment facts require the tag binding to come from `graphql-tag`, `@apollo/client`, or `graphql-request` as `default` or `gql`.
- Complete component-library wrapper facts require `forwardRef` imported from React and a rendered imported primitive.
- Aliased legitimate imports are supported. Locally spoofed `z`, `useForm`, `gql`, and `forwardRef` bindings do not produce complete deep-support facts or fact edges.
- OpenAPI extraction now traces client instances created by an imported OpenAPI factory, allowing normal `createClient(...)` fixture usage rather than requiring a directly imported client object.
- CSF extraction now resolves an imported component through project import resolution, allowing stories to live in real `*.stories.tsx` files.

### Real fixtures

- Restored the original `react-vite/src/app.tsx` core layout so existing evaluation citations and baseline semantics remain stable.
- Moved FK18 train patterns into `src/dashboard-ecosystem.tsx`, `src/dashboard-card.stories.tsx`, `.storybook/main.ts`, and `src/card-primitive.tsx`.
- Added held-out Redux Toolkit, TanStack Query, GraphQL, OpenAPI, Zod/RHF, permission guard, component-wrapper, Storybook config, and CSF story patterns under `react-vite-held-out`.
- Added real generated OpenAPI client calls with static paths and real Storybook main/story file paths in both split fixtures.
- Added a CSS custom property used by the fixture so token definition and `uses_token` evidence are present without changing the established CSS-module source range.
- Pinned the required fixture dependencies while leaving repository production dependencies unchanged.

### Evaluation CLI and gates

- The CLI now loads `react-trial.jsonl` in both train and held-out splits alongside the original six datasets.
- `trialCapability` is parsed and validated against the seven approved candidates.
- Suite validation requires at least one train and one held-out case for every trial capability.
- Version-manifest validation requires every trial capability to remain `{ status: "implemented-gated", target: "V1 Trial" }` and every deferred capability to remain `{ status: "basic-recognition", target: "V1.1" }`.
- Added four unauthorized/unpublished trial cases so the expanded suite preserves the existing `>= 0.15` negative-case floor instead of weakening it.
- Replaced placeholder trial expectations with analyzer-derived stable entity IDs, fact-edge keys, impact IDs, and exact source citations from real deep-support fixture paths.
- Added a Vitest end-to-end test that invokes the actual CLI subprocess and asserts its generated artifact contains all 18 FK18 observations under train, held-out, and aggregate quality gates.
- Updated the approved dataset digest to `3060a5d6f8a428a4a55ab5a09e2dc2b01059d503a80d824788365deab2793ad6`.

### Evaluation compatibility refinements

- Added Han/Latin token boundaries during normalization so established Chinese queries match adjacent identifiers such as `DashboardPage` and `useDashboardStore` exactly.
- Added a small exact-name specificity bonus to prevent a shorter suffix name from tying a longer explicit query target.
- Added facet-scoped fact priorities for mutation invalidation, permission guarding, and component wrapping so FK18 evaluates its deep relation rather than a generic neighboring edge.
- Kept baseline edge semantics stable by suppressing unprioritized CSS token edges in generic CSS summaries and demoting only the newly added Storybook workspace edge behind preexisting workspace facts.

## TDD Record

### Cycle 1: worker registration and merge refinement

1. Added registry and worker end-to-end tests first.
2. RED: `npm test -- src/server/knowledge/frontend/analyzer-registry.test.ts src/server/knowledge/frontend/runtime/analyzer-worker.test.ts` failed 2 tests: deterministic React refinement was rejected and the worker manifest omitted `react-ecosystem-core`.
3. Implemented runtime dispatch/registration and the bounded refinement policy.
4. GREEN: 2 files passed, 17 tests passed.

### Cycle 2: import provenance and fixture paths

1. Added aliased-import, spoofed-binding, and real worker fixture assertions first.
2. RED: 3 tests failed. Aliased genuine imports were missed, local spoofed Zod/GraphQL bindings emitted complete entities, and the checked-in fixture emitted neither OpenAPI nor Storybook facts.
3. Implemented import provenance, OpenAPI instance tracing, imported Storybook component resolution, and real fixture files.
4. A real pipeline run then exposed repeated partial canonical contributors for `DashboardForm`; root-cause inspection showed `state-data-core` and `typescript-core` followed the two React analyzers. The refinement rule was broadened only to allow those equal/less-informative contributors after both React owners were present.
5. GREEN: registry, ecosystem analyzer, and worker suites passed 3 files and 29 tests.

### Cycle 3: actual evaluation CLI and gates

1. Added suite metadata assertions and a real CLI subprocess test first.
2. RED: the suite dropped below the locked negative-rate floor and the CLI artifact contained no FK18 observations.
3. Added CLI dataset/analyzer wiring, trial capability validation, four negative cases, real held-out deep patterns, and the new baseline digest.
4. Successive RED runs exposed unsupported placeholder query vocabulary, hidden deep edges, adjacent Han/Latin identifier boundaries, and Storybook/CSS/workspace ordering regressions. Each was reproduced from the generated artifact and fixed at the smallest responsible layer.
5. GREEN: `src/server/knowledge/frontend/evaluation.test.ts` passed 15 tests, including the actual CLI subprocess and artifact assertions.

## Final Verification

All commands ran after the final implementation change from `/Users/start/Desktop/知识库系统/dev-knowledge-hub/.worktrees/frontend-experience-kernel-design`.

| Command | Result |
|---|---|
| `npm test -- src/server/knowledge/frontend/analyzer-registry.test.ts src/server/knowledge/frontend/runtime/analyzer-worker.test.ts src/server/knowledge/frontend/react-ecosystem-analyzer.test.ts src/server/knowledge/frontend/state-data-analyzer.test.ts src/server/knowledge/frontend/tooling-test-analyzer.test.ts src/server/knowledge/frontend/style-analyzer.test.ts src/server/knowledge/frontend/search.test.ts src/server/knowledge/frontend/evaluation.test.ts src/server/knowledge/pipeline/b02-shadow-pipeline.test.ts` | PASS: 9 files, 67 tests |
| `npm test` | PASS: 154 files passed, 1 skipped; 979 tests passed, 34 skipped |
| `npm run typecheck` | PASS: client and node TypeScript projects |
| `npm run lint` | PASS: ESLint exit 0 |
| `npm run evaluate:frontend` | PASS: 336 cases; quality gate passed; Chinese rate 0.410714; negative rate 0.154762 |
| `git diff --check` | PASS: no whitespace errors |

The full test run emitted the repository's existing jsdom `getComputedStyle()` pseudo-element warnings. They remain non-failing and unrelated to FK18.

## Final Scope and Concerns

- The runtime and evaluation gaps identified by review are resolved locally with end-to-end coverage.
- No migration, deployment, production access, active mode change, push, merge, PR, or credential action occurred.
- Passing local evaluation does not promote product claims. All seven candidates remain `implemented-gated` until the separate release gates authorize activation.
- V1.1 Webpack/Rspack/Rollup, Nx/Turbo, i18n, accessibility, error monitoring, and Web Vitals remain parser-backed basic recognition only.
- No unresolved functional concern was found in the authorized local scope.

---

# FK18 Important Review Findings Follow-up (2026-07-22)

## Status and Boundaries

All five Important review findings are resolved locally on `codex/frontend-experience-kernel-design`. The implementation remains inside the user-approved FK18 scope expansion. No push, merge, deployment, production access, credential operation, active worktree switch, or `DEVKH_FRONTEND_KNOWLEDGE_MODE=active` change was performed.

The seven V1 Trial capabilities remain `implemented-gated`. Webpack/Rspack/Rollup, Nx/Turbo, i18n, accessibility, error monitoring, and Web Vitals remain `basic-recognition` with target `V1.1`.

## Findings Resolved

### Normal shadow pipeline registration

- Added `react-ecosystem-core` to the analyzer list issued by the normal frontend shadow extract stage.
- Changed the B02 shadow/active pipeline fixture to contain a real GraphQL tagged document.
- The B02 end-to-end test now proves that the normal stage request includes the analyzer and that the persisted `frontend-ir-v2` artifact contains both its analyzer manifest entry and its GraphQL operation fact.

### Capability-scoped evaluation gates

- Added capability-scoped train, held-out, and aggregate reports for each of the seven `trialCapability` values.
- The CLI validates every scoped report against its scoped cases, applies the existing quality thresholds independently to all 21 reports, and writes them as `trialCapabilityReports` in the committed-fixture evaluation artifact.
- Existing aggregate `train`, `heldOut`, and `all` gates remain unchanged and are still enforced.
- Added an end-to-end regression that runs the actual CLI, removes the held-out Storybook observation from the real artifact evidence, recomputes the same capability reports, and proves that `trialCapability.storybook.heldOut` fails while an unaffected capability remains green.

### Redux Toolkit and TanStack Query import provenance

- State-data extraction now records local name, exported name, package specifier, and resolution for imports.
- Complete Redux Toolkit slice and store facts require `createSlice` and `configureStore` exports from `@reduxjs/toolkit`, including aliased imports.
- Redux selector extraction requires an established Redux slice in the source. `selects` edges require `useSelector` from `react-redux`, and `dispatches` edges require a local dispatcher created by the imported `useDispatch` export.
- Complete TanStack query/mutation facts require `useQuery` or `useMutation` from `@tanstack/react-query`, including aliases.
- Invalidation edges require the receiver to be a local query client created by the imported `useQueryClient` export.
- Spoofed local factories, hooks, dispatchers, and invalidators produce no complete Redux/TanStack deep facts or deep relation edges.

### Deterministic canonical refinement and facet conflicts

- React canonical refinement is now restricted to `react-core`, `react-ecosystem-core`, `typescript-core`, and `state-data-core`; unrelated core contributors cannot enter the exception.
- Facet namespaces are checked for disagreement before canonical refinement. Conflicting values from the same analyzer across different source hashes now produce `FRONTEND_FACET_CONFLICT` instead of selecting a value through manifest/source-hash order.
- Added an order-reversal regression that supplies conflicting `state-data-core` facets from two source hashes after React refinement and verifies identical invalid results in both input orders.
- The stricter check exposed a real duplicate ecosystem facet: an imported component in a story and its source definition claimed different `react-ecosystem-core` values. Imported story components now contribute canonical provenance without a competing ecosystem facet; the defining source remains the owner of wrapper details.

### Permission and Storybook completeness

- Guard-shaped names begin as partial recognition. A guard becomes complete only after a literal JSX `permission` value is observed; a `guards` fact edge likewise requires that static key.
- Dynamic permission expressions and name-only `Guard`/`ProtectedRoute` functions remain partial.
- Story extraction now requires a named export. Unexported object literals are ignored as stories.
- Exported objects require a recognized CSF property (`args`, `render`, `play`, `decorators`, `parameters`, `loaders`, or `tags`) before becoming complete `storybook-csf` facts and emitting `documents` edges.
- Exported object candidates without a proven CSF shape remain partial with unknown fixture kind.

## TDD Record

1. Added all review regressions before implementation and ran the five-file focused suite.
2. RED: 5 files ran 48 tests; 11 failed exactly at the requested boundaries: 2 B02 pipeline cases, 2 evaluation cases, 3 state-data provenance cases, 2 registry cases, and 2 ecosystem false-positive cases.
3. Implemented the normal-stage analyzer request, per-capability report/gate path, state-data import binding checks, contributor/facet merge policy, and guard/story completeness rules.
4. The first GREEN attempt surfaced the previously hidden imported-story-component facet conflict. Removed the duplicate producer facet and preserved definition-owned deep details.
5. GREEN: the five-file suite passed all 48 tests.
6. Broadened focused verification passed 8 files and 67 tests, covering the runtime worker, registry, ecosystem/state/tooling/style analyzers, evaluation CLI, and B02 pipeline.

## Final Verification

All final commands ran from `/Users/start/Desktop/知识库系统/dev-knowledge-hub/.worktrees/frontend-experience-kernel-design` after the last code change.

| Command | Result |
|---|---|
| `npm test -- src/server/knowledge/frontend/runtime/analyzer-worker.test.ts src/server/knowledge/frontend/analyzer-registry.test.ts src/server/knowledge/frontend/react-ecosystem-analyzer.test.ts src/server/knowledge/frontend/state-data-analyzer.test.ts src/server/knowledge/frontend/tooling-test-analyzer.test.ts src/server/knowledge/frontend/style-analyzer.test.ts src/server/knowledge/frontend/evaluation.test.ts src/server/knowledge/pipeline/b02-shadow-pipeline.test.ts` | PASS: 8 files, 67 tests |
| `npm test` | PASS: 154 files passed, 1 skipped; 987 tests passed, 34 skipped |
| `npm run typecheck` | PASS: client and node TypeScript projects |
| `npm run lint` | PASS: ESLint exit 0 |
| `npm run evaluate:frontend` | PASS: 336 cases; aggregate plus 21 capability-scoped gates passed |
| `git diff --check` | PASS: no whitespace errors |

The first full test attempt had one unrelated 5-second timeout in `src/client/app.test.tsx` for `loads token records after the first one hundred`. The isolated retry passed in 2.37 seconds, and the subsequent full-suite rerun passed all 987 executed tests. The existing jsdom `getComputedStyle()` pseudo-element warnings remained non-failing.

## Residual Concerns

- Per-capability evidence is intentionally small, with one positive case per split for most trial capabilities. The gate now prevents aggregate masking, but future evidence growth would improve statistical confidence.
- Passing local gates does not promote or release these capabilities; `implemented-gated` remains the required status.
- No unresolved functional defect remains within the approved local FK18 expansion.
