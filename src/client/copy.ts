const labels: Record<string, string> = {
  queued: "排队中", syncing: "同步中", parsing: "解析中", synthesizing: "生成中",
  validating: "校验中", ready: "待审核", published: "已发布", failed: "失败",
  open: "待处理", acknowledged: "已确认", fixed: "已修复", dismissed: "已忽略",
  active: "有效", revoked: "已撤销", local: "本地路径", git: "Git HTTPS"
};

export const statusLabel = (value: string) => labels[value] ?? value;
export const repositoryKindLabel = (value: string) => labels[value] ?? value;
