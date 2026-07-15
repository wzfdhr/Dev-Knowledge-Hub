import assert from "node:assert/strict";
import test from "node:test";

import { verifyRuntimeContract } from "./verify-runtime.mjs";

const project = { private: true, dependencies: { fastify: "5.10.0" } };
const lock = { lockfileVersion: 3, packages: { "node_modules/fastify": { version: "5.10.0", integrity: "sha512-test" } } };

test("rejects runtime dependencies missing from the lockfile", () => {
  assert.deepEqual(verifyRuntimeContract(project, { ...lock, packages: {} }, { metadata: { vulnerabilities: {} } }), [
    "runtime dependency missing from lockfile: fastify"
  ]);
});

test("rejects high production audit findings and accepts a fully locked audit", () => {
  assert.match(verifyRuntimeContract(project, lock, { metadata: { vulnerabilities: { high: 1 } } })[0], /high/);
  assert.deepEqual(verifyRuntimeContract(project, lock, { metadata: { vulnerabilities: { high: 0, critical: 0 } } }), []);
});
