import type { FolderImportReport } from "../api/folder-import";
import type { UploadSnapshotSummary } from "../api/types";

export const ignoredReasonLabel: Record<string, string> = {
  binary: "二进制文件",
  excluded_directory: "依赖或构建目录",
  file_too_large: "超过大小限制",
  generated: "生成文件",
  sensitive_file: "敏感文件",
  unsupported_extension: "不支持的文件类型"
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReasonList({ reasons }: { reasons: Record<string, number> }) {
  return <div className="import-reason-list">
    {Object.entries(reasons).map(([reason, count]) => <span key={reason}>{ignoredReasonLabel[reason] ?? reason}<strong>{count}</strong></span>)}
  </div>;
}

export function FolderFilterReport({ report }: { report: FolderImportReport }) {
  return <section className="import-report" aria-labelledby="filter-report-title">
    <div className="import-section-heading"><div><p className="eyebrow">本地预检</p><h2 id="filter-report-title">过滤报告</h2></div><span>原始目录不会上传</span></div>
    <dl className="import-metrics">
      <div><dt>扫描文件</dt><dd>{report.totalFiles}</dd></div>
      <div><dt>准备上传</dt><dd>{report.acceptedFiles.length}</dd></div>
      <div><dt>自动忽略</dt><dd>{report.ignored.total}</dd></div>
      <div><dt>上传大小</dt><dd>{formatBytes(report.acceptedBytes)}</dd></div>
    </dl>
    <ReasonList reasons={report.ignored.reasons} />
  </section>;
}

export function ImportResultReport({ upload }: { upload: UploadSnapshotSummary }) {
  return <section className="import-report import-result" aria-labelledby="import-result-title">
    <div className="import-section-heading"><div><p className="eyebrow">导入完成</p><h2 id="import-result-title">内容版本已就绪</h2></div><span className="mono">{upload.sourceVersion.slice(0, 12)}</span></div>
    <p>已采集 {upload.fileCount} 个文件；<strong>已忽略 {upload.ignored.total} 个文件</strong>。下一步可前往项目概览构建知识。</p>
    <ReasonList reasons={upload.ignored.reasons} />
  </section>;
}

