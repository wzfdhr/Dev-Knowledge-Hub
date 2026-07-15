import { describe, expect, test } from "vitest";

import {
  InvalidStageEventCursorError,
  parseLastStageEventId,
  replayStageEvents,
  stageSseEvent,
  type PipelineStageEvent
} from "./events";

const events: PipelineStageEvent[] = [
  {
    sequence: 41,
    buildId: "build-1",
    stageRunId: "run-1",
    stage: "convert",
    status: "queued",
    occurredAt: "2026-07-14T00:00:00.000Z"
  },
  {
    sequence: 42,
    buildId: "build-1",
    stageRunId: "run-1",
    stage: "convert",
    status: "succeeded",
    occurredAt: "2026-07-14T00:00:01.000Z"
  }
];

describe("pipeline stage events", () => {
  test("replays only events after Last-Event-ID and formats an SSE payload without artifact data", () => {
    expect(replayStageEvents(events, parseLastStageEventId("41"))).toEqual([events[1]]);
    expect(stageSseEvent(events[1]!)).toBe(
      "id: 42\nevent: stage.updated\ndata: {\"sequence\":42,\"buildId\":\"build-1\",\"stageRunId\":\"run-1\",\"stage\":\"convert\",\"status\":\"succeeded\",\"occurredAt\":\"2026-07-14T00:00:01.000Z\"}\n\n"
    );
  });

  test("uses zero for a fresh connection and rejects malformed cursors", () => {
    expect(parseLastStageEventId(undefined)).toBe(0);
    expect(() => parseLastStageEventId("4.2")).toThrow(InvalidStageEventCursorError);
    expect(() => parseLastStageEventId("-1")).toThrow(InvalidStageEventCursorError);
  });
});
