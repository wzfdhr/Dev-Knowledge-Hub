import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function dependencyNames(project) {
  return [...new Set([
    ...Object.keys(project.dependencies ?? {}),
    ...Object.keys(project.optionalDependencies ?? {})
  ])].sort();
}

const reactRouterRscAdvisory = "https://github.com/advisories/GHSA-qwww-vcr4-c8h2";
const reactRouterRscExceptionExpiresAt = "2026-08-27T00:00:00.000Z";

function hasDirectRscFrameworkDependency(project) {
  return [...dependencyNames(project), ...Object.keys(project.devDependencies ?? {})]
    .some((name) => name === "react-router" || name.startsWith("@react-router/"));
}

function isTemporarilyWaivableReactRouterAudit(audit, project, lock, options) {
  const viteBrowserBuild = project.dependencies?.vite ?? project.devDependencies?.vite;
  if (options.usesUnstableRscApi || hasDirectRscFrameworkDependency(project) || !viteBrowserBuild) return false;
  if (new Date(options.now).getTime() > new Date(reactRouterRscExceptionExpiresAt).getTime()) return false;
  const router = lock.packages?.["node_modules/react-router"]?.version;
  const routerDom = lock.packages?.["node_modules/react-router-dom"]?.version;
  if (router !== routerDom || !/^7\.(?:1[2-9]|[2-9]\d)\./.test(router ?? "")) return false;
  const finding = audit?.vulnerabilities?.["react-router"];
  return finding?.severity === "high"
    && Array.isArray(finding.via)
    && finding.via.length === 1
    && finding.via[0]?.url === reactRouterRscAdvisory
    && finding.via[0]?.severity === "high";
}

function containsOnlyWaivedRouterFindings(audit, project, lock, options) {
  if (!isTemporarilyWaivableReactRouterAudit(audit, project, lock, options)) return false;
  const findings = audit?.vulnerabilities ?? {};
  const routerDom = findings["react-router-dom"];
  const highFindingNames = Object.entries(findings)
    .filter(([, finding]) => finding?.severity === "high")
    .map(([name]) => name)
    .sort();
  return routerDom?.severity === "high"
    && Array.isArray(routerDom.via)
    && routerDom.via.length === 1
    && routerDom.via[0] === "react-router"
    && JSON.stringify(highFindingNames) === JSON.stringify(["react-router", "react-router-dom"]);
}

export function verifyRuntimeContract(project, lock, audit, options = {}) {
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
  if (Number(vulnerabilities.critical ?? 0) > 0) failures.push("npm audit reports critical production vulnerabilities");
  if (Number(vulnerabilities.high ?? 0) > 0) {
    const exceptionActive = containsOnlyWaivedRouterFindings(audit, project, lock, options);
    if (!exceptionActive) {
      if (options.usesUnstableRscApi) failures.push("React Router RSC exception cannot apply when unstable RSC APIs are present");
      else if (new Date(options.now ?? Date.now()).getTime() > new Date(reactRouterRscExceptionExpiresAt).getTime()) {
        failures.push("React Router RSC exception expired");
      } else failures.push("npm audit reports high production vulnerabilities");
    }
  }
  return failures;
}

export function auditCompleted(status, report) {
  return Number.isInteger(status) && Boolean(report?.metadata?.vulnerabilities) && !report?.error;
}

async function usesUnstableReactRouterRscApi(root) {
  const sourceRoot = path.join(root, "src");
  const queue = [sourceRoot];
  const rscApi = /\b(?:unstable_)?RSC[A-Za-z]*\b|\b(?:createCallServer|createClientRoutes)\b/;
  while (queue.length) {
    const directory = queue.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && rscApi.test(await readFile(entryPath, "utf8"))) return true;
    }
  }
  return false;
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
  const failures = verifyRuntimeContract(project, lock, report, {
    now: new Date(),
    usesUnstableRscApi: await usesUnstableReactRouterRscApi(root)
  });
  if (!auditCompleted(audit.status, report) && failures.length === 0) failures.push("npm audit could not complete");
  if (failures.length) throw new Error(`Runtime verification failed: ${failures.join("; ")}`);
  console.log("Runtime dependency integrity and production vulnerability checks passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
