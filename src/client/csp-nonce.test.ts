import { describe, expect, test } from "vitest";

import { cspNonceFromDocument } from "./csp-nonce";

describe("cspNonceFromDocument", () => {
  test("returns the nonce embedded by the server's SPA document", () => {
    const document = {
      querySelector: () => ({ getAttribute: (name: string) => name === "content" ? "server-generated-nonce" : null })
    } as unknown as Document;

    expect(cspNonceFromDocument(document)).toBe("server-generated-nonce");
  });

  test("returns undefined outside a production SPA document", () => {
    const document = { querySelector: () => null } as unknown as Document;

    expect(cspNonceFromDocument(document)).toBeUndefined();
  });
});
