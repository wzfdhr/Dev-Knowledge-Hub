import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ParserClient } from "./parser-client";
import { ParserService } from "./parser-service";
import type { ParserAnalyzeRequest } from "./parser-protocol";

const roots: string[] = [];

async function socketPath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "devkh-parser-service-"));
  roots.push(root);
  return path.join(root, "parser.sock");
}

function request(): Omit<ParserAnalyzeRequest, "type" | "requestId"> {
  const content = "export const app = true;\n";
  return {
    snapshotId: "snapshot-1",
    analyzerIds: ["typescript-core"],
    sources: [{
      path: "src/app.ts",
      contentBase64: Buffer.from(content).toString("base64"),
      blobHash: createHash("sha256").update(content).digest("hex")
    }]
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ParserService", () => {
  test("serves a validated request over a Unix socket and can restart", async () => {
    const socket = await socketPath();
    const service = new ParserService({
      socketPath: socket,
      execute: async (input) => ({ snapshotId: input.snapshotId, paths: input.sources.map((item) => item.path) })
    });
    await service.start();
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    const client = new ParserClient({ socketPath: socket });
    await expect(client.analyze(request())).resolves.toEqual({ snapshotId: "snapshot-1", paths: ["src/app.ts"] });
    await service.stop();

    await service.start();
    await expect(client.analyze(request())).resolves.toMatchObject({ snapshotId: "snapshot-1" });
    await service.stop();
  });

  test("returns a stable unavailable error when the service is absent", async () => {
    const client = new ParserClient({ socketPath: await socketPath(), connectTimeoutMs: 50 });
    await expect(client.analyze(request())).rejects.toMatchObject({ code: "PARSER_RUNTIME_UNAVAILABLE" });
  });

  test("propagates cancellation to the active parser execution", async () => {
    const socket = await socketPath();
    let executionSignal: AbortSignal | undefined;
    const service = new ParserService({
      socketPath: socket,
      execute: (_input, signal) => new Promise((_resolve, reject) => {
        executionSignal = signal;
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      })
    });
    await service.start();
    const controller = new AbortController();
    const running = new ParserClient({ socketPath: socket }).analyze(request(), controller.signal);
    await vi.waitFor(() => expect(executionSignal).toBeDefined());
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "PARSER_CANCELLED" });
    await vi.waitFor(() => expect(executionSignal?.aborted).toBe(true));
    await service.stop();
  });
});
