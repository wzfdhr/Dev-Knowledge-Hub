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
  const tmpfs = inspect.HostConfig?.Tmpfs?.["/tmp"] ?? "";
  requireValue(
    Object.keys(inspect.HostConfig?.Tmpfs ?? {}).length === 1
      && tmpfs.split(",").includes("rw")
      && tmpfs.split(",").includes("noexec")
      && tmpfs.split(",").includes("nosuid")
      && /(?:^|,)size=(?:64m|67108864)(?:,|$)/.test(tmpfs),
    "single bounded writable noexec tmpfs"
  );
  const mounts = inspect.Mounts ?? [];
  requireValue(
    mounts.length === 1
      && mounts[0]?.Destination === "/run/devkh-parser"
      && mounts[0]?.Type === "volume"
      && mounts[0]?.RW === true
      && /(?:^|_)parser_runtime$/.test(mounts[0]?.Name ?? mounts[0]?.Source ?? ""),
    "writable parser socket volume only"
  );
  const environment = inspect.Config?.Env ?? [];
  const allowedEnvironment = new Set([
    "DEVKH_PARSER_SOCKET_PATH", "NODE_ENV", "NODE_VERSION", "PATH", "YARN_VERSION"
  ]);
  const clearedProxyEnvironment = new Set([
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"
  ]);
  const environmentAllowed = environment.every((entry) => {
    const [name, value = ""] = entry.split("=", 2);
    return allowedEnvironment.has(name) || (clearedProxyEnvironment.has(name) && value === "");
  });
  requireValue(
    environmentAllowed
      && [...allowedEnvironment].every((name) => environment.some((entry) => entry.startsWith(`${name}=`))),
    "parser environment allowlist"
  );
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
