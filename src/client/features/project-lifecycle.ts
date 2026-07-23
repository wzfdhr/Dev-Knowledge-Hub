import type { Build, ProjectSummary, Release, RepositoryStatus } from "../api/types";

export type ProjectLifecycleState =
  | "source-missing"
  | "source-connected"
  | "snapshot-ready"
  | "building"
  | "review-ready"
  | "draft-review"
  | "published"
  | "failed";

export type ProjectPrimaryActionKind =
  | "connect"
  | "create-snapshot"
  | "start-build"
  | "view-progress"
  | "create-draft"
  | "publish"
  | "view-knowledge"
  | "retry-build";

export interface ProjectPrimaryAction {
  kind: ProjectPrimaryActionKind;
  label: string;
  section: "sources" | "production" | "knowledge/pages";
  requiresWrite: boolean;
}

export interface ProjectLifecycleInput {
  repository: ProjectSummary["repository"];
  latestSnapshot: RepositoryStatus["latestSnapshot"];
  latestBuild: Build | null;
  currentRelease: Release | null;
  releases?: Release[];
}

const terminalStatuses = new Set<Build["status"]>(["ready", "published", "failed"]);

export function deriveProjectLifecycle(input: ProjectLifecycleInput): ProjectLifecycleState {
  if (!input.repository) return "source-missing";
  if (!input.latestSnapshot) return "source-connected";

  const build = input.latestBuild;
  if (build && !terminalStatuses.has(build.status)) return "building";
  if (build?.status === "failed") return "failed";

  const currentSnapshotId = input.latestSnapshot.id;
  if (!build || build.snapshotId !== currentSnapshotId) return "snapshot-ready";

  if (build.status === "ready") {
    const draft = input.releases?.find((release) =>
      release.buildId === build.id && !release.publishedAt
    );
    return draft ? "draft-review" : "review-ready";
  }

  if (input.currentRelease?.publishedAt && input.currentRelease.snapshotId === currentSnapshotId) {
    return "published";
  }

  return build.status === "published" ? "published" : "snapshot-ready";
}

const primaryActions: Record<ProjectLifecycleState, ProjectPrimaryAction> = {
  "source-missing": { kind: "connect", label: "接入资料", section: "sources", requiresWrite: true },
  "source-connected": { kind: "create-snapshot", label: "创建快照", section: "production", requiresWrite: true },
  "snapshot-ready": { kind: "start-build", label: "开始构建", section: "production", requiresWrite: true },
  building: { kind: "view-progress", label: "查看进度", section: "production", requiresWrite: false },
  "review-ready": { kind: "create-draft", label: "创建草稿并审核", section: "production", requiresWrite: true },
  "draft-review": { kind: "publish", label: "发布版本", section: "knowledge/pages", requiresWrite: true },
  published: { kind: "view-knowledge", label: "查看知识资料", section: "knowledge/pages", requiresWrite: false },
  failed: { kind: "retry-build", label: "查看原因并重试", section: "production", requiresWrite: true }
};

export function projectPrimaryAction(state: ProjectLifecycleState): ProjectPrimaryAction {
  return primaryActions[state];
}

type Role = "admin" | "member" | "reader" | undefined;

export function canUseProjectPrimaryAction(
  action: ProjectPrimaryAction,
  workspaceRole: Role,
  projectRole: Role
): boolean {
  if (!action.requiresWrite) return true;
  if (workspaceRole === "admin") return true;
  if (workspaceRole !== "member" || !["admin", "member"].includes(projectRole ?? "")) return false;
  return action.kind !== "publish" || projectRole === "admin";
}
