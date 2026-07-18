import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compose = ["compose", "-f", resolve(repositoryRoot, "docker-compose.yml")];

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
  { name: "knowledge-quality", command: npm, args: ["run", "evaluate:knowledge"] },
  { name: "e2e", command: npm, args: ["run", "test:e2e"] }
]);

export const CONTAINER_STEPS = Object.freeze([
  { name: "container-build", command: "docker", args: ["build", "--target", "runtime", "-t", "devkh:ci", repositoryRoot] },
  { name: "compose-config", command: "docker", args: [...compose, "config", "--quiet"] },
  { name: "compose-up", command: "docker", args: [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "120", "postgres", "parser", "app"] },
  { name: "parser-isolation", command: "node", args: [resolve(repositoryRoot, "scripts/security/verify-parser-container.mjs")] },
  {
    name: "application-health",
    command: "docker",
    args: [...compose, "exec", "-T", "app", "node", "-e",
      "fetch('http://127.0.0.1:3000/api/health').then(async(response)=>{console.log(await response.text());process.exit(response.ok?0:1)}).catch(()=>process.exit(1))"]
  },
  { name: "recovery-drill", command: "bash", args: [resolve(repositoryRoot, "scripts/backup/ci-recovery-drill.sh")] }
]);

const cleanupStep = {
  name: "compose-cleanup",
  command: "docker",
  args: [...compose, "down", "--volumes"]
};

function commandText(step) {
  return step.command ? [step.command, ...step.args].join(" ") : `GET ${step.healthUrl}`;
}

async function invalidateRecoveryEvidence(root, errorClass) {
  if (!root) return;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "recovery-verification-failed.json"), `${JSON.stringify({
    schemaVersion: 1,
    operation: errorClass === "container_verification_failed" ? "container-verification" : "restore-drill",
    result: "failed",
    errorClass,
    retentionPath: root,
    finishedAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });
}

async function finalizeRecoveryEvidence(root) {
  if (!root) throw new Error("RECOVERY_EVIDENCE_DIR is required to finalize container recovery evidence");
  const { readdir, rename } = await import("node:fs/promises");
  const entries = await readdir(root, { recursive: true });
  const pending = entries.filter((entry) => entry.endsWith(".json.pending"));
  if (pending.length !== 1) throw new Error(`Expected exactly one pending recovery evidence file, found ${pending.length}`);
  await rename(join(root, pending[0]), join(root, pending[0].slice(0, -".pending".length)));
}

export function parseReleaseScope(args) {
  if (args.length === 0) return "verify";
  const inline = args.find((arg) => arg.startsWith("--scope="));
  const value = inline?.slice("--scope=".length)
    ?? (args[0] === "--scope" ? args[1] : undefined);
  if (value === "verify" || value === "container" || value === "all") return value;
  throw new Error(`Unknown release verification scope: ${value ?? args.join(" ")}`);
}

export function assertContainerIsolation(env) {
  if (env.DEVKH_CONTAINER_SMOKE !== "true") {
    throw new Error("DEVKH_CONTAINER_SMOKE=true is required for destructive container verification");
  }
  const project = env.COMPOSE_PROJECT_NAME?.trim() ?? "";
  if (!/^devkh-ci(?:-[a-z0-9]+)*$/.test(project)) {
    throw new Error("Container verification requires a CI-only Compose project named devkh-ci or devkh-ci-<suffix>");
  }
}

function executeCommand(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { cwd: repositoryRoot, env: process.env, stdio: "inherit" });
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
        { cause: error, exitCode, stepName: step.name }
      );
    }
    logger.log(`[release] PASS ${step.name}`);
  }
}

export async function runContainerVerification(options = {}) {
  const env = options.env ?? process.env;
  const execute = options.execute ?? executeStep;
  const logger = options.logger ?? console;
  const invalidateEvidence = options.invalidateEvidence ?? invalidateRecoveryEvidence;

  assertContainerIsolation(env);
  let failure;
  try {
    await runReleaseSteps(CONTAINER_STEPS, { execute, logger });
  } catch (error) {
    failure = error;
  }

  if (failure) {
    logger.error("[release] container verification failed; retaining the isolated Compose state for diagnosis");
    if (failure.stepName !== "recovery-drill") {
      await invalidateEvidence(env.RECOVERY_EVIDENCE_DIR, "container_verification_failed");
    }
    throw failure;
  }

  try {
    await runReleaseSteps([cleanupStep], { execute, logger });
  } catch (cleanupError) {
    await invalidateEvidence(env.RECOVERY_EVIDENCE_DIR, "compose_cleanup_failed");
    failure = cleanupError;
  }
  if (failure) throw failure;
  if (env.RECOVERY_EVIDENCE_DEFER_FINALIZATION === "true") {
    await finalizeRecoveryEvidence(env.RECOVERY_EVIDENCE_DIR);
  }
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
