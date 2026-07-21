import { z } from "zod";

import type { VirtualSourceInput } from "./virtual-source-fs.js";

// A 32 MiB virtual source set expands under base64 and carries path metadata.
export const DEFAULT_PARSER_FRAME_BYTES = 64 * 1024 * 1024;

export const parserRuntimeErrorCodeSchema = z.enum([
  "PARSER_RUNTIME_UNAVAILABLE",
  "PARSER_TIMEOUT",
  "PARSER_CANCELLED",
  "PARSER_WORKER_CRASH",
  "PARSER_OUTPUT_LIMIT",
  "PARSER_INVALID_REQUEST"
]);

export type ParserRuntimeErrorCode = z.infer<typeof parserRuntimeErrorCodeSchema>;

const virtualSourceSchema = z.object({
  path: z.string().min(1).max(1_024),
  contentBase64: z.string(),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/i)
});

const cachedSourceAnalysisSchema = z.object({
  path: z.string().min(1).max(1_024),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/i),
  analyzerId: z.literal("typescript-syntax"),
  analyzerVersion: z.literal("1.0.0"),
  parserConfigDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  facts: z.record(z.string(), z.json())
}).strict();

export const parserRequestIdSchema = z.uuid();

export const parserAnalyzeRequestSchema = z.object({
  type: z.literal("analyze"),
  requestId: parserRequestIdSchema,
  snapshotId: z.string().min(1).max(200),
  analyzerIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/)).max(100),
  sources: z.array(virtualSourceSchema),
  cachedAnalyses: z.array(cachedSourceAnalysisSchema).max(5_000).default([])
});

export interface ParserAnalyzeRequest {
  type: "analyze";
  requestId: string;
  snapshotId: string;
  analyzerIds: string[];
  sources: VirtualSourceInput[];
  cachedAnalyses?: z.infer<typeof cachedSourceAnalysisSchema>[];
}

export const parserCancelRequestSchema = z.object({
  type: z.literal("cancel"),
  requestId: parserRequestIdSchema
});

export const parserServiceResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("result"), requestId: parserRequestIdSchema, result: z.unknown() }),
  z.object({
    type: z.literal("error"),
    requestId: parserRequestIdSchema,
    code: parserRuntimeErrorCodeSchema,
    message: z.string().min(1).max(1_000)
  })
]);

export type ParserServiceResponse = z.infer<typeof parserServiceResponseSchema>;

export function encodeParserFrame(value: unknown, maxFrameBytes = DEFAULT_PARSER_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > maxFrameBytes) throw new Error("Parser frame byte limit exceeded");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class LengthPrefixedJsonDecoder {
  #buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = DEFAULT_PARSER_FRAME_BYTES) {}

  push(chunk: Uint8Array | string): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > this.maxFrameBytes) throw new Error("Parser frame byte limit exceeded");
      if (this.#buffer.byteLength < 4 + length) break;
      const payload = this.#buffer.subarray(4, 4 + length);
      const remainder = this.#buffer.subarray(4 + length);
      this.#buffer = remainder.byteLength === 0 ? Buffer.alloc(0) : Buffer.from(remainder);
      values.push(JSON.parse(payload.toString("utf8")) as unknown);
    }
    return values;
  }
}
