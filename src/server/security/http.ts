import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    cspNonce: string;
  }
}

export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export interface RateLimitPolicy {
  setup: number;
  login: number;
  mcp: number;
  feedback: number;
  upload?: number;
  uploadOperation?: number;
  windowMs: number;
  maxEntries: number;
  sweepIntervalMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  setup: 5,
  login: 10,
  mcp: 120,
  feedback: 30,
  upload: 5,
  uploadOperation: 1_000,
  windowMs: 60_000,
  maxEntries: 10_000,
  sweepIntervalMs: 60_000
};

const sensitiveKey = /(?:authorization|cookie|password|token|api.?key|secret|credential)/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sensitiveKey.test(key) ? "[REDACTED]" : redactSensitive(child)
  ]));
}

type BucketName = "setup" | "login" | "mcp" | "feedback" | "upload" | "uploadOperation";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitDecision extends RateLimitEntry {
  limited: boolean;
}

export class RateLimitState {
  private readonly entries = new Map<string, RateLimitEntry>();
  private nextSweepAt = 0;
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;

  constructor({ maxEntries, sweepIntervalMs }: { maxEntries: number; sweepIntervalMs: number }) {
    this.maxEntries = Math.max(1, maxEntries);
    this.sweepIntervalMs = Math.max(1, sweepIntervalMs);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  private removeExpired(timestamp: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= timestamp) this.entries.delete(key);
    }
  }

  private evictOldest(): void {
    const oldestKey = this.entries.keys().next().value;
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }

  consume(key: string, limit: number, timestamp: number, windowMs: number): RateLimitDecision {
    if (timestamp >= this.nextSweepAt) {
      this.removeExpired(timestamp);
      this.nextSweepAt = timestamp + this.sweepIntervalMs;
    }
    const current = this.entries.get(key);
    if (!current && this.entries.size >= this.maxEntries) {
      this.removeExpired(timestamp);
      if (this.entries.size >= this.maxEntries) this.evictOldest();
    }
    const entry = !current || current.resetAt <= timestamp
      ? { count: 1, resetAt: timestamp + windowMs }
      : { ...current, count: current.count + 1 };
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry, limited: entry.count > limit };
  }
}

export class UploadBodyConcurrencyState {
  private active = 0;
  private readonly byClient = new Map<string, number>();
  private readonly bySession = new Map<string, number>();

  constructor(private readonly limits = { global: 4, client: 2, session: 2 }) {}

  acquire(client: string, session: string): (() => void) | null {
    if (this.active >= this.limits.global
      || (this.byClient.get(client) ?? 0) >= this.limits.client
      || (this.bySession.get(session) ?? 0) >= this.limits.session) return null;
    this.active += 1;
    this.byClient.set(client, (this.byClient.get(client) ?? 0) + 1);
    this.bySession.set(session, (this.bySession.get(session) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      decrement(this.byClient, client);
      decrement(this.bySession, session);
    };
  }
}

function decrement(values: Map<string, number>, key: string): void {
  const next = (values.get(key) ?? 1) - 1;
  if (next <= 0) values.delete(key);
  else values.set(key, next);
}

function bucketFor(request: FastifyRequest): BucketName | undefined {
  const pathname = request.url.split("?", 1)[0];
  if (request.method === "POST" && pathname === "/api/setup") return "setup";
  if (request.method === "POST" && pathname === "/api/session") return "login";
  if (pathname === "/mcp") return "mcp";
  if (request.method === "POST" && (
    /^\/api\/projects\/[^/]+\/folder-import$/u.test(pathname ?? "")
    || /^\/api\/repositories\/[^/]+\/folder-import$/u.test(pathname ?? "")
    || /^\/api\/projects\/[^/]+\/upload-sessions$/u.test(pathname ?? "")
  )) {
    return "upload";
  }
  if (["PUT", "POST", "DELETE"].includes(request.method)
    && /^\/api\/projects\/[^/]+\/upload-sessions\/[^/]+(?:\/|$)/u.test(pathname ?? "")) {
    return "uploadOperation";
  }
  if ((request.method === "POST" || request.method === "PATCH") && pathname.startsWith("/api/feedback/")) {
    return "feedback";
  }
  return undefined;
}

export function registerHttpSecurity(
  server: FastifyInstance,
  policy: RateLimitPolicy = DEFAULT_RATE_LIMITS,
  now: () => number = Date.now
): void {
  const counters = new RateLimitState({
    maxEntries: policy.maxEntries,
    sweepIntervalMs: policy.sweepIntervalMs
  });
  server.decorateRequest("cspNonce", "");
  server.addHook("onRequest", async (request, reply) => {
    request.cspNonce = randomBytes(32).toString("base64");
    const headers = {
      "content-security-policy": `default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'nonce-${request.cspNonce}'`,
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    };
    reply.headers(headers);
    for (const [name, value] of Object.entries(headers)) reply.raw.setHeader(name, value);
    const bucket = bucketFor(request);
    if (!bucket) return;
    const key = `${bucket}:${request.ip}`;
    const timestamp = now();
    const limit = bucket === "upload"
      ? policy.upload ?? DEFAULT_RATE_LIMITS.upload ?? 5
      : bucket === "uploadOperation"
        ? policy.uploadOperation ?? DEFAULT_RATE_LIMITS.uploadOperation ?? 1_000
        : policy[bucket];
    const entry = counters.consume(key, limit, timestamp, policy.windowMs);
    if (!entry.limited) return;

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000));
    reply.header("retry-after", retryAfter).code(429).send({
      error: { code: "RATE_LIMITED", message: "Too many requests" }
    });
  });

}
