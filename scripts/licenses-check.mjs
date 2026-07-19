import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const project = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const allowlist = JSON.parse(await readFile(path.join(root, "config/license-allowlist.json"), "utf8"));
const frontendVersions = JSON.parse(await readFile(path.join(root, "evaluation/frontend/versions.json"), "utf8"));

const dependencies = Object.entries(lock.packages ?? {})
  .filter(([location]) => location.startsWith("node_modules/"))
  .map(([location, manifest]) => ({
    name: location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length),
    version: manifest.version ?? "unknown",
    license: manifest.license ?? "MISSING"
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

if (process.argv.includes("--report")) {
  console.log("# Third-party dependency licenses\n");
  console.log("| Package | Version | License |\n| --- | --- | --- |");
  for (const dependency of dependencies) {
    console.log(`| ${dependency.name} | ${dependency.version} | ${dependency.license} |`);
  }
  process.exit(0);
}

const errors = [];
if (project.private !== true) errors.push("package.json must retain private: true");
if (project.license !== "UNLICENSED") errors.push("package.json must retain license: UNLICENSED");
const allowed = new Set(allowlist.allowedLicenses);
for (const dependency of dependencies) {
  if (!allowed.has(dependency.license)) {
    errors.push(`${dependency.name}@${dependency.version}: ${dependency.license}`);
  }
}
for (const [capability, parser] of Object.entries(frontendVersions.parsers ?? {})) {
  if (typeof parser === "string") continue;
  if (parser.status === "deferred" && typeof parser.target === "string" && typeof parser.reason === "string") continue;
  if (parser.status !== "approved" || typeof parser.package !== "string" || typeof parser.version !== "string") {
    errors.push(`frontend parser ${capability} must have an approved exact version`);
    continue;
  }
  const locked = lock.packages?.[`node_modules/${parser.package}`];
  if (!locked || locked.version !== parser.version) {
    errors.push(`frontend parser ${capability} expects ${parser.package}@${parser.version}`);
  }
  if (!project.dependencies || project.dependencies[parser.package] !== parser.version) {
    errors.push(`frontend parser ${parser.package} must be a direct exact dependency`);
  }
}

if (errors.length > 0) {
  console.error("License policy failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`License policy passed for ${dependencies.length} locked dependency entries.`);
