import { describe, expect, test } from "vitest";

import { createSessionToken, verifySessionToken } from "./session";

describe("signed sessions", () => {
  test("signs an eight-hour JWT containing admin and workspace identity", async () => {
    const now = new Date("2026-07-11T00:00:00.000Z");
    const token = await createSessionToken(
      { adminId: "admin-1", workspaceId: "workspace-1" },
      "a-development-session-secret-with-enough-entropy",
      now
    );

    const session = await verifySessionToken(
      token,
      "a-development-session-secret-with-enough-entropy",
      now
    );

    expect(session).toMatchObject({ adminId: "admin-1", workspaceId: "workspace-1" });
    expect(session.expiresAt.getTime() - now.getTime()).toBe(8 * 60 * 60 * 1000);
  });

  test("rejects tokens signed with another secret", async () => {
    const token = await createSessionToken(
      { adminId: "admin-1", workspaceId: "workspace-1" },
      "first-session-secret"
    );

    await expect(verifySessionToken(token, "second-session-secret")).rejects.toThrow();
  });
});
