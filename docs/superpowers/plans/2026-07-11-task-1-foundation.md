# Task 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the clean-room single-package foundation for Dev Knowledge Hub with a Fastify health API, React/Vite client shell, Drizzle/PostgreSQL schema and migration runner, validated environment loading, and the required tooling/docs.

**Architecture:** Keep the repository as one TypeScript package with clear internal boundaries: `src/server` for Fastify bootstrap and routes, `src/client` for the Vite React app shell, `src/db` for schema and migrations, and `src/shared` for cross-cutting constants and helpers. Use checked-in SQL migrations as the source of truth for database structure, with Drizzle schema exports providing typed contracts to the rest of the app.

**Tech Stack:** Node.js 22+, npm, TypeScript, Fastify 5, React 19, Vite, TanStack Query, Lucide React, PostgreSQL 16, `pg`, Drizzle ORM, Zod, Vitest, Playwright, ESLint.

## Global Constraints

- Independent clean-room implementation only; do not copy from `/Users/start/Documents/New project/knowledge-hub`.
- Do not add a remote or touch `/Users/start/Documents/New project/knowledge-hub`.
- Package must be private and licensed `UNLICENSED`.
- Use TDD for behavioral production code: write a failing test, verify failure, implement minimally, rerun.
- Tests must be able to import modules without production secrets.
- Do not revert files you did not create; assume concurrent changes may appear.

---

### Task 1: Scaffold package, toolchain, and repo metadata

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `eslint.config.js`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `docs/provenance.md`
- Create: `index.html`

**Interfaces:**
- Consumes: none
- Produces: npm scripts `dev`, `dev:web`, `build`, `start`, `test`, `test:watch`, `typecheck`, `lint`, `db:migrate`, `mcp:stdio`, `test:e2e`, `licenses:check`, `secrets:scan`

- [ ] **Step 1: Create package and toolchain files**

```json
{
  "name": "dev-knowledge-hub",
  "private": true,
  "license": "UNLICENSED"
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: install succeeds and lockfile is created

- [ ] **Step 3: Verify scripts resolve**

Run: `npm run lint -- --help`
Expected: command starts ESLint instead of “missing script”

- [ ] **Step 4: Commit scaffolding**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts vitest.config.ts playwright.config.ts eslint.config.js .gitignore .env.example Dockerfile docker-compose.yml .github/workflows/ci.yml README.md docs/provenance.md index.html
git commit -m "chore: scaffold toolchain metadata"
```

### Task 2: Add failing tests for health endpoint, schema contract, and env loading

**Files:**
- Create: `src/server/app.test.ts`
- Create: `src/db/schema.test.ts`
- Create: `src/server/env.test.ts`
- Create: `src/test/setup.ts`

**Interfaces:**
- Consumes: `buildServer(): FastifyInstance`, `src/db/schema` table exports and status constants, `loadEnv(options?: { mode?: string; env?: NodeJS.ProcessEnv }): AppEnv`
- Produces: red tests describing the required API, schema contract, and environment behavior

- [ ] **Step 1: Write the failing health endpoint test**

```ts
test("GET /api/health returns service health payload", async () => {
  const app = buildServer();
  const response = await app.inject({ method: "GET", url: "/api/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "ok", service: "dev-knowledge-hub" });
});
```

- [ ] **Step 2: Run health test to verify it fails**

Run: `npm test -- src/server/app.test.ts`
Expected: FAIL because `buildServer` does not exist yet

- [ ] **Step 3: Write the failing schema contract test**

```ts
expect(Object.keys(schema)).toEqual(expect.arrayContaining([
  "workspaces",
  "adminUsers",
  "repositories",
  "encryptedCredentials",
  "sourceSnapshots",
  "sourceFiles",
  "codeSymbols",
  "codeEdges",
  "buildJobs",
  "knowledgePages",
  "knowledgeChunks",
  "releases",
  "releaseChannels",
  "mcpTokens",
  "agentFeedback",
  "auditEvents",
  "BUILD_JOB_STATUSES",
  "AGENT_FEEDBACK_STATUSES"
]));
```

- [ ] **Step 4: Run schema test to verify it fails**

Run: `npm test -- src/db/schema.test.ts`
Expected: FAIL because schema module does not exist yet

- [ ] **Step 5: Write the failing environment test**

