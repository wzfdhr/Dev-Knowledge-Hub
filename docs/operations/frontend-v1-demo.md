# Frontend V1 Demo operations and acceptance

## Boundary

The React frontend knowledge kernel remains a shadow-only capability in this phase.

- `legacy` is the default and only formal read path.
- `shadow` writes candidate artifacts for administrator review.
- `active` remains rejected before F05.
- Candidate pages, search documents, Graph relations, impact results, and quality issues never enter the current release, workspace search, or MCP.
- The preview route is workspace-administrator-only and read-only.

The current V1 compatibility contract covers TypeScript/JavaScript, JSX/TSX, HTML, CSS Modules, SCSS, Less, React 18/19, React Router, Zustand/Context, fetch/Axios, ECharts, Vite, unit/component tests, and Playwright-style E2E tests. Indented `.sass` remains deferred because no maintained parser has been approved.

## Evaluation gate

Run:

```bash
npm run evaluate:frontend
```

The command executes the committed analyzers against all 300 train and held-out fixture cases. Missing observations, skipped datasets, malformed reports, or a failed threshold exit non-zero. The held-out gate is:

| Metric | Threshold | FK13 result |
| --- | ---: | ---: |
| Entity micro/macro F1 | >= 0.95 | 1.00 / 1.00 |
| Fact edge precision | 1.00 | 1.00 |
| Fact edge recall | >= 0.75 | 0.80 |
| Recall@5 | >= 0.95 | 1.00 |
| MRR | >= 0.90 | 1.00 |
| Citation validity | 1.00 | 1.00 |
| Impact precision/recall | >= 0.95 | 1.00 / 1.00 |
| Empty-query false positives | 0 | 0 |
| Unauthorized/unpublished leakage | 0 | 0 |

The generated report is written to `artifacts/frontend-knowledge-evaluation.json`; it is evidence, not a runtime input.

## Product states

The administrator preview always explains what happened, whether data is safe, the next action, and retry behavior.

| State | Meaning | Formal data behavior |
| --- | --- | --- |
| No import | No repository source | No release is changed |
| No build | Snapshot exists without a build | Snapshot remains available |
| Build failed | Latest build failed | Current release remains active |
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
