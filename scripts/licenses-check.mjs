import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("node_modules");
const entries = await readdir(root, { withFileTypes: true });
const missing = [];

for (const entry of entries) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) {
    continue;
  }

  if (entry.name.startsWith("@")) {
    const scopedEntries = await readdir(path.join(root, entry.name), { withFileTypes: true });
    for (const scopedEntry of scopedEntries) {
      if (!scopedEntry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(root, entry.name, scopedEntry.name, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!manifest.license) {
        missing.push(`${entry.name}/${scopedEntry.name}`);
      }
    }
    continue;
  }

  const manifestPath = path.join(root, entry.name, "package.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest.license) {
      missing.push(entry.name);
    }
  } catch {
    continue;
  }
}

if (missing.length > 0) {
  console.error("Packages missing a license field:");
  for (const packageName of missing) {
    console.error(`- ${packageName}`);
  }
  process.exit(1);
}

console.log("License check passed.");
