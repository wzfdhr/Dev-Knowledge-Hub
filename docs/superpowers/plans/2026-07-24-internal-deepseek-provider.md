# Internal DeepSeek Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workspace administrators enable a fixed, internally managed DeepSeek provider without exposing, reusing, or returning its API key.

**Architecture:** Add a workspace-scoped active model-provider table and keep DeepSeek credentials in a distinct encrypted-credential record. The server owns the fixed DeepSeek model and endpoint. The settings page turns the active provider to DeepSeek and hides generic provider/model controls while it is active.

**Tech Stack:** TypeScript, Fastify, PostgreSQL migrations, in-memory/PostgreSQL stores, React, TanStack Query, Vitest, AI SDK.

## Global Constraints

- DeepSeek provider is named `deepseek`, uses `https://api.deepseek.com`, and always uses `deepseek-v4-flash`.
- Only a workspace administrator may manage model settings.
- Plaintext keys must never appear in API responses, audit metadata, test snapshots, or logs.
- Existing OpenAI-compatible and Anthropic credentials use `model-provider`; DeepSeek uses `model-provider-deepseek`.
- Do not modify migrations `0035` through `0038`.
- All new behavior follows failing-test → minimal implementation → focused regression test.

---

### Task 1: Persist the active provider separately from encrypted credentials

**Files:**
- Create: `drizzle/0039_model_provider_settings.sql`
- Modify: `src/db/migrate.test.ts`
- Modify: `src/server/persistence/store.ts`
- Modify: `src/server/persistence/memory-store.ts`
- Modify: `src/server/persistence/postgres-store.ts`
- Test: `src/server/model-settings.test.ts`

**Interfaces:**
- Produces: `ModelProvider = "openai" | "anthropic" | "deepseek"`.
- Produces: `AppStore.getModelConfig(workspaceId)` selecting the active provider’s encrypted credential.
- Produces: `AppStore.upsertModelConfig(workspaceId, { provider, model, encryptedApiKey? }, actorId)` with per-provider key retention.

- [ ] **Step 1: Write failing schema and store tests**

Add assertions that migration `0039_model_provider_settings.sql` creates `workspace_model_settings` with one row per workspace and backfills a legacy `model-provider` metadata record. Add a model-settings test which saves DeepSeek and verifies `store.encryptedCredentials` has `name: "model-provider-deepseek"`, while a pre-existing `model-provider` credential remains unchanged.

```ts
expect(store.encryptedCredentials).toEqual(expect.arrayContaining([
  expect.objectContaining({ name: "model-provider", ciphertext: legacyCiphertext }),
  expect.objectContaining({ name: "model-provider-deepseek" })
]));
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- src/db/migrate.test.ts src/server/model-settings.test.ts`

Expected: FAIL because migration `0039` and provider-specific selection do not exist.

- [ ] **Step 3: Add the migration and store implementation**

Create `workspace_model_settings` with a workspace primary key, `provider` constrained to the three supported values, a non-empty `model`, and timestamps. Backfill it from valid `model-provider` metadata. In both stores, read the active provider from this setting and select `model-provider-deepseek` only for DeepSeek; use `model-provider` for existing providers. Upsert the active setting and only update the active provider’s credential when a new encrypted key is supplied. Reject a first use with no credential.

```sql
CREATE TABLE workspace_model_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'deepseek')),
  model text NOT NULL CHECK (length(btrim(model)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npm test -- src/db/migrate.test.ts src/server/model-settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the persistence change**

```bash
git add drizzle/0039_model_provider_settings.sql src/db/migrate.test.ts src/server/persistence/store.ts src/server/persistence/memory-store.ts src/server/persistence/postgres-store.ts src/server/model-settings.test.ts
git commit -m "feat(settings): isolate deepseek provider credentials"
```

### Task 2: Enforce the DeepSeek endpoint and fixed model on the server

**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/server/bootstrap.ts`
- Modify: `src/server/knowledge/enhancer.ts`
- Test: `src/server/model-settings.test.ts`
- Test: `src/server/bootstrap.test.ts`

**Interfaces:**
- Consumes: the `deepseek` provider persisted by Task 1.
- Produces: `deepseekEnhancer({ apiKey })` using the fixed endpoint and model.
- Produces: `PUT /api/settings/model` accepting `deepseek` but ignoring a supplied DeepSeek model name.

- [ ] **Step 1: Write failing server tests**

Add a request test that submits `{ provider: "deepseek", model: "attacker-selected", apiKey }` and expects the sanitized response and audit metadata to name `deepseek-v4-flash`. Add a bootstrap dependency test proving the DeepSeek branch calls the OpenAI-compatible constructor with `baseUrl: "https://api.deepseek.com"` and `model: "deepseek-v4-flash"`.

