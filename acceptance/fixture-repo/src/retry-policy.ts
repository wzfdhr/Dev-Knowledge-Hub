export const RETRY_LIMIT = 3;

export function shouldRetry(attempt: number): boolean {
  return attempt < RETRY_LIMIT;
}
