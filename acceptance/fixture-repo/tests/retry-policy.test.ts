import { expect, test } from "vitest";

import { shouldRetry } from "../src/retry-policy.js";

test("stops retrying at the shared limit", () => {
  expect(shouldRetry(2)).toBe(true);
  expect(shouldRetry(3)).toBe(false);
});
