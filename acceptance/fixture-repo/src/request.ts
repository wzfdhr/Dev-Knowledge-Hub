import { shouldRetry } from "./retry-policy.js";

export async function requestWithRetry(run: () => Promise<string>): Promise<string> {
  for (let attempt = 1; shouldRetry(attempt); attempt += 1) {
    try {
      return await run();
    } catch {
      continue;
    }
  }
  throw new Error("Retry limit reached");
}
