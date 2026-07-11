import { describe, expect, test } from "vitest";

import { requireIsolatedTestDatabase } from "./integration-database";

describe("integration database guard", () => {
  test("allows only the dedicated devkh_test database", () => {
    expect(requireIsolatedTestDatabase("postgres://devkh:password@localhost:5432/devkh_test"))
      .toBe("postgres://devkh:password@localhost:5432/devkh_test");
    expect(() => requireIsolatedTestDatabase(
      "postgres://devkh:password@localhost:5432/dev_knowledge_hub"
    )).toThrow(/devkh_test/);
    expect(() => requireIsolatedTestDatabase(
      "postgres://devkh:password@localhost:5432/postgres"
    )).toThrow(/devkh_test/);
  });
});
