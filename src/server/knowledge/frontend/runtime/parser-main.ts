import { Worker } from "node:worker_threads";

import { AnalyzerWorkerHost } from "./analyzer-worker-host.js";
import { ParserService } from "./parser-service.js";

const socketPath = process.env.DEVKH_PARSER_SOCKET_PATH ?? "/run/devkh-parser/parser.sock";
const service = new ParserService({
  socketPath,
  execute: (request, signal) => new AnalyzerWorkerHost({
    workerFactory: () => new Worker(new URL("./analyzer-worker.js", import.meta.url), {
      workerData: request,
      env: {},
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 8
      }
    }),
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024
  }).run(signal)
});

await service.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void service.stop().finally(() => process.exit(0));
  });
}
