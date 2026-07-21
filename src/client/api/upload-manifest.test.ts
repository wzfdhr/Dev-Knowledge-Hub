import { describe, expect, test, vi } from "vitest";

import { canonicalUploadManifestDigest } from "../../server/uploads/upload-session";
import { createUploadManifest } from "./upload-manifest";
import { buildUploadManifestInWorker, uploadManifestMetadataBytes } from "./upload-manifest-worker";

describe("upload manifest worker", () => {
  test("hashes source files but records asset metadata without reading asset contents", async () => {
    const asset = {
      name: "logo.png", size: 3, type: "image/png",
      arrayBuffer: async () => { throw new Error("asset contents must not be read"); }
    } as unknown as File;
    const files = [
      { path: "src/index.ts", kind: "source" as const, file: new File(["export {};\n"], "index.ts", { type: "text/typescript" }) },
      { path: "assets/logo.png", kind: "asset" as const, file: asset }
    ];

    const result = await buildUploadManifestInWorker(files);

    expect(result.entries).toEqual([
      expect.objectContaining({ ordinal: 0, path: "src/index.ts", kind: "source", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ ordinal: 1, path: "assets/logo.png", kind: "asset", contentHash: null })
    ]);
    expect(result.manifestDigest).toBe(canonicalUploadManifestDigest(result.entries));
  });

  test("runs manifest work through one module Worker and terminates it", async () => {
    const expected = await buildUploadManifestInWorker([
      { path: "src/index.ts", kind: "source", file: new File(["export {};"], "index.ts") }
    ]);
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: vi.fn(function (this: typeof worker) {
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: { id: "request", result: expected } })));
      }),
      terminate: vi.fn()
    };

    const result = await createUploadManifest(
      [{ path: "src/index.ts", kind: "source", file: new File(["export {};"], "index.ts") }],
      () => worker as unknown as Worker,
      "request"
    );

    expect(result).toEqual(expected);
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  test("rejects manifest metadata before creating a second oversized canonical buffer", async () => {
    const files = [{
      path: `src/${"界".repeat(100)}.ts`,
      kind: "asset" as const,
      file: new File([], "asset.ts")
    }];
    const entry = {
      ordinal: 0, path: files[0]!.path, kind: "asset" as const,
      byteSize: 0, contentHash: null, mediaType: null
    };

    expect(uploadManifestMetadataBytes([entry]))
      .toBe(new TextEncoder().encode(JSON.stringify([entry])).byteLength);
    await expect(buildUploadManifestInWorker(files, 32))
      .rejects.toThrow("Upload manifest metadata exceeds 32 bytes");
  });
});
