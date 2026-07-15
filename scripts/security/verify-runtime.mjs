import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function dependencyNames(project) {
  return [...new Set([
    ...Object.keys(project.dependencies ?? {}),
    ...Object.keys(project.optionalDependencies ?? {})
  ])].sort();
}

export function verifyRuntimeContract(project, lock, audit) {
  const failures = [];
  if (project.private !== true) failures.push("package.json must be private");
  if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 3) failures.push("package-lock.json must use lockfileVersion 3 or newer");
  for (const name of dependencyNames(project)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry?.version) failures.push(`runtime dependency missing from lockfile: ${name}`);
  }
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!location.startsWith("node_modules/") || entry?.link) continue;
    if (!entry?.version || !entry?.integrity) failures.push(`locked package lacks version or integrity: ${location}`);
  }
  const vulnerabilities = audit?.metadata?.vulnerabilities ?? {};
  for (const severity of ["high", "critical"]) {
    if (Number(vulnerabilities[severity] ?? 0) > 0) failures.push(`npm audit reports ${severity} production vulnerabilities`);
  }
  return failures;
}

async function main() {
  const root = process.cwd();
  const [project, lock] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse)
  ]);
  const audit = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], {
    cwd: root,
    encoding: "utf8"
  });
  const report = JSON.parse(audit.stdout || "{}");
  const failures = verifyRuntimeContract(project, lock, report);
  if (audit.status !== 0 && failures.length === 0) failures.push("npm audit could not complete");
  if (failures.length) throw new Error(`Runtime verification failed: ${failures.join("; ")}`);
  console.log("Runtime dependency integrity and production vulnerability checks passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
