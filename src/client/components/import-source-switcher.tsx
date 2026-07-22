import { Alert, Button, Segmented } from "antd";
import { FolderOpen, GitBranch, HardDriveUpload, Server } from "lucide-react";

import type { Repository } from "../api/types";

export type ImportSourceKind = Repository["kind"];

export interface ImportSourceSwitcherProps {
  value: ImportSourceKind;
  currentRepository: Repository | null;
  location: string;
  token: string;
  pending: boolean;
  errorMessage?: string;
  onChange(value: ImportSourceKind): void;
  onLocationChange(value: string): void;
  onTokenChange(value: string): void;
  onChooseFolder(): void;
  onSubmitAlternative(): void;
}

const options = [
  { value: "upload", label: <span className="ant-segmented-item-label">项目文件夹</span>, icon: <HardDriveUpload aria-hidden="true" /> },
  { value: "git", label: <span className="ant-segmented-item-label">Git HTTPS</span>, icon: <GitBranch aria-hidden="true" /> },
  { value: "local", label: <span className="ant-segmented-item-label">服务器路径</span>, icon: <Server aria-hidden="true" /> }
];

export function ImportSourceSwitcher({
  value,
  currentRepository,
  location,
  token,
  pending,
  errorMessage,
  onChange,
  onLocationChange,
  onTokenChange,
  onChooseFolder,
  onSubmitAlternative
}: ImportSourceSwitcherProps) {
  const submitLabel = value === "git" ? "连接 Git 仓库" : "连接服务器目录";

  return <section className="import-source-switcher">
    <div className="import-source-toolbar">
      <Segmented block value={value} options={options} onChange={(nextValue) => onChange(nextValue as ImportSourceKind)} />
      <span className="import-current-source">当前来源：{currentRepository?.name ?? "尚未连接"}</span>
    </div>
    <div className="import-source-panel">
      {value === "upload" ? <section className="import-folder-action">
        <FolderOpen aria-hidden="true" />
        <p>选择完整项目文件夹，自动过滤并生成内容版本。</p>
        <Button type="primary" size="large" icon={<FolderOpen aria-hidden="true" />} onClick={onChooseFolder}>选择项目文件夹</Button>
        <div className="import-safety-strip" aria-label="上传安全边界">
          <span><strong>本机预过滤</strong>敏感内容不离开电脑</span>
          <span><strong>50,000 个文件</strong>单次源码上限</span>
          <span><strong>2 GiB</strong>可采集源码上限</span>
          <span><strong>手动发布</strong>上传不会自动改变正式知识</span>
        </div>
      </section> : <form className="form-stack import-source-form" onSubmit={(event) => { event.preventDefault(); onSubmitAlternative(); }}>
        <label htmlFor="import-source-location">{value === "git" ? "HTTPS URL" : "服务器绝对路径"}
          <input id="import-source-location" type={value === "git" ? "url" : "text"} value={location} onChange={(event) => onLocationChange(event.target.value)} placeholder={value === "git" ? "https://github.com/org/repo.git" : "/srv/projects/example"} />
        </label>
        {value === "git" && <label htmlFor="import-source-token">个人访问 Token<span>（可选）</span>
          <input id="import-source-token" type="password" autoComplete="off" value={token} onChange={(event) => onTokenChange(event.target.value)} />
        </label>}
        {errorMessage && <Alert type="error" showIcon message={errorMessage} />}
        <Button type="primary" htmlType="submit" loading={pending}>{submitLabel}</Button>
      </form>}
    </div>
  </section>;
}
