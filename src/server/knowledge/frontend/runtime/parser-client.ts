import { randomUUID } from "node:crypto";
import net from "node:net";

import { ParserRuntimeError } from "./analyzer-worker-host.js";
import {
  LengthPrefixedJsonDecoder,
  encodeParserFrame,
  parserServiceResponseSchema,
  type ParserAnalyzeRequest,
  type ParserServiceResponse
} from "./parser-protocol.js";

export interface ParserClientOptions {
  socketPath: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class ParserClient {
  constructor(private readonly options: ParserClientOptions) {}

  analyze(
    input: Omit<ParserAnalyzeRequest, "type" | "requestId">,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new ParserRuntimeError("PARSER_CANCELLED", "Parser request was cancelled"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.options.socketPath);
      const decoder = new LengthPrefixedJsonDecoder();
      let settled = false;
      let cancelling = false;
      let connected = false;
      let requestSent = false;
      let requestTimer: NodeJS.Timeout | undefined;
      const finish = (result: { value: unknown } | { error: ParserRuntimeError }) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (requestTimer) clearTimeout(requestTimer);
        signal?.removeEventListener("abort", cancel);
        socket.destroy();
        if ("error" in result) reject(result.error);
        else resolve(result.value);
      };
      const cancel = () => {
        if (settled || cancelling) return;
        cancelling = true;
        const cancelled = () => finish({
          error: new ParserRuntimeError("PARSER_CANCELLED", "Parser request was cancelled")
        });
        if (!connected || !requestSent || socket.destroyed) {
          socket.destroy();
          cancelled();
        } else socket.write(encodeParserFrame({ type: "cancel", requestId }), () => {
          socket.end();
          cancelled();
        });
      };
      const connectTimer = setTimeout(() => {
        finish({ error: new ParserRuntimeError("PARSER_RUNTIME_UNAVAILABLE", "Parser service is unavailable") });
      }, this.options.connectTimeoutMs ?? 1_000);
      connectTimer.unref?.();
      socket.once("connect", () => {
        connected = true;
        clearTimeout(connectTimer);
        if (cancelling || signal?.aborted) {
          cancel();
          return;
        }
        let frame: Buffer;
        try {
          frame = encodeParserFrame({ type: "analyze", requestId, ...input });
        } catch {
          finish({ error: new ParserRuntimeError("PARSER_INVALID_REQUEST", "Parser request exceeds protocol limits") });
          return;
        }
        requestSent = true;
        requestTimer = setTimeout(() => finish({
          error: new ParserRuntimeError("PARSER_TIMEOUT", "Parser request exceeded its response deadline")
        }), this.options.requestTimeoutMs ?? 35_000);
        requestTimer.unref?.();
        socket.write(frame);
      });
      socket.on("data", (chunk) => {
        try {
          for (const raw of decoder.push(chunk)) {
            const parsed = parserServiceResponseSchema.safeParse(raw);
            if (!parsed.success) throw new Error("Invalid parser response");
            const response: ParserServiceResponse = parsed.data;
            if (response.requestId !== requestId) continue;
            if (response.type === "result") finish({ value: response.result });
            else finish({ error: new ParserRuntimeError(
              response.code,
              response.message
            ) });
          }
        } catch {
          finish({ error: new ParserRuntimeError("PARSER_WORKER_CRASH", "Parser service returned an invalid response") });
        }
      });
      socket.once("error", () => {
        finish({ error: new ParserRuntimeError(
          cancelling ? "PARSER_CANCELLED" : "PARSER_RUNTIME_UNAVAILABLE",
          cancelling ? "Parser request was cancelled" : "Parser service is unavailable"
        ) });
      });
      const closed = () => finish({ error: new ParserRuntimeError(
        cancelling ? "PARSER_CANCELLED" : "PARSER_RUNTIME_UNAVAILABLE",
        cancelling ? "Parser request was cancelled" : "Parser service closed the connection"
      ) });
      socket.once("end", closed);
      socket.once("close", closed);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
}
