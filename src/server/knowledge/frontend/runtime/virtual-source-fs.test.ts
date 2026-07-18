import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { VirtualSourceFs } from "./virtual-source-fs";

function source(path: string, content: string, blobHash = createHash("sha256").update(content).digest("hex")) {
  return { path, contentBase64: Buffer.from(content).toString("base64"), blobHash };
}

describe("VirtualSourceFs", () => {
  test("exposes validated source bytes without touching the host filesystem", () => {
    const fs = new VirtualSourceFs([source("src/app.ts", "export const app = true;\n")]);

    expect(fs.paths()).toEqual(["src/app.ts"]);
    expect(fs.readText("src/app.ts")).toBe("export const app = true;\n");
    expect(fs.readBytes("src/app.ts")).toEqual(Buffer.from("export const app = true;\n"));
  });

  test.each(["/etc/passwd", "../secret", "src/../../secret", "src\\app.ts", "src/\0app.ts", "."])(
    "rejects unsafe virtual path %s",
    (path) => expect(() => new VirtualSourceFs([source(path, "x")])).toThrow("safe relative POSIX path")
  );

  test("rejects duplicate paths and content that does not match its declared hash", () => {
    expect(() => new VirtualSourceFs([source("src/app.ts", "a"), source("src/app.ts", "b")]))
      .toThrow("duplicate path");
    expect(() => new VirtualSourceFs([source("src/app.ts", "a", "0".repeat(64))]))
      .toThrow("blob hash");
  });

  test("enforces file count, per-file bytes, and total bytes before analysis", () => {
    expect(() => new VirtualSourceFs(
      [source("a.ts", "a"), source("b.ts", "b")],
      { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 10 }
    )).toThrow("file count");
    expect(() => new VirtualSourceFs(
      [source("a.ts", "ab")],
      { maxFiles: 2, maxFileBytes: 1, maxTotalBytes: 10 }
    )).toThrow("file byte limit");
    expect(() => new VirtualSourceFs(
      [source("a.ts", "ab"), source("b.ts", "cd")],
      { maxFiles: 2, maxFileBytes: 2, maxTotalBytes: 3 }
    )).toThrow("total byte limit");
  });
});
