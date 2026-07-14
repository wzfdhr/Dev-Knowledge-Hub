import { describe, expect, test } from "vitest";

import { extractVueSfc } from "./extract-vue";

const digest = "b".repeat(64);

describe("extractVueSfc", () => {
  test("extracts script setup declarations and static template tags without executing expressions", () => {
    const result = extractVueSfc({
      snapshotId: "snapshot-1",
      path: "src/Counter.vue",
      content: [
        "<script setup lang=\"ts\">",
        "const count = 0;",
        "const props = defineProps<{ title: string }>();",
        "</script>",
        "<template><section><Widget>{{ globalThis.__mustNotRun() }}</Widget></section></template>"
      ].join("\n"),
      blobHash: digest
    });

    expect(result.ir.files).toEqual([expect.objectContaining({ path: "src/Counter.vue", language: "vue" })]);
    expect(result.ir.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "count", sourceRef: expect.objectContaining({ startLine: 2 }) }),
      expect.objectContaining({ name: "props", sourceRef: expect.objectContaining({ startLine: 3 }) }),
      expect.objectContaining({ name: "Counter", kind: "component" })
    ]));
    expect(result.ir.documents).toEqual([expect.objectContaining({ text: expect.stringContaining("section, Widget") })]);
  });

  test("reports remote sources and custom blocks as lint instead of fetching or transforming them", () => {
    const result = extractVueSfc({
      snapshotId: "snapshot-1",
      path: "src/Remote.vue",
      content: "<script src=\"https://example.test/remote.ts\"/>\n<i18n>{\"title\": \"ignored\"}</i18n>",
      blobHash: digest
    });

    expect(result.lintIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "VUE_REMOTE_SRC_IGNORED", severity: "warning" }),
      expect.objectContaining({ rule: "VUE_CUSTOM_BLOCK_IGNORED", severity: "warning" })
    ]));
  });
});
