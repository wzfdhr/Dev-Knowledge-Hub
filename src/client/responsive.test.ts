import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

describe("desktop detail workspaces", () => {
  test("keeps long navigation and detail panes contained in their own scroll areas", async () => {
    const styles = await readFile(resolve(process.cwd(), "src/client/responsive.css"), "utf8");

    expect(styles).toContain(".knowledge-layout,\n  .feedback-layout,\n  .graph-workspace,\n  .quality-governance-layout");
    expect(styles).toContain(".page-tree-list,\n  .feedback-list,\n  .graph-detail,\n  .quality-issue-list,\n  .quality-issue-detail");
    expect(styles).toContain("scrollbar-gutter: stable");
    expect(styles).toContain("@media (min-width: 761px)");
  });
});
