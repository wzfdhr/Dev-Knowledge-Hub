import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { decryptSecret, encryptSecret } from "./crypto";

describe("encrypted secrets", () => {
  const masterKey = randomBytes(32).toString("base64");

  test("round trips plaintext with AES-256-GCM", () => {
    const payload = encryptSecret("github_pat_secret", masterKey);

    expect(decryptSecret(payload, masterKey)).toBe("github_pat_secret");
    expect(payload).not.toContain("github_pat_secret");
  });

  test("uses a fresh random IV for every encryption", () => {
    expect(encryptSecret("same", masterKey)).not.toBe(encryptSecret("same", masterKey));
  });

  test("rejects tampered ciphertext", () => {
    const payload = encryptSecret("secret", masterKey);
    const tampered = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;

    expect(() => decryptSecret(tampered, masterKey)).toThrow();
  });

  test("rejects decryption with a different key", () => {
    const payload = encryptSecret("secret", masterKey);

    expect(() => decryptSecret(payload, randomBytes(32).toString("base64"))).toThrow();
  });

  test("requires a base64-encoded 32-byte master key", () => {
    expect(() => encryptSecret("secret", Buffer.from("short").toString("base64"))).toThrow(
      /32 bytes/
    );
  });
});
