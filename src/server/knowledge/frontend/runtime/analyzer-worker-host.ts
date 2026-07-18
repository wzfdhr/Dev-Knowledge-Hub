import type { Worker } from "node:worker_threads";

export type ParserRuntimeErrorCode =
  | "PARSER_RUNTIME_UNAVAILABLE"
  | "PARSER_TIMEOUT"
  | "PARSER_CANCELLED"
  | "PARSER_WORKER_CRASH"
  | "PARSER_OUTPUT_LIMIT"
  | "PARSER_INVALID_REQUEST";

export class ParserRuntimeError extends Error {
  readonly name = "ParserRuntimeError";

  constructor(readonly code: ParserRuntimeErrorCode, message: string) {
    super(message);
  }
}

export interface AnalyzerWorkerHostOptions {
  workerFactory: () => Worker;
  timeoutMs: number;
  maxOutputBytes: number;
}

export class AnalyzerWorkerHost {
  constructor(private readonly options: AnalyzerWorkerHostOptions) {}

  run(signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = this.options.workerFactory();
      } catch {
        reject(new ParserRuntimeError("PARSER_RUNTIME_UNAVAILABLE", "Parser worker could not start"));
        return;
      }
      let settled = false;
      let terminating = false;
      const finish = (result: { value: unknown } | { error: ParserRuntimeError }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        worker.removeAllListeners();
        if ("error" in result) reject(result.error);
        else resolve(result.value);
      };
      const terminate = (error: ParserRuntimeError) => {
        if (settled || terminating) return;
        terminating = true;
        void worker.terminate().finally(() => finish({ error }));
      };
      const cancel = () => terminate(new ParserRuntimeError("PARSER_CANCELLED", "Parser request was cancelled"));
      const timer = setTimeout(() => {
        terminate(new ParserRuntimeError("PARSER_TIMEOUT", "Parser worker exceeded its wall-clock limit"));
      }, this.options.timeoutMs);
      timer.unref?.();
      worker.once("message", (value: unknown) => {
        let byteLength: number;
        try {
          byteLength = Buffer.byteLength(JSON.stringify(value), "utf8");
        } catch {
          terminate(new ParserRuntimeError("PARSER_OUTPUT_LIMIT", "Parser worker returned invalid output"));
          return;
        }
        if (byteLength > this.options.maxOutputBytes) {
          terminate(new ParserRuntimeError("PARSER_OUTPUT_LIMIT", "Parser worker output exceeds byte limit"));
          return;
        }
        terminating = true;
        void worker.terminate().finally(() => finish({ value }));
      });
      worker.once("error", () => {
        finish({ error: new ParserRuntimeError("PARSER_WORKER_CRASH", "Parser worker crashed") });
      });
      worker.once("exit", (code) => {
        if (!settled && !terminating && code !== 0) {
          finish({ error: new ParserRuntimeError("PARSER_WORKER_CRASH", "Parser worker exited unexpectedly") });
        }
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
}
