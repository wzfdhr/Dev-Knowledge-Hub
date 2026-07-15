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

  test("documents the public HTTPS base URL required by the Compose application", async () => {
    const environment = await readFile(".env.example", "utf8");
    const readme = await readFile("README.md", "utf8");
    const compose = await readFile("docker-compose.yml", "utf8");

    expect(environment).toContain("PUBLIC_BASE_URL=https://hub.example.com");
    expect(readme).toContain("PUBLIC_BASE_URL");
    expect(readme).toContain("https://<your-public-domain>");
    expect(compose).toContain("${PUBLIC_BASE_URL:-https://${DEVKH_DOMAIN:?set DEVKH_DOMAIN}}");
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
    const compose = parse(await readFile("docker-compose.yml", "utf8"));
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
    expect(ci.jobs["container-smoke"].env.PUBLIC_BASE_URL).toBe("https://hub.example.test");
    expect(compose.services.app.environment.PUBLIC_BASE_URL)
      .toBe("${PUBLIC_BASE_URL:-https://${DEVKH_DOMAIN:?set DEVKH_DOMAIN}}");
    expect(ci.jobs["container-smoke"].env.COMPOSE_PROJECT_NAME).toBe("devkh-ci");
    expect(ci.jobs["container-smoke"].env.DEVKH_CONTAINER_SMOKE).toBe("true");
    expect(ci.jobs["container-smoke"].env.RECOVERY_EVIDENCE_DIR).toBe("/tmp/devkh-recovery-evidence");
    expect(verifySteps).toContain("npx playwright install --with-deps chromium");
    expect(verifySteps).toContain("npm run release:verify -- --scope verify");
    expect(smokeSteps).toContain("apt-get install -y restic");
    expect(smokeSteps).toContain("npm run release:verify -- --scope container");
    expect(ci.jobs["container-smoke"].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ uses: "actions/upload-artifact@v4", if: "always()" })
    ]));
  });

  test("requires a real PostgreSQL URL before running the integration release gate", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts["test:integration"]).toContain(
      "node scripts/require-env.mjs TEST_DATABASE_URL"
    );
  });

  test("pins every active operational Compose command to the repository file", async () => {
    const readme = await readFile("README.md", "utf8");
    const monitor = await readFile("scripts/monitoring/devkh-monitor.sh", "utf8");
    const backup = await readFile("scripts/backup/devkh-backup.sh", "utf8");
    const restoreDrill = await readFile("scripts/backup/devkh-restore-drill.sh", "utf8");
    const publicAccess = await readFile("docs/operations/private-tailnet-access.md", "utf8");
    const releaseGates = await readFile("docs/operations/private-repository-release-gates.md", "utf8");

    expect(readme).toContain('cd /absolute/path/to/dev-knowledge-hub\nDEVKH_COMPOSE_FILE="$PWD/docker-compose.yml"');
    expect(readme).not.toMatch(/docker compose(?! -f "\$DEVKH_COMPOSE_FILE")/);
    expect(monitor).toContain('docker compose -f "$COMPOSE_DIR/docker-compose.yml"');
    for (const operationalScript of [monitor, backup, restoreDrill]) {
      expect(operationalScript).not.toContain("docker compose -f docker-compose.yml");
      expect(operationalScript).toContain('docker-compose.yml"');
    }
    expect(publicAccess).not.toMatch(/docker compose(?! -f \/opt\/dev-knowledge-hub\/docker-compose\.yml)/);
    expect(releaseGates).not.toMatch(/docker compose(?! -f "\$GITHUB_WORKSPACE\/docker-compose\.yml")/);
  });

  test("exposes one release verification entrypoint", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const deliveryMatrix = await readFile("docs/operations/knowledge-kernel-delivery-matrix.md", "utf8");

    expect(packageJson.scripts["release:verify"]).toBe("node scripts/release-verify.mjs");
    expect(packageJson.scripts["phase:merge"]).toBe("node scripts/merge-verified-pr.mjs");
    expect(deliveryMatrix).toContain("phase-merge.yml");
    expect(deliveryMatrix).not.toMatch(/\| Verified head \|/);
  });

  test("merges only from a trusted workflow after fresh checks of the approved base and head", async () => {
    const workflow = parse(await readFile(".github/workflows/phase-merge.yml", "utf8"));
    const mergeJob = workflow.jobs.merge;

    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on.workflow_dispatch.inputs).toHaveProperty("approved_base");
    expect(workflow.permissions.contents).toBe("read");
    expect(workflow.jobs.verify.permissions.contents).toBe("read");
    expect(workflow.jobs["container-smoke"].permissions.contents).toBe("read");
    expect(mergeJob.permissions.contents).toBe("write");
    expect(mergeJob.permissions["pull-requests"]).toBe("read");
    expect(mergeJob.needs).toEqual(["verify", "container-smoke"]);
    expect(mergeJob.if).toContain("success()");
    expect(mergeJob.if).toContain("inputs.user_approved");
    expect(mergeJob.if).toContain("github.actor == github.repository_owner");
    expect(workflow.jobs.verify.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uses: "actions/checkout@v4",
        with: expect.objectContaining({ ref: "${{ inputs.approved_head }}" })
      })
    ]));
    expect(workflow.jobs["container-smoke"].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uses: "actions/checkout@v4",
        with: expect.objectContaining({ ref: "${{ inputs.approved_head }}" })
      })
    ]));
    const verifyCommands = workflow.jobs.verify.steps.map((step) => step.run).filter(Boolean).join("\n");
    const containerCommands = workflow.jobs["container-smoke"].steps
      .map((step) => step.run).filter(Boolean).join("\n");
    expect(verifyCommands).toContain("git merge-base --is-ancestor");
    expect(containerCommands).toContain("git merge-base --is-ancestor");
    const mergeCommands = mergeJob.steps.map((step) => step.run).filter(Boolean).join("\n");
    expect(mergeJob.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uses: "actions/checkout@v4",
        with: expect.objectContaining({ ref: "${{ inputs.approved_base }}", "fetch-depth": 0 })
      })
    ]));
    expect(mergeCommands).toContain("git merge --no-ff");
    expect(mergeCommands).toContain("--force-with-lease=refs/heads/main:$APPROVED_BASE");
    expect(mergeCommands).toContain("$APPROVED_HEAD");
    expect(mergeCommands).toContain("$APPROVED_BASE");
    expect(mergeCommands).not.toContain("--match-head-commit");
  });

  test("seeds representative durable state before the CI recovery rehearsal", async () => {
    const recovery = await readFile("scripts/backup/ci-recovery-drill.sh", "utf8");
    const seed = await readFile("scripts/backup/seed-ci-recovery-fixture.sh", "utf8");

    expect(recovery.indexOf("seed-ci-recovery-fixture.sh"))
      .toBeLessThan(recovery.indexOf("devkh-backup.sh"));
    expect(seed).toContain("INSERT INTO project_members");
    expect(seed).toContain("INSERT INTO knowledge_artifacts");
    expect(seed).toContain("INSERT INTO releases");
    expect(seed).toContain("INSERT INTO release_channels");
    expect(seed.match(/write_volume_file /g)).toHaveLength(4);
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
