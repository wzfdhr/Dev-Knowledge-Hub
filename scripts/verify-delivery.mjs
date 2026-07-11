import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const dockerfile = await readFile("Dockerfile", "utf8");
const compose = parse(await readFile("docker-compose.yml", "utf8"));

const failures = [];
const requireValue = (condition, message) => { if (!condition) failures.push(message); };

requireValue((dockerfile.match(/^FROM node:22-bookworm-slim/gm) ?? []).length >= 3, "Node 22 multi-stage image");
requireValue(dockerfile.includes("USER node"), "non-root runtime user");
requireValue(dockerfile.includes("HEALTHCHECK"), "image health check");
requireValue(compose.services?.postgres?.image === "postgres:16-bookworm", "PostgreSQL 16 image");
requireValue(compose.services?.postgres?.healthcheck, "PostgreSQL health check");
requireValue(compose.services?.app?.depends_on?.postgres?.condition === "service_healthy", "healthy database dependency");
requireValue(compose.services?.app?.read_only === true, "read-only app filesystem");
requireValue(compose.services?.integration?.build?.target === "build", "Compose integration test target");
requireValue(compose.services?.e2e?.build?.target === "e2e", "Compose e2e test target");
requireValue(Object.keys(compose.volumes ?? {}).sort().join(",") === "postgres_data,repository_mirrors,snapshot_data", "persistent volumes");

if (failures.length) throw new Error(`Delivery configuration failed: ${failures.join(", ")}`);
console.log("Dockerfile and Compose delivery contracts passed static verification.");
