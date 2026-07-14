import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";

export class GitEgressDeniedError extends Error {
  readonly code = "GIT_EGRESS_DENIED";

  constructor() {
    super("Git remote is not allowed by the outbound network policy");
  }
}

export interface GitDnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

const resolver: GitDnsResolver = { resolve4, resolve6 };

function blockedIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19));
}

function blockedIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return mapped ? blockedIpv4(mapped[1]) : false;
}

function blockedAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? blockedIpv4(address) : family === 6 ? blockedIpv6(address) : true;
}

export async function assertAllowedGitUrl(url: URL, dns: GitDnsResolver = resolver): Promise<void> {
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || !url.hostname) {
    throw new GitEgressDeniedError();
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || blockedAddress(hostname) && isIP(hostname)) throw new GitEgressDeniedError();
  let addresses: string[];
  try {
    addresses = isIP(hostname)
      ? [hostname]
      : [...await dns.resolve4(hostname), ...await dns.resolve6(hostname)];
  } catch {
    throw new GitEgressDeniedError();
  }
  if (!addresses.length || addresses.some(blockedAddress)) throw new GitEgressDeniedError();
}
