import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const compose = ["compose", "-f", "docker-compose.yml"];

export const VERIFY_STEPS = Object.freeze([
  { name: "secrets", command: npm, args: ["run", "secrets:scan"] },
  { name: "licenses", command: npm, args: ["run", "licenses:check"] },
  { name: "runtime", command: npm, args: ["run", "runtime:verify"] },
  { name: "runtime-tests", command: npm, args: ["run", "test:runtime"] },
  { name: "backup-tests", command: npm, args: ["run", "test:backup"] },
  { name: "delivery", command: npm, args: ["run", "delivery:verify"] },
  { name: "typecheck", command: npm, args: ["run", "typecheck"] },
  { name: "lint", command: npm, args: ["run", "lint"] },
  { name: "unit", command: npm, args: ["test"] },
  { name: "postgres-integration", command: npm, args: ["run", "test:integration"] },
  { name: "build", command: npm, args: ["run", "build"] },
  { name: "acceptance", command: npm, args: ["run", "acceptance"] },
  { name: "e2e", command: npm, args: ["run", "test:e2e"] }
]);

export const CONTAINER_STEPS = Object.freeze([
  { name: "container-build", command: "docker", args: ["build", "--target", "runtime", "-t", "devkh:ci", "."] },
  { name: "compose-config", command: "docker", args: [...compose, "config", "--quiet"] },
  { name: "compose-up", command: "docker", args: [...compose, "up", "-d", "--build", "postgres", "app"] },
  { name: "application-health", healthUrl: "http://127.0.0.1:3000/api/health" },
  { name: "recovery-drill", command: "bash", args: ["scripts/backup/ci-recovery-drill.sh"] }
]);

const cleanupStep = {
  name: "compose-cleanup",
  command: "docker",
  args: [...compose, "down", "--volumes"]
};

function commandText(step) {
  return step.command ? [step.command, ...step.args].join(" ") : `GET ${step.healthUrl}`;
}

export function parseReleaseScope(args) {
  if (args.length === 0) return "all";
  const inline = args.find((arg) => arg.startsWith("--scope="));
  const value = inline?.slice("--scope=".length)
    ?? (args[0] === "--scope" ? args[1] : undefined);
  if (value === "verify" || value === "container" || value === "all") return value;
  throw new Error(`Unknown release verification scope: ${value ?? args.join(" ")}`);
}

function executeCommand(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { env: process.env, stdio: "inherit" });
    child.once("error", (error) => {
      error.exitCode = error.code === "ENOENT" ? 127 : 1;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(
        new Error(signal ? `terminated by ${signal}` : `exited with ${code ?? 1}`),
        { exitCode: code ?? 1 }
      ));
    });
  });
}

async function executeHealthCheck(step) {
  const port = process.env.DEVKH_PORT?.trim() || "3000";
  const url = new URL(step.healthUrl);
  url.port = port;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        process.stdout.write(`${await response.text()}\n`);
        return;
      }
    } catch {
      // The service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await executeCommand({
    name: "compose-logs",
    command: "docker",
    args: [...compose, "logs", "app"]
  }).catch(() => undefined);
  throw Object.assign(new Error("application health probe timed out"), { exitCode: 1 });
}

async function executeStep(step) {
  if (step.healthUrl) return executeHealthCheck(step);
  return executeCommand(step);
}

export async function runReleaseSteps(steps, options = {}) {
  const execute = options.execute ?? executeStep;
  const logger = options.logger ?? console;
  for (const step of steps) {
    logger.log(`[release] START ${step.name}: ${commandText(step)}`);
    try {
      await execute(step);
    } catch (error) {
      const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
      throw Object.assign(
        new Error(`${step.name} failed with exit code ${exitCode}: ${commandText(step)}`),
        { cause: error, exitCode }
      );
    }
    logger.log(`[release] PASS ${step.name}`);
  }
}

async function runContainerVerification() {
  let failure;
  try {
    await runReleaseSteps(CONTAINER_STEPS);
  } catch (error) {
    failure = error;
  }
  try {
    await runReleaseSteps([cleanupStep]);
  } catch (cleanupError) {
    if (!failure) failure = cleanupError;
    else console.error(cleanupError.message);
  }
  if (failure) throw failure;
}

export async function main(args = process.argv.slice(2)) {
  const scope = parseReleaseScope(args);
  if (scope === "verify" || scope === "all") await runReleaseSteps(VERIFY_STEPS);
  if (scope === "container" || scope === "all") await runContainerVerification();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
