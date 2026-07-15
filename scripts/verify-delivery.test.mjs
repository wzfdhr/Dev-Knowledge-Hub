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
    expect(compose.services.integration.build.target).toBe("integration");
    expect(ci.jobs.verify.env.TEST_DATABASE_URL).toContain("/devkh_test");
  });

  test("boots both development surfaces, forces production start, and loads dotenv explicitly", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
    const readme = await readFile("README.md", "utf8");
    const architecture = await readFile("docs/architecture.md", "utf8");

    expect(packageJson.engines.node).toBe(">=22.13.0");
    expect(packageLock.packages[""].engines.node).toBe(">=22.13.0");
    expect(readme).toContain("Node.js 22.13.0 or newer");
    expect(architecture).toContain("Node.js 22.13.0 runtime");
    expect(packageJson.scripts.dev).toBe("node scripts/dev.mjs");
    expect(packageJson.scripts["dev:api"]).toContain("--env-file-if-exists=.env");
    expect(packageJson.scripts["dev:web"]).toContain("--env-file-if-exists=.env");
    expect(packageJson.scripts.start).toContain("NODE_ENV=production");
    expect(packageJson.scripts.start).toContain("--env-file-if-exists=.env");
  });

  test("builds the static askpass helper and runs a Compose image smoke job on both branches", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const deliveryCheck = await readFile("scripts/verify-delivery.mjs", "utf8");
    const ci = parse(await readFile(".github/workflows/ci.yml", "utf8"));
    const verifySteps = ci.jobs.verify.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    const smokeSteps = ci.jobs["container-smoke"].steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");

    expect(dockerfile).toContain("COPY --chown=node:node --chmod=755 scripts/git-askpass.sh");
    expect(dockerfile.match(/^FROM node:22\.13-bookworm-slim/gm)).toHaveLength(3);
    expect(deliveryCheck).toContain("node:22\\.13-bookworm-slim");
    expect(String(ci.jobs.verify.steps.find((step) => step.uses === "actions/setup-node@v4")
      ?.with?.["node-version"])).toBe("22.13.0");
    expect(ci.on.push.branches).toEqual(expect.arrayContaining(["main", "codex/mvp"]));
    expect(ci.jobs["container-smoke"].env.DEVKH_DOMAIN).toBe("hub.example.test");
    expect(ci.jobs["container-smoke"].env.ACME_EMAIL).toBe("ci@example.test");
    expect(verifySteps).toContain("npx playwright install --with-deps chromium");
    expect(verifySteps).toContain("npm run release:verify -- --scope verify");
    expect(smokeSteps).toContain("npm run release:verify -- --scope container");
  });

  test("requires a real PostgreSQL URL before running the integration release gate", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["test:integration"]).toContain(
      "node scripts/require-env.mjs TEST_DATABASE_URL"
    );
  });

  test("exposes one release verification entrypoint", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["release:verify"]).toBe("node scripts/release-verify.mjs");
    expect(packageJson.scripts["phase:merge"]).toBe("node scripts/merge-verified-pr.mjs");
  });

  test("does not retain a legacy resumable upload staging volume", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const compose = parse(await readFile("docker-compose.yml", "utf8"));

    expect(dockerfile).not.toContain("/var/lib/devkh/upload-staging");
    expect(compose.services.app.volumes).not.toContain("upload_staging:/var/lib/devkh/upload-staging");
  });

  test("keeps uploaded source data in its own durable volume", async () => {
    const compose = parse(await readFile("docker-compose.yml", "utf8"));

    expect(compose.services.app.volumes).toContain("uploaded_sources:/var/lib/devkh/uploads");
    expect(compose.volumes).toHaveProperty("uploaded_sources");
  });

  test("keeps content-addressed artifacts in their own durable volume", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const compose = parse(await readFile("docker-compose.yml", "utf8"));

    expect(dockerfile).toContain("/var/lib/devkh/artifacts");
    expect(compose.services.app.volumes).toContain("artifact_data:/var/lib/devkh/artifacts");
    expect(compose.volumes).toHaveProperty("artifact_data");
  });
});
