import { describe, expect, test } from "vitest";

import { hashPassword, verifyPassword } from "./password";

describe("admin passwords", () => {
  test("hashes and verifies passwords with Argon2", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(hash).toMatch(/^\$argon2/);
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong password")).resolves.toBe(false);
  });
});
