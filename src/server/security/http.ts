import type { FastifyInstance, FastifyRequest } from "fastify";

export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export interface RateLimitPolicy {
  setup: number;
  login: number;
  mcp: number;
  feedback: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  setup: 5,
  login: 10,
  mcp: 120,
  feedback: 30,
  windowMs: 60_000
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

type BucketName = Exclude<keyof RateLimitPolicy, "windowMs">;

function bucketFor(request: FastifyRequest): BucketName | undefined {
  const pathname = request.url.split("?", 1)[0];
  if (request.method === "POST" && pathname === "/api/setup") return "setup";
  if (request.method === "POST" && pathname === "/api/session") return "login";
  if (pathname === "/mcp") return "mcp";
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
  const counters = new Map<string, { count: number; resetAt: number }>();

  server.addHook("onRequest", async (request, reply) => {
    const headers = {
      "content-security-policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'",
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
    const current = counters.get(key);
    const entry = !current || current.resetAt <= timestamp
      ? { count: 1, resetAt: timestamp + policy.windowMs }
      : { ...current, count: current.count + 1 };
    counters.set(key, entry);
    if (entry.count <= policy[bucket]) return;

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000));
    reply.header("retry-after", retryAfter).code(429).send({
      error: { code: "RATE_LIMITED", message: "Too many requests" }
    });
  });

}
