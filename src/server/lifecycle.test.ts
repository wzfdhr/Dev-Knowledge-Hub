import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import { installSignalShutdown } from "./lifecycle";

describe("production lifecycle", () => {
  test("closes once when termination signals repeat", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => {});
    const remove = installSignalShutdown({ close }, signals);

    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    remove();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
