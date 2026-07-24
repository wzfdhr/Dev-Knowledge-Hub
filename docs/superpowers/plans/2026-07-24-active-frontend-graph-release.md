# Active 前端图谱正式发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已发布的 frontend-v2 active 包作为知识图谱的正式数据源，并用稳定的分层关系布局展示真实前端关系。

**Architecture:** 服务端从经过 `createVerifiedFrontendReleaseDraft` 验证的 frontend-v2 package 读取图谱，并在 API 中显式声明 artifact family。客户端将两个后端图谱模型投影为统一的展示模型；active 图谱采用事实边驱动的分层布局，候选边只影响展示。版本工作台增加人工创建 frontend-v2 草稿的操作，发布仍复用现有审核和发布机制。

**Tech Stack:** Fastify、Zod、PostgreSQL store、React、TanStack Query、Vitest、现有 frontend-v2 artifact contracts。

## Global Constraints

- 只有通过现有完整性与引用校验的 frontend-v2 package 才能创建草稿。
- 不自动发布、不读取 shadow 候选作为正式图谱数据。
- legacy release 与历史 URL 保持可读；其图谱页必须显示迁移状态。
- 前端图谱布局稳定、确定性，不引入第三方图布局依赖。
- 管理员可创建和发布，成员/只读用户仅能读取已发布图谱。

---

### Task 1: 发布 frontend-v2 草稿 API

**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/server/pipeline-routes.test.ts`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/api/types.ts`
- Test: `src/client/api/client.test.ts`

**Interfaces:**
- Consumes: `createVerifiedFrontendReleaseDraft({ store, artifactReader, workspaceId, repositoryId, buildId, version, packageStageRunId, packageArtifactId })`.
- Produces: `POST /api/releases/frontend-v2` with `{ buildId, version }`, returning `{ release }` with `releaseArtifactFamily: "frontend-v2"`.

- [ ] **Step 1: Write failing route and client tests**

Add a route test that supplies a ready build with a verified frontend package and expects HTTP 201 plus `releaseArtifactFamily: "frontend-v2"`; add a second test proving an incomplete package returns `409 FRONTEND_RELEASE_NOT_READY`. Add a client test expecting `POST /api/releases/frontend-v2` and a JSON `{ buildId, version }` body.

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `npm test -- src/server/pipeline-routes.test.ts src/client/api/client.test.ts`

Expected: failure because the client method and route do not exist.

- [ ] **Step 3: Implement the minimal verified draft route**

In `src/server/app.ts`, authenticate with `requireContributor`, resolve the repository with `requireRepositoryRole("member", ...)`, derive the succeeded/reused frontend package stage run and its `frontend-pipeline-package` manifest server-side, then call `createVerifiedFrontendReleaseDraft`. Return `FRONTEND_RELEASE_NOT_READY` for incomplete/invalid packages and reuse release-version conflict handling.

Expose `createFrontendReleaseDraft(buildId, version)` in `ApiClient` and add the returned release family fields to client types.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- src/server/pipeline-routes.test.ts src/client/api/client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add src/server/app.ts src/server/pipeline-routes.test.ts src/client/api/client.ts src/client/api/client.test.ts src/client/api/types.ts && git commit -m "feat(release): create verified frontend drafts"`

### Task 2: Read published frontend graph artifacts

**Files:**
- Create: `src/server/knowledge/frontend/release-graph.ts`
- Create: `src/server/knowledge/frontend/release-graph.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/mcp-access.test.ts`
- Modify: `src/client/api/types.ts`

**Interfaces:**
- Consumes: a published release with `releaseArtifactFamily`, `packageArtifactId`, build and project scope.
- Produces: `loadPublishedFrontendGraph(...)`, returning validated `frontendGraphV2Schema` data or a typed unavailable error.

- [ ] **Step 1: Write failing loader tests**

Create tests with an in-memory artifact manifest graph: the loader returns the frontend graph for a valid frontend-v2 release; it rejects a missing package, project mismatch, snapshot mismatch, or graph manifest that is not an output of the released package.

- [ ] **Step 2: Run the new loader test to verify it fails**

Run: `npm test -- src/server/knowledge/frontend/release-graph.test.ts`

Expected: failure because the loader module is absent.

- [ ] **Step 3: Implement scoped artifact loading**

Implement `loadPublishedFrontendGraph` using `frontendPipelinePackageSchema`, `frontendGraphV2Schema`, `findArtifactById`, build/repository lookup and stage-run provenance. Verify workspace, project, build, snapshot, package stage, package artifact family and graph artifact membership before reading JSON.

Extend `GET /api/projects/:projectId/graph?format=json` to return an explicit union: legacy data as `{ family: "knowledge-v1", graph }`; frontend data as `{ family: "frontend-v2", graph }`. Keep legacy exports unchanged; for frontend Mermaid and Markmap, project only fact edges into the existing export shape and omit candidate edges.

- [ ] **Step 4: Run route and loader tests**

Run: `npm test -- src/server/knowledge/frontend/release-graph.test.ts src/server/mcp-access.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add src/server/knowledge/frontend/release-graph.ts src/server/knowledge/frontend/release-graph.test.ts src/server/app.ts src/server/mcp-access.test.ts src/client/api/types.ts && git commit -m "feat(graph): read published frontend artifacts"`

### Task 3: Stable layered relationship layout

**Files:**
- Modify: `src/client/features/graph/graph-view-model.ts`
- Modify: `src/client/features/graph/graph-view-model.test.ts`

**Interfaces:**
- Consumes: a presentation graph `{ nodes: DisplayGraphNode[]; edges: DisplayGraphEdge[] }` with `candidate` and source references.
- Produces: `layoutGraph(graph)` with stable `x`, `y`, `width`, `height` positions that place fact-edge endpoints in successive layers.

- [ ] **Step 1: Write a failing multi-branch layout test**

Add a graph with one route leading to two pages/components and each component leading to independent data/test targets. Assert the route is in the first layer, both components share a later x layer but distinct y positions, and layout is identical when input nodes/edges are reversed.

- [ ] **Step 2: Run the layout test to verify it fails**

Run: `npm test -- src/client/features/graph/graph-view-model.test.ts`

Expected: failure because the existing module/child grid does not layer arbitrary fact relationships.

- [ ] **Step 3: Implement deterministic layer assignment**

Introduce display-graph types and replace module-only coordinates with a Kahn-style fact-edge rank pass. Sort roots and per-layer nodes by display category, name and ID; assign unvisited cycle nodes to deterministic trailing layers. Candidate edges are drawn but do not change ranks. Preserve viewport calculations and source-reference fields.

- [ ] **Step 4: Run the layout test to verify it passes**

Run: `npm test -- src/client/features/graph/graph-view-model.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add src/client/features/graph/graph-view-model.ts src/client/features/graph/graph-view-model.test.ts && git commit -m "feat(graph): layer frontend relationships"`

### Task 4: Active graph page and legacy migration state

**Files:**
- Modify: `src/client/pages/project-graph-page.tsx`
- Modify: `src/client/pages/project-graph-page.test.tsx`
- Modify: `src/client/components/knowledge-graph-explorer.tsx`
- Modify: `src/client/components/knowledge-graph-explorer.test.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: the API graph response union from Task 2 and `GraphLayout` from Task 3.
- Produces: active entity filters, relation labels, source drawer, legacy migration state and relation canvas.

