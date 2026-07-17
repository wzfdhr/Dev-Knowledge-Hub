# Knowledge Graph Explorer Implementation Plan

> **For Codex:** Execute this plan task by task. This is a separate UI branch; it
> must not be deployed while the Phase F shadow-observation window is running.

**Goal:** Replace the project graph page's raw JSON debug output with an
interactive, release-bound knowledge-graph explorer that people can navigate,
filter, inspect, and export.

**Architecture:** The existing graph endpoint remains the authority. The client
loads its `json` export into a deterministic view-model, renders a bounded SVG
canvas, and keeps a keyboard-accessible synchronized node list and detail
panel. Citation previews reuse the existing release-bound source API. Mermaid
and Markmap are fetched as plain text and copied or downloaded; they are never
executed in the browser.

**Tech stack:** React, TypeScript, TanStack Query, existing CSS, Vitest,
Testing Library, existing browser/E2E tooling. No new UI library or server
migration.

## Guardrails

- Keep the graph tied to the currently published release returned by the API.
- Treat fact edges as primary and candidate edges as opt-in dashed context.
- Show a visible explanation whenever the initial result is reduced to 160
  nodes; do not silently discard data.
- Preserve existing project authorization by only using established endpoints.
- Do not touch `docker-compose.override.yml`, production configuration, or the
  legacy/shadow kernel mode in this branch.
- Use the current product language, semantic HTML, flex/grid layouts, and the
  existing responsive breakpoints. Do not reintroduce repeated table labels or
  fixed-width layout hacks.

## Task 1: Create typed graph data and deterministic view-model

**Files:**
- Create: `src/client/features/graph/graph-view-model.ts`
- Create: `src/client/features/graph/graph-view-model.test.ts`
- Modify: `src/client/api/types.ts`
- Modify: `src/client/api/client.ts`

1. Add client-only types for the `json` graph export: node id/type/label/path,
   source references, edge id/type/source/target, and a graph payload. Keep
   unknown metadata as `Record<string, unknown>` rather than relying on server
   implementation objects.
2. Change `ApiClient.getProjectGraph` to accept a format argument with a
   default of `tree`, and return the matching typed result. The page will request
   `json`; existing callers remain compatible.
3. Implement pure functions:
   - `filterGraph` accepts the graph, query text, enabled node kinds, candidate
     edge visibility, and node limit. It first selects matching nodes and their
     fact-edge neighbours, then fills remaining capacity in deterministic label
     and id order. It removes edges whose endpoints are absent.
   - `layoutGraph` places modules in stable vertical lanes and their related
     nodes in local columns. It returns SVG coordinates, canvas bounds, and
     paths. It must produce the same output for the same input.
   - `describeGraphReduction` returns a short user-facing count explanation.
4. Write red tests first for: module-first stable ordering, case-insensitive
   query filtering, candidate-edge exclusion, edge cleanup after filtering,
   160-node reduction messaging, and deterministic layout output. Implement
   until the tests pass.
5. Run:
   ```bash
   npm test -- src/client/features/graph/graph-view-model.test.ts
   npm run typecheck
   ```
6. Commit and push:
   ```bash
   git add src/client/features/graph src/client/api/types.ts src/client/api/client.ts
   git commit -m "feat(graph): add typed graph view model"
   git push origin codex/graph-explorer
   ```

## Task 2: Build the accessible SVG graph explorer

**Files:**
- Create: `src/client/components/knowledge-graph-explorer.tsx`
- Create: `src/client/components/knowledge-graph-explorer.test.tsx`

1. Build a focused reusable component receiving positioned nodes, visible
   edges, selected ids, and selection callbacks. Render the graph as an SVG
   with labelled node buttons, solid fact edges, and dashed candidate edges.
2. Add pan by pointer drag and zoom via icon buttons plus wheel interaction.
   Provide reset-view control and keep the graph usable without pointer input.
3. Render a synchronized, focusable node list next to or below the SVG. Arrow
   key focus and Enter/Space selection must select the same node as SVG clicks.
   Use explicit aria labels for graph, controls, edges, and node kinds.
4. Test initial rendering, fact/candidate edge presentation, keyboard node
   selection, reset zoom, and selection callback behavior. Use `userEvent` and
   assertions on semantic elements rather than SVG implementation details.
5. Run:
   ```bash
   npm test -- src/client/components/knowledge-graph-explorer.test.tsx
   npm run lint
   npm run typecheck
   ```
6. Commit and push:
   ```bash
   git add src/client/components/knowledge-graph-explorer.tsx src/client/components/knowledge-graph-explorer.test.tsx
   git commit -m "feat(graph): add accessible SVG explorer"
   git push origin codex/graph-explorer
   ```

## Task 3: Replace the project graph page and add source inspection

**Files:**
- Modify: `src/client/pages/project-graph-page.tsx`
- Modify: `src/client/app.test.tsx` or create a focused page test beside it

