import { describe, expect, test } from "vitest";

import { extractDocumentSource } from "./extract-documents";

const digest = "c".repeat(64);

describe("extractDocumentSource", () => {
  test("extracts CommonMark paragraphs as text without executing HTML", () => {
    const result = extractDocumentSource({
      snapshotId: "snapshot-1", path: "README.md", blobHash: digest,
      content: "# Guide\n\nUse `npm test`.\n\n<script>globalThis.__mustNotRun()</script>"
    });

    expect(result.ir.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Guide", text: "Use npm test." }),
      expect.objectContaining({ text: "globalThis.__mustNotRun()" })
    ]));
  });

  test("extracts JSON and failsafe YAML scalar paths while rejecting aliases and tags", () => {
    const json = extractDocumentSource({
      snapshotId: "snapshot-1", path: "config.json", blobHash: digest,
      content: "{\"service\": {\"port\": 3000}}"
    });
    const yaml = extractDocumentSource({
      snapshotId: "snapshot-1", path: "config.yaml", blobHash: digest,
      content: "defaults: &shared\n  port: 3000\nservice: *shared\nunsafe: !custom value"
    });

    expect(json.ir.documents).toEqual([expect.objectContaining({ text: "service.port = 3000" })]);
    expect(yaml.lintIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "YAML_ALIAS_OR_TAG_IGNORED", severity: "warning" })
    ]));
  });

  test("rejects YAML nesting deeper than 32 levels", () => {
    const content = Array.from({ length: 33 }, (_, index) => `${"  ".repeat(index)}level${index}:`).join("\n") + "\n" + `${"  ".repeat(33)}value: true`;
    const result = extractDocumentSource({ snapshotId: "snapshot-1", path: "deep.yaml", blobHash: digest, content });

    expect(result.lintIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "YAML_DEPTH_LIMIT", severity: "warning" })
    ]));
    expect(result.ir.documents).toEqual([]);
  });
});
