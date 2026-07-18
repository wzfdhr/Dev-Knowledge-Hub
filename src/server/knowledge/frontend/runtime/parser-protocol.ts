import { z } from "zod";

import type { VirtualSourceInput } from "./virtual-source-fs.js";

export const DEFAULT_PARSER_FRAME_BYTES = 40 * 1024 * 1024;

const virtualSourceSchema = z.object({
  path: z.string().min(1).max(1_024),
  contentBase64: z.string(),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/i)
});

export const parserAnalyzeRequestSchema = z.object({
  type: z.literal("analyze"),
  requestId: z.uuid(),
  snapshotId: z.string().min(1).max(200),
  analyzerIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/)).max(100),
  sources: z.array(virtualSourceSchema)
});

export interface ParserAnalyzeRequest {
  type: "analyze";
  requestId: string;
  snapshotId: string;
  analyzerIds: string[];
  sources: VirtualSourceInput[];
}

export const parserCancelRequestSchema = z.object({
  type: z.literal("cancel"),
  requestId: z.uuid()
});

export type ParserServiceResponse =
  | { type: "result"; requestId: string; result: unknown }
  | { type: "error"; requestId: string; code: string; message: string };

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
      this.#buffer = this.#buffer.subarray(4 + length);
      values.push(JSON.parse(payload.toString("utf8")) as unknown);
    }
    return values;
  }
}
