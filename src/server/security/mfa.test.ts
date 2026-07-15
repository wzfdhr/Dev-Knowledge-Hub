import { describe, expect, test } from "vitest";

import {
  createRecoveryCodes,
  generateTotp,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp
} from "./mfa";

describe("TOTP and recovery code primitives", () => {
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  test("generates the RFC 6238 SHA-1 verification code", () => {
    expect(generateTotp(rfcSecret, new Date(59_000), 8)).toBe("94287082");
  });

  test("accepts only the configured one-step TOTP window", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const previous = generateTotp(rfcSecret, new Date(now.getTime() - 30_000));
    const stale = generateTotp(rfcSecret, new Date(now.getTime() - 60_000));

    expect(verifyTotp(previous, rfcSecret, now)).toBe(true);
    expect(verifyTotp(stale, rfcSecret, now)).toBe(false);
    expect(verifyTotp("12345", rfcSecret, now)).toBe(false);
  });

  test("generates one-time recovery codes that are only persisted as scrypt hashes", async () => {
    const [code] = createRecoveryCodes(1);
    const hash = await hashRecoveryCode(code);

    expect(hash).not.toContain(code);
    await expect(verifyRecoveryCode(code, hash)).resolves.toBe(true);
    await expect(verifyRecoveryCode("wrong-code", hash)).resolves.toBe(false);
  });

  test("rejects malformed recovery code records", async () => {
    await expect(verifyRecoveryCode("ABCDEF-GHIJKL", "scrypt$bad$bad")).resolves.toBe(false);
  });
});
