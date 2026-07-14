import { describe, expect, test } from "vitest";

import { extractCsvTable } from "./tables";

const digest = "d".repeat(64);

describe("CSV table extraction", () => {
  test("infers a bounded schema and redacts sensitive samples without executing formula-like text", () => {
    const result = extractCsvTable({
      snapshotId: "snapshot-1", path: "data/users.csv", blobHash: digest,
      content: "email,age,formula\na@example.com,42,=SUM(A1:A2)\n"
    });

    expect(result.table.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "email", type: "string", sensitive: true }),
      expect.objectContaining({ name: "age", type: "number" }),
      expect.objectContaining({ name: "formula", formulaLike: true })
    ]));
    expect(result.sample).toEqual([["[redacted-email]", "42", "=SUM(A1:A2)"]]);
  });

  test("rejects CSV sources that exceed column or row limits", () => {
    const columns = Array.from({ length: 257 }, (_, index) => `c${index}`).join(",");
    expect(() => extractCsvTable({ snapshotId: "snapshot-1", path: "data/wide.csv", blobHash: digest, content: columns })).toThrow("256 columns");
  });
});
