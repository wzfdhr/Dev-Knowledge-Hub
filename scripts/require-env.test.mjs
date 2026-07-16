import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execute = promisify(execFile);

describe("release environment guard", () => {
  test("fails when a required release variable is absent", async () => {
    await expect(execute(
      process.execPath,
      ["scripts/require-env.mjs", "TEST_DATABASE_URL"],
      { env: {} }
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("TEST_DATABASE_URL is required")
    });
  });

  test("passes when every requested variable has a non-empty value", async () => {
    const result = await execute(
      process.execPath,
      ["scripts/require-env.mjs", "TEST_DATABASE_URL"],
      { env: { TEST_DATABASE_URL: "postgres://test.example/devkh_test" } }
    );

    expect(result.stderr).toBe("");
  });
});
