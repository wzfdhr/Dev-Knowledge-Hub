# Contained Workspaces and Quality Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep desktop knowledge workspaces independently scrollable and make each quality-remediation state explain its next safe action.

**Architecture:** Add small semantic wrappers to the knowledge directory and quality governance controls, then apply a shared CSS containment pattern to the knowledge, feedback, graph, and quality workspaces. Derive guidance from the existing remediation state only; no API or persistence changes are required.

**Tech Stack:** React, TypeScript, Vitest with Testing Library, CSS.

## Global Constraints

- Do not change backend APIs, database schema, remediation state values, permissions, or release behavior.
- At widths of 760px or less, preserve the existing mobile natural-flow and source-bottom-sheet behavior.
- At desktop widths, each scrolling pane must use `min-height: 0` and must not cause page-level horizontal overflow.
- Keep all existing production actions unavailable to read-only members.

---

### Task 1: Cover the knowledge directory and quality guidance contracts

**Files:**
- Modify: `src/client/app.test.tsx`
- Modify: `src/client/pages/knowledge-page.tsx`
- Modify: `src/client/components/quality-governance-panel.tsx`

**Interfaces:**
- Produces: `.page-tree-list` as the scrollable knowledge-directory child.
- Produces: exported `remediationGuidance(state)` returning a title, explanation, and action label for each `RemediationState`.

- [ ] **Step 1: Write failing component tests**

```tsx
expect(screen.getByLabelText("知识页面").querySelector(".page-tree-list")).not.toBeNull();
expect(screen.getByText("下一步：请求范围重建")).toBeInTheDocument();
expect(screen.getByText("候选仍在生成，当前已发布版本不会变化。")).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused tests and verify they fail because the wrapper and guidance do not exist.**

Run: `npm test -- src/client/app.test.tsx`

- [ ] **Step 3: Add the minimal semantic wrapper and state-derived guidance.**

```tsx
<aside className="page-tree" aria-label="知识页面">
  <h2>页面</h2>
  <div className="page-tree-list">…page buttons…</div>
</aside>
```

```ts
export function remediationGuidance(state: RemediationState) {
  return { title: "下一步：请求范围重建", description: "…", actionLabel: "请求范围重建" };
}
```

- [ ] **Step 4: Re-run the focused tests and verify they pass.**

- [ ] **Step 5: Commit the tested component contract.**

### Task 2: Contain desktop master-detail workspaces

**Files:**
- Modify: `src/client/responsive.css`
- Test: `src/client/responsive.test.ts`

**Interfaces:**
- Consumes: `.page-tree-list` from Task 1.
- Produces: desktop-only contained height and pane scrolling for `.knowledge-layout`, `.feedback-layout`, `.graph-workspace`, and `.quality-governance-layout`.

- [ ] **Step 1: Write a failing stylesheet contract test.**

```ts
expect(styles).toContain("scrollbar-gutter: stable");
expect(styles).toContain("@media (min-width: 761px)");
```

- [ ] **Step 2: Run the focused stylesheet test and verify it fails because desktop containment is absent.**

Run: `npm test -- src/client/responsive.test.ts`

- [ ] **Step 3: Apply bounded-height, `min-height: 0`, and pane-scrolling rules, with mobile overrides.**

```css
@media (min-width: 761px) {
  .knowledge-layout, .feedback-layout { height: min(780px, calc(100dvh - 176px)); min-height: 0; }
  .page-tree-list, .feedback-list { min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
}
```

- [ ] **Step 4: Re-run the focused stylesheet test and verify it passes.**

- [ ] **Step 5: Commit the tested containment rules.**

### Task 3: Run integration checks and responsive verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-contained-workspaces-and-quality-guidance-design.md`

- [ ] **Step 1: Run client component tests, typecheck, lint, and production build.**

Run: `npm test -- src/client/app.test.tsx src/client/responsive.test.ts && npm run typecheck && npm run lint && npm run build`

- [ ] **Step 2: Inspect the deployed UI at 1440×1024, 768×900, and 390×844.**

Verify a long directory/list scrolls in its own column at desktop sizes, source panels remain usable, and mobile pages do not gain nested fixed-height panes.

- [x] **Step 3: Record actual automated verification results and the pending deployed visual check in the design specification.**

- [ ] **Step 4: Commit verification evidence and request review.**
