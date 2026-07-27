import assert from "node:assert/strict";
import test from "node:test";

import { auditCompleted, verifyRuntimeContract } from "./verify-runtime.mjs";

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

test("accepts npm audit's vulnerability exit code only when a complete audit report exists", () => {
  assert.equal(auditCompleted(1, { metadata: { vulnerabilities: { high: 2 } } }), true);
  assert.equal(auditCompleted(1, { error: { code: "EAUDIT" } }), false);
  assert.equal(auditCompleted(null, { metadata: { vulnerabilities: {} } }), false);
});

test("allows only the temporary non-RSC React Router advisory chain", () => {
  const routerProject = {
    private: true,
    dependencies: { fastify: "5.10.0", "react-router-dom": "7.18.1" },
    devDependencies: { vite: "8.1.4" }
  };
  const routerLock = {
    lockfileVersion: 3,
    packages: {
      "node_modules/fastify": { version: "5.10.0", integrity: "sha512-fastify" },
      "node_modules/vite": { version: "8.1.4", integrity: "sha512-vite" },
      "node_modules/react-router": { version: "7.18.1", integrity: "sha512-router" },
      "node_modules/react-router-dom": { version: "7.18.1", integrity: "sha512-router-dom" }
    }
  };
  const rscAudit = {
    metadata: { vulnerabilities: { moderate: 2, high: 2, critical: 0 } },
    vulnerabilities: {
      "@modelcontextprotocol/sdk": { severity: "moderate", via: ["@hono/node-server"] },
      "react-router": {
        severity: "high",
        via: [{ url: "https://github.com/advisories/GHSA-qwww-vcr4-c8h2", severity: "high" }]
      },
      "react-router-dom": { severity: "high", via: ["react-router"] }
    }
  };
  const options = { now: new Date("2026-07-27T00:00:00.000Z"), usesUnstableRscApi: false };

  assert.deepEqual(verifyRuntimeContract(routerProject, routerLock, rscAudit, options), []);
  assert.match(
    verifyRuntimeContract(routerProject, routerLock, rscAudit, { ...options, usesUnstableRscApi: true })[0],
    /RSC/
  );
  assert.match(
    verifyRuntimeContract({ ...routerProject, devDependencies: {} }, routerLock, rscAudit, options)[0],
    /high/
  );
  assert.match(
    verifyRuntimeContract({
      ...routerProject,
      dependencies: { ...routerProject.dependencies, "@react-router/dev": "7.18.1" }
    }, {
      ...routerLock,
      packages: { ...routerLock.packages, "node_modules/@react-router/dev": { version: "7.18.1", integrity: "sha512-router-dev" } }
    }, rscAudit, options)[0], /high/);
  assert.match(
    verifyRuntimeContract(routerProject, routerLock, {
      ...rscAudit,
      metadata: { vulnerabilities: { high: 3, critical: 0 } },
      vulnerabilities: { ...rscAudit.vulnerabilities, "other-runtime-package": { severity: "high", via: [] } }
    }, options)[0],
    /high/
  );
  assert.match(
    verifyRuntimeContract(routerProject, routerLock, rscAudit, {
      ...options,
      now: new Date("2026-08-28T00:00:00.000Z")
    })[0],
    /expired/
  );
});
