import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeStyleSource } from "./style-analyzer.js";

function input(path: string, content: string) {
  return {
    snapshotId: "snapshot-style",
    path,
    content,
    blobHash: createHash("sha256").update(content).digest("hex"),
    packageKey: "@demo/ui"
  };
}

describe("analyzeStyleSource", () => {
  test("extracts CSS Modules, custom-property tokens, selectors, media/container queries, and utilities", () => {
    const content = `:root { --brand: #1677ff; }
.card:hover { color: var(--brand); }
@media (min-width: 48rem) { .card { display: grid; } }
@container panel (width > 30rem) { .title { font-size: 2rem; } }
.toolbar { @apply flex gap-2; }`;
    const output = analyzeStyleSource(input("src/card.module.css", content));

    expect(output.analyzerId).toBe("style-core");
    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "style_token", name: "--brand", attributes: {
        tokenValue: { state: "known", value: "#1677ff" }
      } }),
      expect.objectContaining({ kind: "style_scope", facets: {
        "style-core": expect.objectContaining({ module: true, classes: expect.arrayContaining(["card"]) })
      } }),
      expect.objectContaining({ kind: "style_scope", facets: {
        "style-core": expect.objectContaining({ atRule: "media", condition: "(min-width: 48rem)" })
      } }),
      expect.objectContaining({ kind: "style_scope", facets: {
        "style-core": expect.objectContaining({ atRule: "container", condition: "panel (width > 30rem)" })
      } })
    ]));
    expect(output.entities.some((entity) => JSON.stringify(entity.facets).includes("gap-2"))).toBe(true);
  });

  test.each([
    ["src/theme.scss", "$space: 8px; .card { margin: $space; }", "$space", "8px"],
    ["src/theme.less", "@brand: #f00; .card { color: @brand; }", "@brand", "#f00"]
  ])("parses %s variables as design tokens", (path, content, name, value) => {
    const output = analyzeStyleSource(input(path, content));
    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "style_token", name, attributes: {
        tokenValue: { state: "known", value }
      } })
    ]));
  });

  test("returns a bounded partial fact for invalid stylesheet syntax", () => {
    const output = analyzeStyleSource(input("src/broken.css", ".card { color: red;"));
    expect(output.entities).toEqual([
      expect.objectContaining({ kind: "style_scope", completeness: "partial" })
    ]);
  });

  test("marks indented Sass as explicitly unsupported without pretending SCSS parsing is valid", () => {
    const output = analyzeStyleSource(input("src/theme.sass", "$space: 8px\n.card\n  margin: $space\n"));

    expect(output.entities).toEqual([
      expect.objectContaining({
        kind: "style_scope",
        completeness: "partial",
        facets: { "style-core": expect.objectContaining({ unsupportedSyntax: "indented-sass" }) }
      })
    ]);
    expect(output.entities.some((entity) => entity.kind === "style_token")).toBe(false);
  });
});
