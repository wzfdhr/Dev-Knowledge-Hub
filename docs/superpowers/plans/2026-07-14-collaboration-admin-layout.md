# Collaboration Admin Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the project collaboration screen as a compact admin-management page matching the layout conventions in `/Users/start/Desktop/af-ideal-admin`.

**Architecture:** Keep the existing project-member APIs and React Query mutations. Replace the two-column roster/activity composition with two full-width operational sections: a member management table with a flex toolbar, followed by an activity section. Use flex wrapping for row actions so controls never rely on a fixed action-column width.

**Tech Stack:** React 19, TypeScript, Ant Design 5, TanStack React Query, Vitest, CSS.

## Global Constraints

- Preserve existing project-level authorization and all member API contracts.
- Follow the `af-ideal-admin` pattern: page section, compact toolbar, data table, lightweight row actions.
- Use flex wrapping for operational controls; do not introduce fixed action-column widths.
- Keep the current worktree because the user explicitly chose direct edits rather than worktree isolation.

---

### Task 1: Member Management Table

**Files:**
- Modify: `src/client/pages/project-collaboration-page.tsx`
- Modify: `src/client/app.test.tsx`

**Interfaces:**
- Consumes: `ApiClient.listProjectActivity`, `ApiClient.listAvailableProjectMembers`, `addProjectMember`, `updateProjectMemberRole`, `removeProjectMember`.
- Produces: a table-based project member manager with add, role-change, and removal controls.

- [x] **Step 1: Write the failing UI test**

```tsx
expect(await screen.findByRole("table", { name: "项目成员" })).toBeVisible();
expect(screen.getByRole("button", { name: "添加成员" })).toBeVisible();
expect(screen.getByRole("columnheader", { name: "项目角色" })).toBeVisible();
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/client/app.test.tsx`

Expected: FAIL because the roster is rendered as generic `div` rows rather than a members table.

- [x] **Step 3: Implement the member table**

```tsx
<section className="admin-section member-section" aria-labelledby="members-heading">
  <header className="section-toolbar">
    <div><h2 id="members-heading">项目成员</h2><span>{members.length} 人</span></div>
    {canManage && <Button icon={<UserPlus />} onClick={() => setShowAdd(true)}>添加成员</Button>}
  </header>
  <Table rowKey="id" columns={memberColumns} dataSource={members} pagination={false} />
</section>
```

Keep role editing and removal inside the operations cell; use its own wrapping flex container.

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/client/app.test.tsx`

Expected: PASS.

### Task 2: Full-Width Activity Section and Responsive Styling

**Files:**
- Modify: `src/client/pages/project-collaboration-page.tsx`
- Modify: `src/client/workbench.css`
- Modify: `src/client/workbench.test.ts`

**Interfaces:**
- Consumes: project activity query pages and `ProjectActivityItem`.
- Produces: a full-width activity section following the member table without a fixed two-column grid.

- [x] **Step 1: Write the failing stylesheet test**

```ts
expect(stylesheet).toContain(".member-table-actions {");
expect(stylesheet).toContain("flex-wrap: wrap;");
expect(stylesheet).not.toContain(".collaboration-grid {");
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/client/workbench.test.ts`

Expected: FAIL because the page still uses `.collaboration-grid` and roster layout styles.

- [x] **Step 3: Implement the section layout**

```css
.admin-section { border: 1px solid var(--border); background: var(--surface); }
.section-toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
.member-table-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
@media (max-width: 540px) { .member-table-actions { justify-content: flex-start; } }
```

Remove obsolete roster and two-column collaboration selectors so styles cannot conflict.

- [x] **Step 4: Run tests and build**

Run: `npm test -- src/client/workbench.test.ts src/client/app.test.tsx && npm run typecheck && npm run lint && npm run build`

Expected: all commands pass; the production build emits a CSS asset.

### Task 3: Production Validation

**Files:**
- Modify: `src/client/pages/project-collaboration-page.tsx`
- Modify: `src/client/workbench.css`

**Interfaces:**
- Consumes: production Docker deployment at `/opt/dev-knowledge-hub`.
- Produces: a healthy production application with the admin-style collaboration page.

- [x] **Step 1: Deploy the changed client sources**

```bash
rsync -avz -e 'ssh -i /Users/start/Desktop/root.pem' src/client/pages/project-collaboration-page.tsx src/client/workbench.css root@118.31.105.66:/opt/dev-knowledge-hub/src/client/
ssh -i /Users/start/Desktop/root.pem root@118.31.105.66 'cd /opt/dev-knowledge-hub && docker compose -p dev-knowledge-hub up -d --build app'
```

- [x] **Step 2: Verify production health**

Run: `ssh -i /Users/start/Desktop/root.pem root@118.31.105.66 'curl -fsS http://127.0.0.1:3000/api/health'`

Expected: `{"status":"ok","service":"dev-knowledge-hub"}`.
