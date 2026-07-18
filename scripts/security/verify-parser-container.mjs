import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function verifyParserContainer(inspect) {
  const failures = [];
  const requireValue = (condition, message) => { if (!condition) failures.push(message); };
  requireValue(inspect.Config?.User === "node", "non-root user");
  requireValue(inspect.HostConfig?.NetworkMode === "none", "network disabled");
  requireValue(inspect.HostConfig?.ReadonlyRootfs === true, "read-only root filesystem");
  requireValue(inspect.HostConfig?.CapDrop?.includes("ALL"), "all capabilities dropped");
  requireValue(inspect.HostConfig?.SecurityOpt?.includes("no-new-privileges:true"), "no-new-privileges");
  requireValue(inspect.HostConfig?.PidsLimit === 64, "PID limit");
  requireValue(inspect.HostConfig?.Memory === 512 * 1024 * 1024, "memory limit");
  requireValue(inspect.HostConfig?.NanoCpus === 1_000_000_000, "CPU limit");
  requireValue(Object.keys(inspect.HostConfig?.Tmpfs ?? {}).includes("/tmp"), "bounded tmpfs");
  const destinations = (inspect.Mounts ?? []).map((mount) => mount.Destination).sort();
  requireValue(destinations.join(",") === "/run/devkh-parser", "socket-only mount");
  const environment = (inspect.Config?.Env ?? []).join("\n");
  requireValue(!/DATABASE_URL|DEVKH_MASTER_KEY|DEVKH_SESSION_SECRET/.test(environment), "no production credentials");
  if (failures.length) throw new Error(`Parser container isolation failed: ${failures.join(", ")}`);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const compose = ["compose", "-f", path.join(root, "docker-compose.yml")];
  const containerId = execFileSync("docker", [...compose, "ps", "-q", "parser"], { encoding: "utf8" }).trim();
  if (!containerId) throw new Error("Parser container is not running");
  const inspect = JSON.parse(execFileSync("docker", ["inspect", containerId], { encoding: "utf8" }))[0];
  verifyParserContainer(inspect);
  console.log("Parser container runtime isolation passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
