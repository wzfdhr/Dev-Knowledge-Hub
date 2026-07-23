import { describe, expect, test } from "vitest";

import type { FrontendIR } from "../../../shared/frontend-ir";
import type { FrontendProjectManifest } from "./project-manifest";
import { deriveFrontendProjectProfile } from "./project-profile";

const digest = "a".repeat(64);
const sourceRef = {
  snapshotId: "snapshot-1",
  path: "package.json",
  startLine: 1,
  endLine: 1,
  blobHash: "b".repeat(64)
};

const ir = {
  schemaVersion: 2,
  snapshotId: "snapshot-1",
  analyzerManifestDigest: digest,
  analyzerManifest: [],
  edges: [],
  entities: [{
    id: "c".repeat(64),
    schemaVersion: 2,
    kind: "workspace_package",
    name: "app",
    qualifiedName: "app",
    completeness: "complete",
    packageKey: "app",
    canonicalPath: "package.json",
    identity: { type: "named", semanticKey: "workspace_package:app" },
    facets: {},
    attributes: {
      packageManager: { state: "known", value: "npm" },
      version: { state: "known", value: "1.0.0" }
    },
    sourceRefs: [sourceRef],
    provenance: []
  }]
} as unknown as FrontendIR;

const manifest: FrontendProjectManifest = {
  workspace: null,
  packages: [{
    path: "package.json",
    root: "",
    name: "app",
    scripts: { test: "vitest" },
    dependencies: { react: "19.0.0", vite: "7.0.0" },
    exports: null,
    imports: null
  }],
  tsconfigs: [],
  ignoredPaths: []
};

describe("deriveFrontendProjectProfile", () => {
  test("records known and unknown constraints without inventing defaults", () => {
    const profile = deriveFrontendProjectProfile({
      ir,
      manifest,
      sourceProvenance: {
        schemaVersion: 1,
        kind: "git",
        gitCommitSha: "d".repeat(40),
        contentVersion: "e".repeat(40),
        ref: "origin/main",
        remoteIdentityDigest: digest
      }
    });

    expect(profile.framework).toEqual({
      state: "known",
      value: { name: "react", version: "19.0.0", supported: true }
    });
    expect(profile.formLibrary).toEqual({ state: "unknown", reason: "unresolved" });
    expect(profile.profileDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is deterministic when analyzer entities arrive in a different order", () => {
    const input = {
      ir,
      manifest,
      sourceProvenance: {
        schemaVersion: 1 as const,
        kind: "upload" as const,
        gitCommitSha: null,
        contentVersion: "e".repeat(40),
        ref: "upload" as const,
        attestation: "unverified" as const
      }
    };
    const first = deriveFrontendProjectProfile(input);
    const second = deriveFrontendProjectProfile({ ...input, ir: { ...ir, entities: [...ir.entities].reverse() } });

    expect(second).toEqual(first);
  });
});
