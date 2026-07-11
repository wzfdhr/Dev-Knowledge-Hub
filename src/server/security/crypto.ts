import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function decodeMasterKey(masterKey: string): Buffer {
  const key = Buffer.from(masterKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== masterKey) {
    throw new Error("Master key must be exactly 32 bytes encoded as base64");
  }
  return key;
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeMasterKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload: EncryptedPayload = {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decryptSecret(payload: string, masterKey: string): string {
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as EncryptedPayload;
  if (parsed.version !== 1) throw new Error("Unsupported encrypted payload");

  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeMasterKey(masterKey),
    Buffer.from(parsed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}
