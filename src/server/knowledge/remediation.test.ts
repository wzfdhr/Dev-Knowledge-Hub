import { describe, expect, test } from "vitest";

import { transitionRemediation } from "./remediation";

describe("transitionRemediation", () => {
  test("allows only the reviewed remediation lifecycle", () => {
    expect(transitionRemediation("open", "accepted")).toBe("accepted");
    expect(transitionRemediation("accepted", "rebuilding")).toBe("rebuilding");
    expect(transitionRemediation("rebuilding", "resolved")).toBe("resolved");
    expect(transitionRemediation("open", "dismissed")).toBe("dismissed");
    expect(() => transitionRemediation("open", "resolved")).toThrow("Invalid remediation transition");
    expect(() => transitionRemediation("dismissed", "accepted")).toThrow("Invalid remediation transition");
  });
});
