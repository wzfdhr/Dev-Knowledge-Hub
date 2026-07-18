import { Worker } from "node:worker_threads";

import { describe, expect, test } from "vitest";

import { AnalyzerWorkerHost, ParserRuntimeError } from "./analyzer-worker-host";

function evalWorker(source: string) {
  return () => new Worker(source, { eval: true });
}

function resultWorker(value: unknown) {
  return evalWorker(`const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ type: 'result', payload: new TextEncoder().encode(${JSON.stringify(JSON.stringify(value))}) });`);
}

describe("AnalyzerWorkerHost", () => {
  test("returns a bounded worker result", async () => {
    const host = new AnalyzerWorkerHost({
      workerFactory: resultWorker({ outputs: [] }),
      timeoutMs: 1_000,
      maxOutputBytes: 1_024
    });
    await expect(host.run()).resolves.toEqual({ outputs: [] });
  });

  test("terminates an analyzer that exceeds its wall-clock limit", async () => {
    const host = new AnalyzerWorkerHost({
      workerFactory: evalWorker("while (true) {}"), timeoutMs: 25, maxOutputBytes: 1_024
    });
    await expect(host.run()).rejects.toMatchObject({ code: "PARSER_TIMEOUT" });
  });

  test("terminates only the current analyzer when cancelled", async () => {
    const controller = new AbortController();
    const host = new AnalyzerWorkerHost({
      workerFactory: evalWorker("setInterval(() => {}, 1000)"), timeoutMs: 1_000, maxOutputBytes: 1_024
    });
    const running = host.run(controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "PARSER_CANCELLED" });
  });

  test("maps worker crashes and oversized output to stable runtime errors", async () => {
    const crashed = new AnalyzerWorkerHost({
      workerFactory: evalWorker("throw new Error('worker crash')"), timeoutMs: 1_000, maxOutputBytes: 1_024
    });
    await expect(crashed.run()).rejects.toMatchObject({ code: "PARSER_WORKER_CRASH" });

    const oversized = new AnalyzerWorkerHost({
      workerFactory: evalWorker("require('node:worker_threads').parentPort.postMessage({ type: 'error', code: 'PARSER_OUTPUT_LIMIT' })"),
      timeoutMs: 1_000,
      maxOutputBytes: 1_024
    });
    await expect(oversized.run()).rejects.toMatchObject({ code: "PARSER_OUTPUT_LIMIT" });
  });

  test("immediately rejects a worker that exits cleanly without a result", async () => {
    const host = new AnalyzerWorkerHost({
      workerFactory: evalWorker("process.exit(0)"), timeoutMs: 1_000, maxOutputBytes: 1_024
    });
    await expect(host.run()).rejects.toMatchObject({ code: "PARSER_WORKER_CRASH" });
  });

  test("rejects unframed worker values instead of cloning them into the result contract", async () => {
    const host = new AnalyzerWorkerHost({
      workerFactory: evalWorker("require('node:worker_threads').parentPort.postMessage({ outputs: [] })"),
      timeoutMs: 1_000,
      maxOutputBytes: 1_024
    });
    await expect(host.run()).rejects.toMatchObject({ code: "PARSER_WORKER_CRASH" });
  });

  test("uses a typed error contract", () => {
    expect(new ParserRuntimeError("PARSER_RUNTIME_UNAVAILABLE", "offline")).toMatchObject({
      name: "ParserRuntimeError", code: "PARSER_RUNTIME_UNAVAILABLE", message: "offline"
    });
  });
});
