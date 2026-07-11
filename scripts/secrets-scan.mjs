import { readFile } from "node:fs/promises";
import path from "node:path";

const candidates = [
  ".env.example",
  "README.md",
  "docs/provenance.md"
];

const bannedPatterns = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY-----/,
  /postgres:\/\/[^:\s]+:(?!postgres@|password@|replace-with-password@)[^@\s]+@/
];

const findings = [];

for (const relativePath of candidates) {
  const contents = await readFile(path.resolve(relativePath), "utf8");
  for (const pattern of bannedPatterns) {
    if (pattern.test(contents)) {
      findings.push({ relativePath, pattern: pattern.source });
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`Potential secret in ${finding.relativePath}: ${finding.pattern}`);
  }
  process.exit(1);
}

console.log("Secret scan passed.");
