import { describe, expect, test } from "vitest";

import { projectLegacyRedirects } from "./project-routes";

describe("project route compatibility", () => {
  test("maps every legacy project URL to its new task area", () => {
    expect(projectLegacyRedirects).toEqual({
      imports: "../sources",
      versions: "../production",
      knowledge: "../knowledge/pages",
      graph: "../knowledge/graph",
      "frontend-map": "../knowledge/frontend",
      collaboration: "../settings/team",
      codex: "../settings/codex"
    });
  });
});