1. Replace `JSON.stringify` output with the explorer. Request the `json`
   export through `useQuery`, then build its filtered and laid-out view model.
2. Add controls for text search, node-kind checkboxes, candidate-edge toggle,
   and visible reduced-result status. Show empty, loading, failure, and no
   published release states using the established page patterns.
3. Add a detail panel for the selected node or edge: name, kind, path,
   matching reason, source citations, relationships, and release version.
4. For a selected citation, call the existing `api.getSource` with path, line
   range, and `releaseId`. Render the existing source panel only after that
   release-bound request resolves; surface real request failures without
   implying data loss.
5. Add Mermaid and Markmap actions that request their existing formats from the
   API, expose a copy action and a text-file download, and never insert the
   returned text as HTML.
6. Write page tests with mocked API calls for graph load, filters, selected
   source citation (including its release id), empty graph, and a failed graph
   request. Add a test that export text is handled as text rather than rendered
   markup.
7. Run:
   ```bash
   npm test -- src/client/app.test.tsx
   npm run typecheck
   ```
8. Commit and push:
   ```bash
   git add src/client/pages/project-graph-page.tsx src/client/app.test.tsx
   git commit -m "feat(graph): replace JSON page with explorer"
   git push origin codex/graph-explorer
   ```

## Task 4: Apply responsive visual integration and browser checks

**Files:**
- Modify: `src/client/styles.css`
- Modify: `tests/e2e/console.spec.ts`

1. Add scoped graph explorer styles with existing color tokens. Use grid for
   desktop canvas/detail composition and a single-column flow below 760px.
   Keep graph canvas height bounded by `clamp`, permit horizontal/vertical
   navigation inside the canvas, and avoid fixed page widths.
2. Make selected/focus states, fact/candidate edge styles, filters, source
   details, and export actions visually distinct at normal contrast. Keep the
   node list compact and independently scrollable without hiding keyboard focus.
3. Add E2E coverage following the repository's existing test harness: graph
   loads from a mock/published release, a node is selectable, the detail panel
   appears, and 1440px and 390px screenshots contain the graph controls without
   clipped text or overlapping panels.
4. Run the focused E2E test and inspect its screenshots manually. Correct any
   clipping, overflow, or focus regression before proceeding.
5. Commit and push:
   ```bash
   git add src/client/styles.css tests/e2e/console.spec.ts
   git commit -m "style(graph): make explorer responsive"
   git push origin codex/graph-explorer
   ```

## Task 5: Development-manager review, test-manager verification, product acceptance

**Files:**
- Modify or create: `docs/reviews/graph-explorer-2026-07-17.md`

1. Development-manager review: inspect authorization boundaries, release
   binding, query performance, deterministic layout, XSS handling for exports,
   accessibility, and compatibility of the changed API-client signature. Record
   findings and fixes. Any P0-P3 returns to the relevant implementation task.
2. Test-manager verification: run targeted graph tests, full unit suite, lint,
   typecheck, build, relevant E2E, and the established PostgreSQL/container
   checks. Preserve command, result, and any artifact path in the review record.
3. Product-manager acceptance: use 1440px and 390px screenshots to verify the
   project navigation, module-first exploration, source traceability, empty and
   error states, exports, Chinese copy, and whether the page behaves as a
   usable knowledge graph rather than a developer data dump. Record pass/fail
   by flow.
4. Commit and push review evidence:
   ```bash
   git add docs/reviews/graph-explorer-2026-07-17.md
   git commit -m "docs: record graph explorer reviews"
   git push origin codex/graph-explorer
   ```

## Task 6: PR handoff and integration decision

1. Run the final local gate:
   ```bash
   npm test
   npm run lint
   npm run typecheck
   npm run build
   ```
   Run the repository's PostgreSQL integration and container-smoke commands as
   documented by its package scripts/CI configuration.
2. Open or update a draft PR from `codex/graph-explorer` with a concise summary,
   screenshots, explicit statement that production was not deployed, and the
   review record.
3. Present the completed development-manager, test-manager, and product-manager
   sections plus exact CI results to the user. Wait for explicit approval before
   merging. After merge, schedule deployment separately from the Phase F
   24-hour shadow observation; do not combine the two milestones.

## Acceptance Criteria

- The project graph page contains no raw JSON debug output.
- Graph data comes only from the authorized, published-release graph endpoint.
- Users can search, filter node kinds, opt into candidate edges, navigate by
  pointer or keyboard, inspect citations, and export Mermaid/Markmap as text.
- Initial display reduction is explicit, deterministic, and preserves related
  fact-edge context.
- Desktop and mobile flows remain legible without overlapping controls, clipped
  text, or hover-only interaction.
- All documented tests and reviews pass; no production deployment occurs from
  this branch before the user explicitly approves it.
