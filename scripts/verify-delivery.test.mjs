import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

describe("delivery database isolation", () => {
  test("keeps Compose and CI tests out of the persistent application database", async () => {
    const compose = parse(await readFile("docker-compose.yml", "utf8"));
    const ci = parse(await readFile(".github/workflows/ci.yml", "utf8"));
    const appUrl = compose.services.app.environment.DATABASE_URL;
    const testUrl = compose.services.integration.environment.TEST_DATABASE_URL;

    expect(appUrl).toContain("/dev_knowledge_hub");
    expect(testUrl).toContain("/devkh_test");
    expect(testUrl).not.toBe(appUrl);
    expect(compose.services.postgres.volumes).toContain(
      "./docker/postgres/init-test-db.sql:/docker-entrypoint-initdb.d/10-create-test-db.sql:ro"
    );
    expect(ci.jobs.verify.env.TEST_DATABASE_URL).toContain("/devkh_test");
  });

  test("boots both development surfaces, forces production start, and loads dotenv explicitly", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts.dev).toBe("node scripts/dev.mjs");
    expect(packageJson.scripts["dev:api"]).toContain("--env-file-if-exists=.env");
    expect(packageJson.scripts["dev:web"]).toContain("--env-file-if-exists=.env");
    expect(packageJson.scripts.start).toContain("NODE_ENV=production");
    expect(packageJson.scripts.start).toContain("--env-file-if-exists=.env");
  });

  test("builds the static askpass helper and runs a Compose image smoke job on both branches", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const ci = parse(await readFile(".github/workflows/ci.yml", "utf8"));
    const smokeSteps = ci.jobs["container-smoke"].steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");

    expect(dockerfile).toContain("COPY --chown=node:node --chmod=755 scripts/git-askpass.sh");
    expect(ci.on.push.branches).toEqual(expect.arrayContaining(["main", "codex/mvp"]));
    expect(smokeSteps).toContain("docker build --target runtime");
    expect(smokeSteps).toContain("docker compose config --quiet");
    expect(smokeSteps).toContain("docker compose up -d");
  });
});
