import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeHtmlSource } from "./html-analyzer.js";

describe("analyzeHtmlSource", () => {
  test("extracts landmarks and form semantics with exact source evidence", () => {
    const content = `<!doctype html>
<html lang="zh-CN">
  <body>
    <header><nav aria-label="主导航"></nav></header>
    <main id="content">
      <form action="/api/search" method="post">
        <label for="query">关键词</label>
        <input id="query" name="q" required />
        <button type="submit">搜索</button>
      </form>
    </main>
  </body>
</html>`;
    const output = analyzeHtmlSource({
      snapshotId: "snapshot-html",
      path: "public/index.html",
      content,
      blobHash: createHash("sha256").update(content).digest("hex"),
      packageKey: "site"
    });

    expect(output.analyzerId).toBe("html-core");
    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "page", name: "index.html" }),
      expect.objectContaining({ kind: "dom_landmark", name: "main", facets: {
        "html-core": expect.objectContaining({ tagName: "main", role: "main" })
      } }),
      expect.objectContaining({ kind: "form", facets: {
        "html-core": expect.objectContaining({
          action: "/api/search",
          method: "post",
          controls: expect.arrayContaining([expect.objectContaining({ tagName: "input", name: "q", required: true })])
        })
      } })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contains", evidenceClass: "fact" })
    ]));
    expect(output.entities.every((entity) => entity.sourceRefs[0]?.startLine !== undefined)).toBe(true);
  });

  test("keeps malformed HTML deterministic and partial", () => {
    const content = "<main><form><input name=q>";
    const first = analyzeHtmlSource({
      snapshotId: "snapshot-html-2", path: "fragment.html", content,
      blobHash: createHash("sha256").update(content).digest("hex"), packageKey: "site"
    });
    const second = analyzeHtmlSource({
      snapshotId: "snapshot-html-2", path: "fragment.html", content,
      blobHash: createHash("sha256").update(content).digest("hex"), packageKey: "site"
    });

    expect(second).toEqual(first);
    expect(first.entities.some((entity) => entity.completeness === "partial")).toBe(true);
  });
});
