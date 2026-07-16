export class ImportTimeoutError extends Error {
  readonly retryable = true;
}

export function retryImport(attempt: number): boolean {
  return attempt < 3;
}

export const retryableImport = true;
