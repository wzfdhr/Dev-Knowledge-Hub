import assert from "node:assert/strict";
import test from "node:test";

import { verifyParserContainer } from "./verify-parser-container.mjs";

function validInspect() {
  return {
    Config: { User: "node", Env: ["NODE_ENV=production", "DEVKH_PARSER_SOCKET_PATH=/run/devkh-parser/parser.sock"] },
    HostConfig: {
      NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 64, Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, Tmpfs: { "/tmp": "rw,size=67108864" }
    },
    Mounts: [{ Destination: "/run/devkh-parser" }]
  };
}

test("accepts the isolated parser runtime", () => {
  assert.doesNotThrow(() => verifyParserContainer(validInspect()));
});

test("rejects network, credentials, and project mounts", () => {
  const inspect = validInspect();
  inspect.HostConfig.NetworkMode = "default";
  inspect.Config.Env.push("DATABASE_URL=postgres://secret");
  inspect.Mounts.push({ Destination: "/var/lib/devkh/snapshots" });
  assert.throws(() => verifyParserContainer(inspect), /network disabled.*socket-only mount.*no production credentials/);
});
