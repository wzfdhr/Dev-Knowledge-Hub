import { describe, expect, test } from "vitest";

import {
  AGENT_FEEDBACK_STATUSES,
  APP_NAME,
  BUILD_JOB_STATUSES,
  SERVICE_NAME
} from "./contracts";

describe("shared application contracts", () => {
  test("exports application metadata for server and client consumers", () => {
    expect(APP_NAME).toBe("Dev Knowledge Hub");
    expect(SERVICE_NAME).toBe("dev-knowledge-hub");
  });

  test("exports database status contracts", () => {
    expect(BUILD_JOB_STATUSES).toContain("published");
    expect(AGENT_FEEDBACK_STATUSES).toContain("dismissed");
  });
});
