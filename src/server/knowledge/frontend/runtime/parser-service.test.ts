import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ParserClient } from "./parser-client";
import { ParserService } from "./parser-service";
import { encodeParserFrame, type ParserAnalyzeRequest } from "./parser-protocol";

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

  test("returns an invalid-request error correlated to a malformed request", async () => {
    const socket = await socketPath();
    const execute = vi.fn(async () => ({ outputs: [] }));
    const service = new ParserService({ socketPath: socket, execute });
    await service.start();
    const malformed = { ...request(), analyzerIds: ["INVALID ANALYZER"] };
    await expect(new ParserClient({ socketPath: socket, requestTimeoutMs: 100 }).analyze(malformed))
      .rejects.toMatchObject({ code: "PARSER_INVALID_REQUEST" });
    expect(execute).not.toHaveBeenCalled();
    await service.stop();
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

  test("keeps legitimate work running beyond the connection timeout", async () => {
    const socket = await socketPath();
    const service = new ParserService({
      socketPath: socket,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return { outputs: [] };
      }
    });
    await service.start();
    const client = new ParserClient({ socketPath: socket, connectTimeoutMs: 20, requestTimeoutMs: 500 });
    await expect(client.analyze(request())).resolves.toEqual({ outputs: [] });
    await service.stop();
  });

  test("fails with a stable error when the service closes or stops responding", async () => {
    const closedSocket = await socketPath();
    const closingConnections = new Set<net.Socket>();
    const closingServer = net.createServer((connection) => {
      closingConnections.add(connection);
      connection.once("close", () => closingConnections.delete(connection));
      connection.end();
    });
    await new Promise<void>((resolve) => closingServer.listen(closedSocket, resolve));
    await expect(new ParserClient({ socketPath: closedSocket, requestTimeoutMs: 100 }).analyze(request()))
      .rejects.toMatchObject({ code: "PARSER_RUNTIME_UNAVAILABLE" });
    for (const connection of closingConnections) connection.destroy();
    await new Promise<void>((resolve) => closingServer.close(() => resolve()));

    const stalledSocket = await socketPath();
    const stalledConnections = new Set<net.Socket>();
    const stalledServer = net.createServer((connection) => {
      stalledConnections.add(connection);
      connection.once("close", () => stalledConnections.delete(connection));
    });
    await new Promise<void>((resolve) => stalledServer.listen(stalledSocket, resolve));
    await expect(new ParserClient({ socketPath: stalledSocket, requestTimeoutMs: 25 }).analyze(request()))
      .rejects.toMatchObject({ code: "PARSER_TIMEOUT" });
    for (const connection of stalledConnections) connection.destroy();
    await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
  });

  test("does not execute a request cancelled before connecting", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ({ outputs: [] }));
    const socket = await socketPath();
    const service = new ParserService({ socketPath: socket, execute });
    await service.start();
    await expect(new ParserClient({ socketPath: socket }).analyze(request(), controller.signal))
      .rejects.toMatchObject({ code: "PARSER_CANCELLED" });
    expect(execute).not.toHaveBeenCalled();
    await service.stop();
  });

  test("aborts execution when the requesting socket disconnects", async () => {
    const socket = await socketPath();
    let executionSignal: AbortSignal | undefined;
    const service = new ParserService({
      socketPath: socket,
      execute: (_input, signal) => new Promise((_resolve, reject) => {
        executionSignal = signal;
        signal.addEventListener("abort", () => reject(new Error("disconnected")), { once: true });
      })
    });
    await service.start();
    const connection = net.createConnection(socket);
    await new Promise<void>((resolve) => connection.once("connect", resolve));
    connection.write(encodeParserFrame({ type: "analyze", requestId: crypto.randomUUID(), ...request() }));
    await vi.waitFor(() => expect(executionSignal).toBeDefined());
    connection.destroy();
    await vi.waitFor(() => expect(executionSignal?.aborted).toBe(true));
    await service.stop();
  });

  test("rejects a second connection before reading its request body", async () => {
    const socket = await socketPath();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await blocked;
      return { outputs: [] };
    });
    const service = new ParserService({
      socketPath: socket,
      execute,
      frameTimeoutMs: 1_000
    });
    await service.start();
    const first = new ParserClient({ socketPath: socket, requestTimeoutMs: 500 }).analyze(request());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const startedAt = performance.now();
    const second = net.createConnection(socket);
    second.on("error", () => undefined);
    second.once("connect", () => second.write(Buffer.from([0, 0])));
    await new Promise<void>((resolve) => second.once("close", resolve));
    const rejectedAfterMs = performance.now() - startedAt;
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual({ outputs: [] });
    await service.stop();
    expect(rejectedAfterMs).toBeLessThan(500);
  });

  test("closes an incomplete frame after the bounded read deadline", async () => {
    const socket = await socketPath();
    const execute = vi.fn(async () => ({ outputs: [] }));
    const service = new ParserService({ socketPath: socket, execute, frameTimeoutMs: 25 });
    await service.start();
    const partial = net.createConnection(socket);
    partial.on("error", () => undefined);
    await new Promise<void>((resolve) => partial.once("connect", resolve));
    partial.write(Buffer.from([0, 0]));
    await new Promise<void>((resolve) => partial.once("close", resolve));
    expect(execute).not.toHaveBeenCalled();
    await service.stop();
  });
});
