import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;

function base32Encode(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? `${encoded}${BASE32_ALPHABET[(value << (5 - bits)) & 31]}` : encoded;
}

function base32Decode(value: string): Buffer | null {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (!normalized || /[^A-Z2-7]/.test(normalized)) return null;
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

export function createTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function generateTotp(secret: string, now = new Date(), digits = 6): string {
  const decoded = base32Decode(secret);
  if (!decoded || digits < 6 || digits > 8) throw new Error("Invalid TOTP secret or digits");
  return hotp(decoded, Math.floor(now.getTime() / 1_000 / TOTP_STEP_SECONDS), digits);
}

export function verifyTotp(code: string, secret: string, now = new Date()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const decoded = base32Decode(secret);
  if (!decoded) return false;
  const counter = Math.floor(now.getTime() / 1_000 / TOTP_STEP_SECONDS);
  return [-1, 0, 1].some((offset) => {
    const candidate = hotp(decoded, counter + offset, 6);
    return timingSafeEqual(Buffer.from(code), Buffer.from(candidate));
  });
}

export function createRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const value = base32Encode(randomBytes(8));
    return `${value.slice(0, 6)}-${value.slice(6, 12)}-${value.slice(12)}`;
  });
}

export async function hashRecoveryCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(code, salt, 32) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyRecoveryCode(code: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, expected, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expected || extra) return false;
  const saltBytes = Buffer.from(salt, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (saltBytes.length !== 16 || expectedBytes.length !== 32) return false;
  const actual = await scrypt(code, saltBytes, expectedBytes.length) as Buffer;
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

export function totpUri(email: string, secret: string, issuer = "Dev Knowledge Hub"): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}
