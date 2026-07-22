import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { stageTrustedBaseline } from "./release-verify.mjs";
import { verifyPostContractDatabase } from "./verify-post-contract-database.mjs";

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const sourceBlobContractPresent = readdirSync("drizzle").includes("0035_source_blobs_contract.sql");
const expectedMigrations = readdirSync("drizzle")
  .filter((name) => name.endsWith(".sql") && name <= "0035_source_blobs_contract.sql")
  .sort();
const cleanup = [];

function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8" });
    const health = spawnSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", container], {
      encoding: "utf8"
    }).stdout.trim();
    if (health === "healthy"
      && `${logs.stdout}${logs.stderr}`.includes("PostgreSQL init process complete; ready for start up.")) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(execFileSync("docker", ["logs", container], { encoding: "utf8" }));
}

async function initialize(sql) {
  const root = mkdtempSync(join(tmpdir(), "devkh-post-contract-container-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const staged = await stageTrustedBaseline(sql, root);
  const container = `devkh-post-contract-${randomUUID()}`;
  cleanup.push(() => spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  execFileSync("docker", [
    "run", "-d", "--name", container,
    "-e", "POSTGRES_PASSWORD=test-password",
    "-e", "POSTGRES_USER=devkh",
    "-e", "POSTGRES_DB=dev_knowledge_hub",
    "--health-cmd", "pg_isready -U devkh -d dev_knowledge_hub",
    "--health-interval", "1s",
    "--health-timeout", "1s",
    "--health-retries", "30",
    "-v", `${staged.baselinePath}:/docker-entrypoint-initdb.d/20-post-contract-baseline.sql:ro`,
    "postgres:16-bookworm"
  ], { stdio: "ignore" });
  waitForPostgres(container);
  return { container, staged };
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()();
});

describe.runIf(dockerAvailable && sourceBlobContractPresent)("post-contract trusted baseline container", () => {
  test("initializes under the actual Postgres UID and passes the database contract audit", async () => {
    const baseline = readFileSync("docker/post-contract-ci-baseline.sql", "utf8");
    const { container, staged } = await initialize(baseline);
    const postgresIdentity = execFileSync("docker", ["exec", container, "sh", "-c", "id -u postgres; id -g postgres"], {
      encoding: "utf8"
    }).trim().split("\n");
    const mountedIdentity = execFileSync("docker", ["exec", container, "stat", "-c", "%u:%g:%a", "/docker-entrypoint-initdb.d/20-post-contract-baseline.sql"], {
      encoding: "utf8"
    }).trim();

    expect(mountedIdentity).toBe(`${postgresIdentity[0]}:${postgresIdentity[1]}:400`);
    await expect(verifyPostContractDatabase({ containerId: container, expectedMigrations })).resolves.toBeUndefined();
    expect(staged.baselinePath).not.toContain("docker/post-contract-ci-baseline.sql");
  }, 60_000);

  test("rejects CTE-wrapped application data after real PostgreSQL initialization", async () => {
    const baseline = `${readFileSync("docker/post-contract-ci-baseline.sql", "utf8")}\n`
      + "WITH injected AS (INSERT INTO public.workspaces (id, name, slug) VALUES "
      + "('00000000-0000-0000-0000-000000000001', 'Injected', 'injected') RETURNING id) SELECT * FROM injected;\n";
    const { container } = await initialize(baseline);

    await expect(verifyPostContractDatabase({ containerId: container, expectedMigrations }))
      .rejects.toThrow(/application data.*workspaces/i);
  }, 60_000);

  test("rejects a dormant user function and trigger after real PostgreSQL initialization", async () => {
    const baseline = `${readFileSync("docker/post-contract-ci-baseline.sql", "utf8")}\n`
      + "CREATE FUNCTION public.injected_workspace_write() RETURNS trigger LANGUAGE plpgsql AS $$\n"
      + "BEGIN INSERT INTO public.workspaces (name, slug) VALUES ('Injected', 'injected'); RETURN NEW; END\n$$;\n"
      + "CREATE TRIGGER injected_workspace_write BEFORE INSERT ON public.source_files "
      + "FOR EACH ROW EXECUTE FUNCTION public.injected_workspace_write();\n";
    const { container } = await initialize(baseline);

    await expect(verifyPostContractDatabase({ containerId: container, expectedMigrations }))
      .rejects.toThrow(/user-defined function|trigger/i);
  }, 60_000);
});
