import type { PipelineStageEvent } from "../../../shared/api-contracts.js";

export type { PipelineStageEvent };

export class InvalidStageEventCursorError extends Error {
  constructor() {
    super("Last-Event-ID must be a non-negative integer");
    this.name = "InvalidStageEventCursorError";
  }
}

export function parseLastStageEventId(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d+$/.test(value)) throw new InvalidStageEventCursorError();
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) throw new InvalidStageEventCursorError();
  return sequence;
}

export function replayStageEvents(
  events: readonly PipelineStageEvent[],
  afterSequence: number
): PipelineStageEvent[] {
  return events.filter((event) => event.sequence > afterSequence);
}

export function stageSseEvent(event: PipelineStageEvent): string {
  return `id: ${event.sequence}\nevent: stage.updated\ndata: ${JSON.stringify(event)}\n\n`;
}
