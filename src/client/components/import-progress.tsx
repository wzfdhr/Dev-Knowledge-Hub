import { Progress } from "antd";
import { Check, Circle } from "lucide-react";

import type { ImportPhase, ImportProgress as ImportProgressValue } from "../api/types";

const stages: Array<{ phase: ImportPhase; label: string }> = [
  { phase: "reading", label: "读取文件" },
  { phase: "filtering", label: "安全过滤" },
  { phase: "uploading", label: "文件夹直传" },
  { phase: "validating", label: "服务端校验" },
  { phase: "snapshot", label: "创建内容版本" }
];

function formatRate(bytesPerSecond?: number): string | null {
  if (!bytesPerSecond) return null;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatEta(seconds?: number): string | null {
  if (!seconds) return null;
  if (seconds < 60) return `约 ${seconds} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ImportProgress({
  progress,
}: {
  progress: ImportProgressValue | null;
}) {
  if (!progress || progress.status === "idle") {
    return <section className="import-progress-idle" aria-label="导入状态">
      <Circle aria-hidden="true" />
      <span><strong>选择资料来源后开始导入</strong>扫描、过滤和上传进度会显示在这里。</span>
    </section>;
  }

  const visualPhase = progress.phase === "packaging" ? "uploading" : progress.phase;
  const activeIndex = stages.findIndex((stage) => stage.phase === visualPhase);
  const rate = formatRate(progress?.bytesPerSecond);
  const eta = formatEta(progress?.estimatedSeconds);
  const transfer = progress.processedFiles !== undefined && progress.totalFiles !== undefined
    ? `${progress.processedFiles}/${progress.totalFiles} 个文件${
      progress.processedBytes !== undefined && progress.totalBytes !== undefined
        ? ` · ${formatBytes(progress.processedBytes)}/${formatBytes(progress.totalBytes)}`
        : ""
    }`
    : null;

  return <section className="import-progress-compact" aria-labelledby="import-progress-title" role={progress.status === "failed" ? "alert" : undefined}>
    <div className="import-section-heading">
      <div><p className="eyebrow">处理流程</p><h2 id="import-progress-title">导入进度</h2></div>
      <strong className="import-percent">{progress.percent}%</strong>
    </div>
    <Progress percent={progress.percent} showInfo={false} status={progress.status === "failed" ? "exception" : undefined} />
    <div className="import-stage-track" aria-label="导入阶段">
      {stages.map((stage, index) => {
        const active = activeIndex === index;
        const complete = activeIndex > index || (progress.status === "completed" && active);
        const state = active ? `当前步骤，${complete ? "已完成" : "进行中"}` : complete ? "已完成" : "待处理";
        return <span key={stage.phase} className={`import-stage${complete ? " complete" : ""}${active ? " active" : ""}`} aria-current={active ? "step" : undefined} aria-label={`${stage.label}，${state}`}>
          <span className="import-stage-icon" aria-hidden="true">{complete ? <Check /> : <Circle />}</span>
          <span className="import-stage-label">{stage.label}</span>
        </span>;
      })}
    </div>
    <div className="import-progress-meta" aria-live="polite">
      <span>{progress.detail ?? "正在处理导入内容。"}</span>
      {(transfer || rate || eta) && <span>{[transfer, rate, eta].filter(Boolean).join(" · ")}</span>}
    </div>
  </section>;
}