```ts
test("test mode can load defaults without production secrets", () => {
  expect(loadEnv({ mode: "test", env: {} })).toMatchObject({ nodeEnv: "test" });
});

test("production mode rejects missing required secrets", () => {
  expect(() => loadEnv({ mode: "production", env: {} })).toThrow(/DATABASE_URL/);
});
```

- [ ] **Step 6: Run env test to verify it fails**

Run: `npm test -- src/server/env.test.ts`
Expected: FAIL because `loadEnv` does not exist yet

### Task 3: Implement minimal server and environment behavior to satisfy tests

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/env.ts`
- Create: `src/server/main.ts`
- Create: `src/server/mcp-stdio.ts`

**Interfaces:**
- Consumes: Fastify and Zod
- Produces: `buildServer(): FastifyInstance`, `loadEnv(options?: { mode?: string; env?: NodeJS.ProcessEnv }): AppEnv`

- [ ] **Step 1: Write minimal Fastify app factory**

```ts
export function buildServer() {
  const app = Fastify();
  app.get("/api/health", async () => ({ status: "ok", service: "dev-knowledge-hub" }));
  return app;
}
```

- [ ] **Step 2: Write minimal environment loader**

```ts
export function loadEnv({ mode = process.env.NODE_ENV ?? "development", env = process.env } = {}) {
  if (mode === "test") {
    return { nodeEnv: "test", port: 3000, host: "127.0.0.1", dataDir: "./data" };
  }
  return schema.parse(env);
}
```

- [ ] **Step 3: Re-run focused tests**

Run: `npm test -- src/server/app.test.ts src/server/env.test.ts`
Expected: PASS

- [ ] **Step 4: Add server and MCP entrypoints**

```ts
const env = loadEnv();
const app = buildServer();
await app.listen({ port: env.port, host: env.host });
```

- [ ] **Step 5: Commit server foundation**

```bash
git add src/server
git commit -m "feat: add server foundation"
```

### Task 4: Implement schema exports, checked-in SQL migration, and migration runner

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/client.ts`
- Create: `src/db/migrations/0001_initial.sql`

**Interfaces:**
- Consumes: `pg`, Drizzle ORM
- Produces: required table exports, `BUILD_JOB_STATUSES`, `AGENT_FEEDBACK_STATUSES`, `runMigrations(connectionString: string): Promise<string[]>`

- [ ] **Step 1: Define the schema contract minimally to satisfy the failing schema test**

```ts
export const BUILD_JOB_STATUSES = ["queued", "syncing", "parsing", "synthesizing", "validating", "ready", "published", "failed"] as const;
export const AGENT_FEEDBACK_STATUSES = ["open", "acknowledged", "fixed", "dismissed"] as const;
```

- [ ] **Step 2: Export all required tables with UUID/text IDs, timestamps, foreign keys, and workspace isolation where relevant**

```ts
export const workspaces = pgTable("workspaces", { id: uuid("id").defaultRandom().primaryKey() });
```

- [ ] **Step 3: Add SQL migration and runner**

```ts
export async function runMigrations(connectionString: string): Promise<string[]> {
  // read sorted .sql files, apply unapplied files, record names in schema_migrations
}
```

- [ ] **Step 4: Re-run schema contract test**

Run: `npm test -- src/db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit database contract**

```bash
git add src/db
git commit -m "feat: add database contract"
```

### Task 5: Add client shell, CI, and final verification

**Files:**
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/query-client.ts`
- Create: `src/client/styles.css`

**Interfaces:**
- Consumes: React 19, TanStack Query, Lucide React
- Produces: buildable Vite client entrypoint

- [ ] **Step 1: Create a minimal React app shell**

```tsx
export function App() {
  return <main><h1>Dev Knowledge Hub</h1></main>;
}
```

- [ ] **Step 2: Verify the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Verify static checks and build**

Run: `npm run typecheck`
Expected: PASS

Run: `npm run lint`
Expected: PASS

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Write task report**

Run: create `/tmp/devkh-sdd/task-1-report.md` with files changed, red/green evidence, commands and outcomes, commit SHA, self-review, and concerns
Expected: report exists and reflects actual command results

- [ ] **Step 5: Create final task commit**

```bash
git add .
git commit -m "chore: scaffold clean-room application"
```
