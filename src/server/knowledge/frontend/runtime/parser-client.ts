import { randomUUID } from "node:crypto";
import net from "node:net";

import { ParserRuntimeError, type ParserRuntimeErrorCode } from "./analyzer-worker-host.js";
import {
  LengthPrefixedJsonDecoder,
  encodeParserFrame,
  type ParserAnalyzeRequest,
  type ParserServiceResponse
} from "./parser-protocol.js";

export interface ParserClientOptions {
  socketPath: string;
  connectTimeoutMs?: number;
}

export class ParserClient {
  constructor(private readonly options: ParserClientOptions) {}

  analyze(
    input: Omit<ParserAnalyzeRequest, "type" | "requestId">,
    signal?: AbortSignal
  ): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.options.socketPath);
      const decoder = new LengthPrefixedJsonDecoder();
      let settled = false;
      let cancelling = false;
      const finish = (result: { value: unknown } | { error: ParserRuntimeError }) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
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
        if (socket.destroyed) cancelled();
        else socket.write(encodeParserFrame({ type: "cancel", requestId }), () => {
          socket.end();
          cancelled();
        });
      };
      const connectTimer = setTimeout(() => {
        finish({ error: new ParserRuntimeError("PARSER_RUNTIME_UNAVAILABLE", "Parser service is unavailable") });
      }, this.options.connectTimeoutMs ?? 1_000);
      connectTimer.unref?.();
      socket.once("connect", () => {
        socket.write(encodeParserFrame({ type: "analyze", requestId, ...input }));
        if (signal?.aborted) cancel();
      });
      socket.on("data", (chunk) => {
        try {
          for (const raw of decoder.push(chunk)) {
            const response = raw as ParserServiceResponse;
            if (response.requestId !== requestId) continue;
            if (response.type === "result") finish({ value: response.result });
            else finish({ error: new ParserRuntimeError(
              response.code as ParserRuntimeErrorCode,
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
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
}
