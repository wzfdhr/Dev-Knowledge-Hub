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

export function ImportProgress({
  progress,
}: {
  progress: ImportProgressValue | null;
}) {
  const activeIndex = progress ? stages.findIndex((stage) => stage.phase === progress.phase) : -1;
  const rate = formatRate(progress?.bytesPerSecond);
  const eta = formatEta(progress?.estimatedSeconds);

  return <section className="import-progress-panel" aria-labelledby="import-progress-title">
    <div className="import-section-heading">
      <div><p className="eyebrow">处理流程</p><h2 id="import-progress-title">导入进度</h2></div>
      {progress && <strong className="import-percent">{progress.percent}%</strong>}
    </div>
    <div className="import-stage-list" aria-label="导入阶段">
      {stages.map((stage, index) => {
        const complete = progress?.status === "completed" || activeIndex > index;
        const active = activeIndex === index;
        return <div key={stage.phase} className={`import-stage${complete ? " complete" : active ? " active" : ""}`}>
          <span className="import-stage-icon" aria-hidden="true">{complete ? <Check /> : <Circle />}</span>
          <span className="import-stage-label">{stage.label}</span>
        </div>;
      })}
    </div>
    <Progress percent={progress?.percent ?? 0} showInfo={false} status={progress?.status === "failed" ? "exception" : undefined} />
    <div className="import-progress-meta" aria-live="polite">
      <span>{progress?.detail ?? "选择项目文件夹后，将在本机完成读取和过滤，仅上传可采集文件。"}</span>
      {(rate || eta) && <span>{[rate, eta].filter(Boolean).join(" · ")}</span>}
    </div>
  </section>;
}
