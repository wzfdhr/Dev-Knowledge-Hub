import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, Input, Modal, Tag } from "antd";
import { BookOpenCheck, Boxes, FolderPlus, Settings2, UploadCloud, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { ACTIVE_PROJECT_STORAGE_KEY, errorMessage, type ApiClient } from "../api/client";
import type { Project } from "../api/types";
import { ErrorState, Loading } from "../components/ui";

function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function formatIndexedText(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectsPage({ api }: { api: ApiClient }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ["workspace-overview"],
    queryFn: api.workspaceOverview ?? (async () => {
      const projectList = (await api.listProjects()).projects;
      const summaries = await Promise.all(projectList.map((project) => api.getProjectSummary(project.id)));
      return {
        projects: summaries,
        totals: {
          projects: summaries.length,
          connected: summaries.filter((item) => item.repository).length,
          published: summaries.filter((item) => item.currentRelease).length,
          members: Math.max(0, ...summaries.map((item) => item.memberCount))
        }
      };
    })
  });
  const projectList = projects.data?.projects ?? [];
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ name: string; slug: string }>();
  const activeProjectId = window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  const create = useMutation({
    mutationFn: api.createProject,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      form.resetFields();
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, result.project.id);
      navigate(`/projects/${result.project.id}/overview`);
    }
  });
  const openProject = (project: Project) => {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, project.id);
    navigate(`/projects/${project.id}/overview`);
  };
  if (projects.isLoading) return <Loading label="正在加载项目中心" />;
  if (projects.error) return <ErrorState message={errorMessage(projects.error)} retry={() => void projects.refetch()} />;

  const { totals = { projects: 0, connected: 0, published: 0, members: 0 } } = projects.data ?? {};

  return <div className="page projects-page">
    <header className="page-header"><div><p className="eyebrow">团队知识库</p><h1>项目中心</h1><p>选择项目后，仓库、构建、发布和知识查询都会切换到该项目。</p></div><Button type="primary" icon={<FolderPlus aria-hidden="true" />} onClick={() => setOpen(true)}>新建项目</Button></header>
    <section className="project-center-metrics" aria-label="团队项目概况">
      <div><Boxes aria-hidden="true" /><span><small>项目总数</small><strong>{totals.projects}</strong></span></div>
      <div><UploadCloud aria-hidden="true" /><span><small>已连接资料</small><strong>{totals.connected}</strong></span></div>
      <div><BookOpenCheck aria-hidden="true" /><span><small>已发布项目</small><strong>{totals.published}</strong></span></div>
      <div><Users aria-hidden="true" /><span><small>团队成员</small><strong>{totals.members}</strong></span></div>
    </section>
    <section className="project-directory">
      <header><div><h2>项目工作台</h2><p>从资料接入到知识发布的当前状态</p></div><Tag>{projectList.length} 个项目</Tag></header>
      <div className="project-directory-list">{projectList.map((summary) => <div className="project-directory-row" key={summary.project.id}><div className="project-name-cell"><span>{summary.project.name.slice(0, 1).toUpperCase()}</span><div><strong>{summary.project.name}</strong><small className="mono">{summary.project.slug}</small></div></div><div className="project-data-cell"><small>资料来源</small><strong>{summary.repository?.name ?? "尚未接入"}</strong></div><div className="project-data-cell"><small>最近导入</small><strong>{summary.latestSnapshot ? `${summary.latestSnapshot.fileCount ?? 0} 个文件` : "暂无快照"}</strong><span>{summary.latestSnapshot ? `已索引 ${formatIndexedText(summary.indexedTextBytes)}` : "等待资料接入"}</span></div><div className="project-data-cell project-release-cell"><small>当前发布</small>{summary.currentRelease ? <><Tag color="green">已发布</Tag><strong>{summary.currentRelease.version}</strong></> : <Tag>未发布</Tag>}</div><span className="project-member-count"><Users aria-hidden="true" />{summary.memberCount} 人</span><Button type={summary.project.id === activeProjectId ? "default" : "primary"} icon={<Settings2 aria-hidden="true" />} onClick={() => openProject(summary.project)}>进入项目</Button></div>)}</div>
    </section>
    <Modal title="新建团队项目" open={open} onCancel={() => setOpen(false)} onOk={() => void form.validateFields().then((values) => create.mutate(values))} okText="创建并进入" confirmLoading={create.isPending}>
      <Form form={form} layout="vertical" onValuesChange={(changed) => { if (changed.name && !form.isFieldTouched("slug")) form.setFieldValue("slug", slugFromName(changed.name)); }}>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true }]}><Input autoFocus /></Form.Item>
        <Form.Item name="slug" label="项目标识" rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9-]{0,79}$/ }]}><Input /></Form.Item>
      </Form>
      {create.error && <ErrorState message={errorMessage(create.error)} />}
    </Modal>
  </div>;
}
