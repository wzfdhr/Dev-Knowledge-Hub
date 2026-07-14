import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("uses an admin table toolbar with flexible member actions", async () => {
  const stylesheet = await readFile(new URL("./workbench.css", import.meta.url), "utf8");

  expect(stylesheet).toContain(".admin-section {");
  expect(stylesheet).toContain(".section-toolbar {");
  expect(stylesheet).toContain(".member-table-actions {");
  expect(stylesheet).toContain("flex-wrap: wrap;");
  expect(stylesheet).not.toContain(".collaboration-grid {");
  expect(stylesheet).not.toContain(".roster-list > div {");
  expect(stylesheet).not.toContain(".member-actions {");
});

test("keeps activity rows readable by using wrapping flex instead of fixed grid tracks", async () => {
  const stylesheet = await readFile(new URL("./workbench.css", import.meta.url), "utf8");
  const activityStyles = stylesheet.slice(
    stylesheet.indexOf(".project-activity-item {"),
    stylesheet.indexOf(".activity-section > .ant-btn")
  );

  expect(activityStyles).toContain("display: flex;");
  expect(activityStyles).toContain("flex-wrap: wrap;");
  expect(activityStyles).not.toContain("grid-template-columns: 32px minmax(0, 1fr);");
  expect(activityStyles).not.toContain("text-overflow: ellipsis;");
});

test("stacks import stages as wrapping flex rows instead of a cramped grid", async () => {
  const stylesheet = await readFile(new URL("./responsive.css", import.meta.url), "utf8");
  const stageStyles = stylesheet.slice(
    stylesheet.indexOf(".import-stage-list {"),
    stylesheet.indexOf(".import-progress-meta")
  );

  expect(stageStyles).toContain("display: flex;");
  expect(stageStyles).toContain("flex-direction: column;");
  expect(stageStyles).toContain("flex-wrap: wrap;");
  expect(stageStyles).not.toContain("grid-template-columns");
  expect(stageStyles).not.toContain(".import-stage-list li");
});
