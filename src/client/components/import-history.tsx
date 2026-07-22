import type { ImportReport } from "../api/types";
import { formatBytes } from "./import-report";

export interface ImportHistoryProps {
  reports: ImportReport[];
  loading: boolean;
  error?: unknown;
  onRetry(): void;
}

const sourceLabels = {
  upload: "项目文件夹",
  git: "Git HTTPS",
  local: "服务器路径"
} as const;

const statusLabels = {
  succeeded: "成功",
  failed: "失败",
  running: "进行中",
  cancelled: "已取消"
} as const;

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function ImportHistory({ reports, loading, error, onRetry }: ImportHistoryProps) {
  return <section aria-labelledby="import-history-title">
    <div className="import-section-heading"><h2 id="import-history-title">最近导入</h2></div>
    {loading ? <p aria-live="polite">正在加载导入记录...</p> : error ? <div role="alert">
      <p>导入记录加载失败。</p>
      <button type="button" onClick={onRetry}>重试</button>
    </div> : reports.length === 0 ? <p>暂无导入记录</p> : <div className="import-history-overflow">
      <table aria-label="最近导入">
        <thead><tr><th>来源</th><th>时间</th><th>采集内容</th><th>自动忽略</th><th>状态</th></tr></thead>
        <tbody>{reports.map((report) => <tr key={report.id}>
          <td>{sourceLabels[report.sourceKind]}</td>
          <td>{formatTime(report.startedAt)}</td>
          <td>{report.collectedFileCount.toLocaleString("en-US")} 个文件 · {formatBytes(report.collectedTextBytes)}</td>
          <td>{report.ignored.total.toLocaleString("en-US")} 项</td>
          <td>{statusLabels[report.status]}{report.status === "failed" && report.failureCode ? <><br /><small>{report.failureCode}</small></> : null}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