```ts
expect(saved.json()).toEqual({
  config: { provider: "deepseek", model: "deepseek-v4-flash", hasApiKey: true }
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- src/server/model-settings.test.ts src/server/bootstrap.test.ts`

Expected: FAIL because `deepseek` is rejected or a supplied model is retained.

- [ ] **Step 3: Add the server normalization and enhancer branch**

Export fixed constants from `knowledge/enhancer.ts` and add a small `deepseekEnhancer(apiKey)` wrapper around `openAiCompatibleEnhancer`. In `app.ts`, allow `deepseek` and normalize its model before encryption/store access. In `bootstrap.ts`, select the wrapper when the active provider is DeepSeek. Leave API DTOs sanitized.

```ts
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODEL = "deepseek-v4-flash";

export function deepseekEnhancer(apiKey: string): KnowledgeEnhancer {
  return openAiCompatibleEnhancer({ apiKey, model: DEEPSEEK_MODEL, baseUrl: DEEPSEEK_BASE_URL });
}
```

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npm test -- src/server/model-settings.test.ts src/server/bootstrap.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the server enforcement change**

```bash
git add src/server/app.ts src/server/bootstrap.ts src/server/knowledge/enhancer.ts src/server/model-settings.test.ts src/server/bootstrap.test.ts
git commit -m "feat(settings): enforce internal deepseek configuration"
```

### Task 3: Add the administrator-facing internal DeepSeek mode

**Files:**
- Modify: `src/client/api/types.ts`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/pages/system-settings-page.tsx`
- Test: `src/client/app.test.tsx`

**Interfaces:**
- Consumes: the sanitized `ModelConfig` whose provider can be `deepseek`.
- Produces: a labelled checkbox or switch named `内部启用 DeepSeek`.
- Produces: a DeepSeek save request using `provider: "deepseek"`, `model: "deepseek-v4-flash"`, and the masked key value.

- [ ] **Step 1: Write failing page tests**

Render `SystemSettingsPage` with a minimal settings API and assert that turning on `内部启用 DeepSeek` hides the generic provider select and model input, shows the fixed `deepseek-v4-flash` text, and sends the fixed provider/model on save. Assert that the API-key field has `autocomplete="new-password"` and does not render a stored key value.

```tsx
await user.click(screen.getByRole("checkbox", { name: "内部启用 DeepSeek" }));
expect(screen.getByText("deepseek-v4-flash")).toBeVisible();
expect(screen.queryByLabelText("模型")).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused page test and confirm RED**

Run: `npm test -- src/client/app.test.tsx`

Expected: FAIL because the DeepSeek control and fixed-model behavior do not exist.

- [ ] **Step 3: Implement the smallest UI and type changes**

Extend `ModelProvider` with `deepseek`. Keep one controlled `provider` state in `ModelForm`; derive the checkbox from `provider === "deepseek"`. On enable set that provider and the fixed model; on disable restore `openai` and its normal editable controls. Preserve the existing successful-save clearing of the controlled API-key state.

```tsx
<label>
  <input
    type="checkbox"
    checked={provider === "deepseek"}
    onChange={(event) => setProvider(event.target.checked ? "deepseek" : "openai")}
  />
  内部启用 DeepSeek
</label>
```

- [ ] **Step 4: Run the focused page test and confirm GREEN**

Run: `npm test -- src/client/app.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the settings experience**

```bash
git add src/client/api/types.ts src/client/api/client.ts src/client/pages/system-settings-page.tsx src/client/app.test.tsx
git commit -m "feat(settings): add internal deepseek mode"
```

### Task 4: Run regression, build, and secret-safety verification

**Files:**
- Modify only if a verification failure requires a minimal correction.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: verified local branch with no plaintext test key in the output API contract.

- [ ] **Step 1: Run focused model and UI regression tests**

Run: `npm test -- src/db/migrate.test.ts src/server/model-settings.test.ts src/server/bootstrap.test.ts src/client/app.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run static and production build checks**

Run: `npm run lint && npm run typecheck && npm run build`

Expected: all commands exit 0; report any existing non-blocking bundle-size warning separately.

- [ ] **Step 3: Run the complete unit suite with stable worker concurrency**

Run: `npm test -- --maxWorkers=2`

Expected: no test failures; record skipped tests separately from failures.

- [ ] **Step 4: Scan changed content for accidental secrets and review the diff**

Run: `npm run secrets:scan && git diff a028229...HEAD --check && git diff a028229...HEAD`

Expected: secret scan and whitespace check exit 0; the diff contains no plaintext API key.

- [ ] **Step 5: Inspect the final worktree state**

Run: `git status --short --branch`

Expected: only the three task commits and the committed design/plan documentation are present; if a verification failure required a correction, add only its exact changed files and commit with `fix(settings): address deepseek verification feedback`.
