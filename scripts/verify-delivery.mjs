import { readFile, readdir } from "node:fs/promises";
import { parse } from "yaml";

const dockerfile = await readFile("Dockerfile", "utf8");
const compose = parse(await readFile("docker-compose.yml", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const ci = await readFile(".github/workflows/ci.yml", "utf8");
const envExample = await readFile(".env.example", "utf8");
const restoreDrill = await readFile("scripts/backup/devkh-restore-drill.sh", "utf8");
const backup = await readFile("scripts/backup/devkh-backup.sh", "utf8");
const rollout = await readFile("docs/operations/frontend-experience-kernel-rollout.md", "utf8");
const stagingEvidence = await readFile("docs/releases/frontend-experience-kernel-staging-evidence.md", "utf8");
const trialHandoff = await readFile("docs/operations/frontend-v1-trial.md", "utf8");
const migrations = (await readdir("drizzle")).filter((name) => /^003[5-8]_/.test(name)).sort();

const failures = [];
const requireValue = (condition, message) => { if (!condition) failures.push(message); };

requireValue((dockerfile.match(/^FROM node:22\.13-bookworm-slim/gm) ?? []).length >= 3, "Node 22.13 multi-stage image");
requireValue(dockerfile.includes("USER node"), "non-root runtime user");
requireValue(dockerfile.includes("HEALTHCHECK"), "image health check");
requireValue(!dockerfile.includes("ENV DEVKH_GIT_ASKPASS_PATH"), "no app-only environment in parser image");
requireValue(compose.services?.postgres?.image === "postgres:16-bookworm", "PostgreSQL 16 image");
requireValue(compose.services?.postgres?.healthcheck, "PostgreSQL health check");
requireValue(compose.services?.app?.depends_on?.postgres?.condition === "service_healthy", "healthy database dependency");
requireValue(compose.services?.app?.read_only === true, "read-only app filesystem");
const parser = compose.services?.parser;
requireValue(parser?.network_mode === "none", "parser has no network");
requireValue(parser?.read_only === true, "read-only parser filesystem");
requireValue(parser?.user === "node", "non-root parser user");
requireValue(parser?.cap_drop?.includes("ALL"), "parser drops all capabilities");
requireValue(parser?.security_opt?.includes("no-new-privileges:true"), "parser prevents privilege escalation");
requireValue(parser?.pids_limit === 64, "parser PID limit");
requireValue(parser?.mem_limit === "512m", "parser memory limit");
requireValue(parser?.cpus === 1, "parser CPU limit");
requireValue(parser?.healthcheck?.test?.join(" ")?.includes("isSocket"), "parser socket health check");
requireValue(
  JSON.stringify(parser?.environment ?? {}) === JSON.stringify({
    NODE_ENV: "production",
    DEVKH_PARSER_SOCKET_PATH: "/run/devkh-parser/parser.sock",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    NO_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    no_proxy: ""
  }),
  "parser environment allowlist"
);
requireValue((parser?.volumes ?? []).join(",") === "parser_runtime:/run/devkh-parser", "parser volume allowlist");
requireValue(dockerfile.includes("/var/lib/devkh/artifacts"), "artifact runtime directory");
requireValue(
  compose.services?.app?.volumes?.includes("artifact_data:/var/lib/devkh/artifacts"),
  "artifact storage mount"
);
requireValue(compose.services?.integration?.build?.target === "integration", "Compose integration test target");
requireValue(compose.services?.integration?.environment?.TEST_DATABASE_URL?.endsWith("/devkh_test"), "isolated Compose test database");
requireValue(compose.services?.integration?.environment?.TEST_DATABASE_URL !== compose.services?.app?.environment?.DATABASE_URL, "test database differs from app database");
requireValue(compose.services?.postgres?.volumes?.includes("./docker/postgres/init-test-db.sql:/docker-entrypoint-initdb.d/10-create-test-db.sql:ro"), "test database init script");
requireValue(compose.services?.e2e?.build?.target === "e2e", "Compose e2e test target");
requireValue(
  Object.keys(compose.volumes ?? {}).sort().join(",")
    === "artifact_data,caddy_config,caddy_data,parser_runtime,postgres_data,repository_mirrors,snapshot_data,uploaded_sources",
  "persistent volumes"
);
requireValue(JSON.stringify(migrations) === JSON.stringify([
  "0035_source_blobs_contract.sql",
  "0036_frontend_experience_source_provenance.sql",
  "0037_frontend_experience_contracts.sql",
  "0038_workspace_mcp_tokens.sql"
]), "frontend experience migration order");
requireValue(packageJson.scripts?.["evaluate:frontend-experience"]?.includes("--experience"),
  "frontend experience evaluation command");
requireValue(packageJson.scripts?.["test:backup"]?.includes("validate-experience-recovery.test.mjs"),
  "frontend experience recovery tests");
requireValue(packageJson.scripts?.["verify:frontend-experience-staging"]?.includes("benchmark-frontend-experience.mjs"),
  "frontend experience staging benchmark");
requireValue(ci.includes("npm run evaluate:frontend-experience")
  && ci.includes("artifacts/frontend-experience-evaluation.json"), "frontend experience CI quality gate");
requireValue(restoreDrill.includes("validate-experience-recovery.mjs")
  && restoreDrill.includes("experienceRecoveryValidated"), "frontend experience restore graph validation");
requireValue(backup.includes("SourceProvenance@1") && backup.includes("FrontendSolutionContext@1"),
  "frontend experience backup contract manifest");
requireValue(envExample.includes("DEVKH_WORKSPACE_SOLUTION_PLANNING=enabled")
  && envExample.includes("DEVKH_FRONTEND_EXPERIENCE_RECOMMENDATIONS=enabled"),
  "frontend experience rollback switches");
requireValue(rollout.includes("SOLUTION_PLANNING_DISABLED")
  && rollout.includes("不删除 `0036`–`0038` 表"), "frontend experience rollback preservation contract");
requireValue(stagingEvidence.includes("isolated-local-staging")
  && stagingEvidence.includes("生产访问：无")
  && stagingEvidence.includes("devkh_test")
  && stagingEvidence.includes("未连接")
  && stagingEvidence.includes("共享或生产数据库"), "isolated frontend experience staging evidence");
requireValue(["FK19", "FK20", "FK21", "FK22", "FK23"].every((name) => trialHandoff.includes(name)),
  "frontend V1 trial consumer handoff");

if (failures.length) throw new Error(`Delivery configuration failed: ${failures.join(", ")}`);
console.log("Dockerfile and Compose delivery contracts passed static verification.");
