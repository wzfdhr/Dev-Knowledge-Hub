import assert from "node:assert/strict";
import test from "node:test";

import { verifyParserContainer } from "./verify-parser-container.mjs";

function validInspect() {
  return {
    Config: {
      User: "node",
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NODE_VERSION=22.13.0",
        "YARN_VERSION=1.22.22",
        "NODE_ENV=production",
        "DEVKH_PARSER_SOCKET_PATH=/run/devkh-parser/parser.sock"
      ]
    },
    HostConfig: {
      NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 64, Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=67108864" }
    },
    Mounts: [{ Destination: "/run/devkh-parser", Type: "volume", RW: true, Name: "devkh-ci_parser_runtime" }]
  };
}

test("accepts the isolated parser runtime", () => {
  assert.doesNotThrow(() => verifyParserContainer(validInspect()));
});

test("permits Docker Desktop proxy variables only when Compose clears their values", () => {
  const inspect = validInspect();
  inspect.Config.Env.push("HTTP_PROXY=", "HTTPS_PROXY=", "NO_PROXY=", "http_proxy=", "https_proxy=", "no_proxy=");
  assert.doesNotThrow(() => verifyParserContainer(inspect));
  inspect.Config.Env[inspect.Config.Env.length - 1] = "no_proxy=host.docker.internal";
  assert.throws(() => verifyParserContainer(inspect), /parser environment allowlist/);
});

test("rejects network, credentials, and project mounts", () => {
  const inspect = validInspect();
  inspect.HostConfig.NetworkMode = "default";
  inspect.Config.Env.push("DATABASE_URL=postgres://secret");
  inspect.Mounts.push({ Destination: "/var/lib/devkh/snapshots" });
  assert.throws(() => verifyParserContainer(inspect), /network disabled.*writable parser socket volume only.*parser environment allowlist/);
});

test("rejects weak tmpfs and unexpected socket mount modes", () => {
  const inspect = validInspect();
  inspect.HostConfig.Tmpfs["/tmp"] = "rw,size=67108864";
  inspect.Mounts[0].RW = false;
  inspect.HostConfig.Tmpfs["/extra"] = "rw,size=1048576";
  assert.throws(() => verifyParserContainer(inspect), /single bounded writable noexec tmpfs.*writable parser socket volume only/);
});
