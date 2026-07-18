import { chmod, mkdir, rm } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";

import { ParserRuntimeError, type ParserRuntimeErrorCode } from "./analyzer-worker-host.js";
import {
  LengthPrefixedJsonDecoder,
  encodeParserFrame,
  parserAnalyzeRequestSchema,
  parserCancelRequestSchema,
  type ParserAnalyzeRequest,
  type ParserServiceResponse
} from "./parser-protocol.js";
import { VirtualSourceFs } from "./virtual-source-fs.js";

export interface ParserServiceOptions {
  socketPath: string;
  execute: (request: ParserAnalyzeRequest, signal: AbortSignal) => Promise<unknown>;
}

function runtimeError(error: unknown, aborted: boolean): { code: ParserRuntimeErrorCode; message: string } {
  if (aborted) return { code: "PARSER_CANCELLED", message: "Parser request was cancelled" };
  if (error instanceof ParserRuntimeError) return { code: error.code, message: error.message };
  return { code: "PARSER_WORKER_CRASH", message: "Parser execution failed" };
}

export class ParserService {
  #server: Server | null = null;
  readonly #active = new Map<string, AbortController>();

  constructor(private readonly options: ParserServiceOptions) {}

  async start(): Promise<void> {
    if (this.#server) return;
    await mkdir(path.dirname(this.options.socketPath), { recursive: true });
    await rm(this.options.socketPath, { force: true });
    const server = net.createServer((socket) => this.handle(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, async () => {
        server.off("error", reject);
        try {
          await chmod(this.options.socketPath, 0o600);
          resolve();
        } catch (error) {
          server.close(() => reject(error));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const controller of this.#active.values()) controller.abort();
    this.#active.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.options.socketPath, { force: true });
  }

  private handle(socket: Socket): void {
    const decoder = new LengthPrefixedJsonDecoder();
    const send = (response: ParserServiceResponse) => {
      if (!socket.destroyed) socket.write(encodeParserFrame(response));
    };
    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        const cancellation = parserCancelRequestSchema.safeParse(frame);
        if (cancellation.success) {
          this.#active.get(cancellation.data.requestId)?.abort();
          continue;
        }
        const parsed = parserAnalyzeRequestSchema.safeParse(frame);
        if (!parsed.success || this.#active.has(parsed.data?.requestId ?? "")) {
          const requestId = parsed.success ? parsed.data.requestId : "00000000-0000-4000-8000-000000000000";
          send({ type: "error", requestId, code: "PARSER_INVALID_REQUEST", message: "Parser request is invalid" });
          continue;
        }
        try {
          new VirtualSourceFs(parsed.data.sources);
        } catch {
          send({ type: "error", requestId: parsed.data.requestId, code: "PARSER_INVALID_REQUEST", message: "Parser sources are invalid" });
          continue;
        }
        const controller = new AbortController();
        this.#active.set(parsed.data.requestId, controller);
        void this.options.execute(parsed.data as ParserAnalyzeRequest, controller.signal)
          .then((result) => send({ type: "result", requestId: parsed.data.requestId, result }))
          .catch((error: unknown) => {
            const mapped = runtimeError(error, controller.signal.aborted);
            send({ type: "error", requestId: parsed.data.requestId, ...mapped });
          })
          .finally(() => this.#active.delete(parsed.data.requestId));
      }
    });
    socket.on("error", () => undefined);
  }
}