- [ ] **Step 1: Write failing page tests**

Add an active frontend-v2 response with `route → page → component`, `component → api_operation` and `test_case → component` edges. Assert the page labels it as active, renders all relation labels and supplies the explorer with multiple branches. Add a legacy response test asserting the page shows “尚未发布 active 前端图谱” and does not call the old structure a module relationship map.

- [ ] **Step 2: Run page tests to verify they fail**

Run: `npm test -- src/client/pages/project-graph-page.test.tsx src/client/components/knowledge-graph-explorer.test.tsx`

Expected: failure because the client only understands legacy node kinds and always labels the panel “模块关系”.

- [ ] **Step 3: Implement response projection and page states**

Map frontend entities to category labels and frontend edges to display edges while retaining IDs, candidate state and citations. Build filter options from entities present in the active graph. Change the canvas heading to “前端关系图”; render a legacy migration panel with an explicit next step instead of the legacy canvas. Keep keyboard selection, source drawer and candidate/fact distinction.

- [ ] **Step 4: Run page tests to verify they pass**

Run: `npm test -- src/client/pages/project-graph-page.test.tsx src/client/components/knowledge-graph-explorer.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
`git add src/client/pages/project-graph-page.tsx src/client/pages/project-graph-page.test.tsx src/client/components/knowledge-graph-explorer.tsx src/client/components/knowledge-graph-explorer.test.tsx src/client/styles.css && git commit -m "feat(graph): present active frontend relations"`

### Task 5: Version workbench release action and production activation

**Files:**
- Modify: `src/client/pages/project-versions-page.tsx`
- Modify: `src/client/pages/project-versions-page.test.tsx`
- Modify: deployment environment configuration on the production host

**Interfaces:**
- Consumes: `ApiClient.createFrontendReleaseDraft(buildId, version)` and standard publish mutation.
- Produces: administrator-only “创建 active 图谱草稿” action with clear build validation errors.

- [ ] **Step 1: Write failing workbench tests**

Add tests that a ready frontend package shows the administrator active-draft action, calls `createFrontendReleaseDraft` with the reviewed build/version, and hides the action for readers. Add a failed candidate state assertion that explains that the current published graph remains unchanged.

- [ ] **Step 2: Run the workbench tests to verify they fail**

Run: `npm test -- src/client/pages/project-versions-page.test.tsx`

Expected: failure because the frontend draft action does not exist.

- [ ] **Step 3: Implement the manual active draft action**

Use the existing build-stage query to determine whether a verified frontend package is ready. Add the explicit draft action to the review panel for administrators, invalidate releases after creation and reuse the existing publish action. Do not alter automatic lifecycle actions.

- [ ] **Step 4: Run focused client tests**

Run: `npm test -- src/client/pages/project-versions-page.test.tsx`

Expected: PASS.

- [ ] **Step 5: Verify and activate production**

Run locally: `npm test -- --silent --reporter=dot && npm run typecheck && npm run build`.

On the production host, set `DEVKH_FRONTEND_KNOWLEDGE_MODE=active` and `DEVKH_SOURCE_STORAGE_MODE=active`, rebuild the app with the documented Compose invocation, recreate only the app container and confirm `/api/health`. Perform a real build, create an active graph draft and publish it only after the UI exposes a valid package.

- [ ] **Step 6: Commit**

Run:
`git add src/client/pages/project-versions-page.tsx src/client/pages/project-versions-page.test.tsx && git commit -m "feat(versions): publish active frontend graph"`
