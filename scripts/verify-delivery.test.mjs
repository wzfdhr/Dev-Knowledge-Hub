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
});
