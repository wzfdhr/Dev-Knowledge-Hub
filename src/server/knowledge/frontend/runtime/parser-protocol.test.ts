import { describe, expect, test } from "vitest";

import {
  DEFAULT_PARSER_FRAME_BYTES,
  LengthPrefixedJsonDecoder,
  encodeParserFrame,
  parserServiceResponseSchema
} from "./parser-protocol";

describe("parser protocol framing", () => {
  test("decodes fragmented and coalesced length-prefixed JSON frames", () => {
    const decoder = new LengthPrefixedJsonDecoder(1024);
    const first = encodeParserFrame({ type: "cancel", requestId: "request-1" }, 1024);
    const second = encodeParserFrame({ type: "cancel", requestId: "request-2" }, 1024);

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { type: "cancel", requestId: "request-1" },
      { type: "cancel", requestId: "request-2" }
    ]);
  });

  test("rejects outgoing and incoming frames above the configured byte limit", () => {
    expect(() => encodeParserFrame({ value: "x".repeat(100) }, 16)).toThrow("frame byte limit");
    const decoder = new LengthPrefixedJsonDecoder(16);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(17);
    expect(() => decoder.push(header)).toThrow("frame byte limit");
  });

  test("fits the maximum virtual source payload after base64 expansion", () => {
    expect(DEFAULT_PARSER_FRAME_BYTES).toBeGreaterThan(32 * 1024 * 1024 * 4 / 3 + 5 * 1024 * 1024);
  });

  test("rejects unknown service response types and error codes", () => {
    expect(parserServiceResponseSchema.safeParse({ type: "other", requestId: crypto.randomUUID() }).success).toBe(false);
    expect(parserServiceResponseSchema.safeParse({
      type: "error", requestId: crypto.randomUUID(), code: "UNKNOWN", message: "bad"
    }).success).toBe(false);
  });
});
