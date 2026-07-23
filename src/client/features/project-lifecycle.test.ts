import { describe, expect, test } from "vitest";

import {
  canUseProjectPrimaryAction,
  deriveProjectLifecycle,
  projectPrimaryAction,
  type ProjectLifecycleInput,
  type ProjectLifecycleState
} from "./project-lifecycle";

const repository = {
  id: "repo-1",
  projectId: "project-1",
  kind: "upload" as const,
  name: "Storefront",
  defaultBranch: "upload"
};

const snapshot = {
  id: "snapshot-2",
  commitSha: "b".repeat(40),
  ref: "upload",
  commitTimestamp: "2026-07-22T08:00:00Z",
  fileCount: 24
};

const build = (status: ProjectLifecycleInput["latestBuild"] extends infer T
  ? T extends null ? never : T extends { status: infer S } ? S : never
  : never) => ({
  id: `build-${status}`,
  snapshotId: snapshot.id,
  commitSha: snapshot.commitSha,
  status,
  warnings: [],
  cancelRequested: false
});

describe("project lifecycle", () => {
  test.each<[ProjectLifecycleState, ProjectLifecycleInput]>([
    ["source-missing", { repository: null, latestSnapshot: null, latestBuild: null, currentRelease: null, releases: [] }],
    ["source-connected", { repository, latestSnapshot: null, latestBuild: null, currentRelease: null, releases: [] }],
    ["snapshot-ready", { repository, latestSnapshot: snapshot, latestBuild: null, currentRelease: null, releases: [] }],
    ["building", { repository, latestSnapshot: snapshot, latestBuild: build("synthesizing"), currentRelease: null, releases: [] }],
    ["review-ready", { repository, latestSnapshot: snapshot, latestBuild: build("ready"), currentRelease: null, releases: [] }],
    ["draft-review", {
      repository,
      latestSnapshot: snapshot,
      latestBuild: build("ready"),
      currentRelease: null,
      releases: [{ id: "release-draft", buildId: "build-ready", snapshotId: snapshot.id, version: "1.2.0", createdAt: "2026-07-22", publishedAt: null }]
    }],
    ["published", {
      repository,
      latestSnapshot: snapshot,
      latestBuild: build("published"),
      currentRelease: { id: "release-live", buildId: "build-published", snapshotId: snapshot.id, version: "1.1.0", createdAt: "2026-07-21", publishedAt: "2026-07-21" },
      releases: []
    }],
    ["failed", { repository, latestSnapshot: snapshot, latestBuild: build("failed"), currentRelease: null, releases: [] }]
  ])("derives %s", (expected, input) => {
    expect(deriveProjectLifecycle(input)).toBe(expected);
  });

  test("treats a newer snapshot as ready even when an older release is published", () => {
    const older = { ...snapshot, id: "snapshot-1" };
    expect(deriveProjectLifecycle({
      repository,
      latestSnapshot: snapshot,
      latestBuild: { ...build("published"), snapshotId: older.id },
      currentRelease: { id: "release-live", buildId: "build-published", snapshotId: older.id, version: "1.1.0", createdAt: "2026-07-21", publishedAt: "2026-07-21" },
      releases: []
    })).toBe("snapshot-ready");
  });

  test.each([
    ["source-missing", "接入资料", "sources"],
    ["source-connected", "创建快照", "production"],
    ["snapshot-ready", "开始构建", "production"],
    ["building", "查看进度", "production"],
    ["review-ready", "创建草稿并审核", "production"],
    ["draft-review", "发布版本", "knowledge/pages"],
    ["published", "查看知识资料", "knowledge/pages"],
    ["failed", "查看原因并重试", "production"]
  ] satisfies Array<[ProjectLifecycleState, string, string]>)(
    "maps %s to one primary action",
    (state, label, section) => {
      expect(projectPrimaryAction(state)).toMatchObject({ label, section });
    }
  );

  test("keeps production actions unavailable to readers", () => {
    expect(canUseProjectPrimaryAction(projectPrimaryAction("snapshot-ready"), "reader", "reader")).toBe(false);
    expect(canUseProjectPrimaryAction(projectPrimaryAction("draft-review"), "member", "member")).toBe(false);
    expect(canUseProjectPrimaryAction(projectPrimaryAction("draft-review"), "admin", "reader")).toBe(true);
    expect(canUseProjectPrimaryAction(projectPrimaryAction("published"), "reader", "reader")).toBe(true);
  });
});
