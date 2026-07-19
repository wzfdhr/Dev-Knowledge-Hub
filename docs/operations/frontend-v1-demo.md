# Frontend V1 Demo operations and acceptance

## Boundary

The React frontend knowledge kernel remains a shadow-only capability in this phase.

- `legacy` is the default and only formal read path.
- `shadow` writes candidate artifacts for administrator review.
- `active` remains rejected before F05.
- Candidate pages, search documents, Graph relations, impact results, and quality issues never enter the current release, workspace search, or MCP.
- The preview and candidate-search routes are workspace-administrator-only and read-only.

The current V1 compatibility contract covers TypeScript/JavaScript, JSX/TSX, HTML, CSS Modules, SCSS, Less, React 18/19, React Router, Zustand/Context, fetch/Axios, ECharts, Vite, unit/component tests, and Playwright-style E2E tests. Indented `.sass` remains deferred because no maintained parser has been approved.

## Evaluation gate

Run:

```bash
npm run evaluate:frontend
```

The command executes the committed analyzers and candidate search against all 318 train and held-out fixture cases. The suite includes 15 authorized, frontend-domain queries for absent components, routes, stores, APIs, charts, tests, styles, and tooling whose correct result is empty; these are scored separately from unauthorized and unpublished access cases. Missing observations, skipped datasets, malformed reports, or a failed threshold exit non-zero. The held-out gate is:

Observations are produced by the same candidate search implementation used by the administrator preview API. It ranks analyzer entities through the generated `index` documents and fact Graph, returns Graph semantic keys and physical source references, and applies project, release, and shadow-role visibility. Evaluation access cases instantiate those policy inputs; the policy decides whether results are visible. Expected entities, relations, citations, and impact labels are used only by the scoring step and are never inputs to retrieval or ranking.

| Metric | Threshold | FK13 result |
| --- | ---: | ---: |
| Entity micro/macro F1 | >= 0.95 | 1.00 / 1.00 |
| Fact edge precision | 1.00 | 1.00 |
| Fact edge recall | >= 0.75 | 1.00 |
| Recall@5 | >= 0.95 | 1.00 |
| MRR | >= 0.90 | 1.00 |
| Citation validity | 1.00 | 1.00 |
| Impact precision/recall | >= 0.95 | 1.00 / 1.00 |
| Empty-query false positives | 0 | 0 |
| Unauthorized/unpublished leakage | 0 | 0 |

The generated report is written to `artifacts/frontend-knowledge-evaluation.json`; it includes the actual observations and is evidence, not a runtime input. A failed quality gate writes the diagnostic report before exiting non-zero.

Physical candidate validation checks entity, fact, page, search, and quality references against snapshot bytes, blob hashes, and line bounds. It reads only referenced files with a fixed concurrency of four and uses a path-keyed descriptor map, so validation does not open 50,000 files at once or perform quadratic reference lookup.

## Product states

The administrator preview always explains what happened, whether data is safe, the next action, and retry behavior.

| State | Meaning | Formal data behavior |
| --- | --- | --- |
| No import | No repository source | No release is changed |
| No build | Snapshot exists without a build | Snapshot remains available |
| Build failed | Latest build failed | Current release remains active |
| Candidate failed | A shadow stage failed or was cancelled | Current release remains active; the failed stage and stable error code are shown |
| Candidate pending | Terminal package is incomplete | Candidate is not queryable |
| Candidate unpublished | Candidate package is valid | Legacy release/search/MCP remain active |
| Snapshot updated | Candidate snapshot is stale | Manual rebuild is required |
| Graph empty | No supported entities were found | Source and release remain intact |
| Permission lost | Session or workspace-admin role is unavailable | Read is denied; no write occurs |
| Network failure | Preview read failed | Retry is idempotent |
| Citation invalid | Source reference or validation failed | Candidate cannot be accepted |

## Browser acceptance

`npm run test:e2e` creates a real React/Vite + ECharts snapshot, executes all ten shadow stages, and verifies:

- page-to-route, page-to-API, state, visualization, tooling, and test knowledge;
- exact candidate source excerpts;
- candidate search through the real shadow index while non-administrators receive 403;
- legacy/candidate entity, fact, page, search, impact, quality, and citation comparison;
- change impact and suggested tests;
- current release identity before and after the shadow build;
- no horizontal overflow at 1440, 390, and 320 pixels.

Screenshots are emitted under `test-results/frontend-map-*.png` during the run.

## Failure and rollback

1. Keep `DEVKH_KNOWLEDGE_KERNEL_MODE=legacy` when the candidate package or evaluation gate fails.
2. Inspect the failed stage, immutable artifact manifests, invalid citation list, and analyzer manifest digest.
3. Fix the source or analyzer and start a new build attempt. Do not mutate a failed attempt or existing release.
4. Re-run unit, evaluation, E2E, and PostgreSQL integration checks.
5. Do not delete legacy releases or switch to `active`; production promotion remains an F05 user-authorized operation.
