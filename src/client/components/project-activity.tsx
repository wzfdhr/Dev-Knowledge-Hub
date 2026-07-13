import {
  CircleDot,
  FolderSync,
  KeyRound,
  PackageCheck,
  PackageX,
  Rocket,
  UserRoundPlus
} from "lucide-react";

import type { ProjectActivity as ProjectActivityRecord } from "../api/types";

const actionLabels: Record<string, string> = {
  "project.created": "创建了项目",
  "repository.connected": "连接了资料来源",
  "repository.switched": "更换了资料来源",
  "repository.sync_succeeded": "资料同步成功",
  "repository.sync_failed": "资料同步失败",
  "snapshot.created": "创建了源码快照",
  "upload.imported": "导入了项目资料",
  "mcp_token.created": "创建了 Codex Token",
  "mcp_token.revoked": "撤销了 Codex Token",
  "release.published": "发布了知识版本",
  "member.created": "添加了团队成员"
};

function ActivityIcon({ action }: { action: string }) {
  if (action === "repository.sync_succeeded") return <PackageCheck aria-hidden="true" />;
  if (action === "repository.sync_failed") return <PackageX aria-hidden="true" />;
  if (action.startsWith("repository.") || action === "upload.imported") return <FolderSync aria-hidden="true" />;
  if (action.startsWith("mcp_token.")) return <KeyRound aria-hidden="true" />;
  if (action.startsWith("release.")) return <Rocket aria-hidden="true" />;
  if (action === "member.created") return <UserRoundPlus aria-hidden="true" />;
  return <CircleDot aria-hidden="true" />;
}

export function ProjectActivityItem({ event }: { event: ProjectActivityRecord }) {
  const label = actionLabels[event.action] ?? "更新了项目";
  const actor = event.actorEmail ?? "系统";
  return <article className="project-activity-item">
    <span className="activity-icon"><ActivityIcon action={event.action} /></span>
    <div>
      <strong>{label}</strong>
      <small>{actor} · {new Date(event.createdAt).toLocaleString("zh-CN")}</small>
    </div>
  </article>;
}
