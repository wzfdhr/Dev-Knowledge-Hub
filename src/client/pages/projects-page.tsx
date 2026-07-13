import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, Input, Modal, Table, Tag } from "antd";
import { BookOpenCheck, Boxes, FolderPlus, Settings2, UploadCloud, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { ACTIVE_PROJECT_STORAGE_KEY, errorMessage, type ApiClient } from "../api/client";
import type { Project, ProjectSummary } from "../api/types";
import { ErrorState, Loading } from "../components/ui";

function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function ProjectsPage({ api }: { api: ApiClient }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const projectList = projects.data?.projects ?? [];
  const summaries = useQueries({
    queries: projectList.map((project) => ({
      queryKey: ["projects", project.id, "summary"],
      queryFn: () => api.getProjectSummary(project.id),
      retry: false
    }))
  });
  const summaryByProject = new Map<string, ProjectSummary>();
  projectList.forEach((project, index) => {
    const summary = summaries[index]?.data;
    if (summary) summaryByProject.set(project.id, summary);
  });
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

  const publishedCount = summaries.filter((summary) => Boolean(summary.data?.currentRelease)).length;
  const connectedCount = summaries.filter((summary) => Boolean(summary.data?.repository)).length;
  const memberCount = summaries.reduce((maximum, summary) => Math.max(maximum, summary.data?.memberCount ?? 0), 0);

  return <div className="page projects-page">
    <header className="page-header"><div><p className="eyebrow">团队知识库</p><h1>项目中心</h1><p>选择项目后，仓库、构建、发布和知识查询都会切换到该项目。</p></div><Button type="primary" icon={<FolderPlus aria-hidden="true" />} onClick={() => setOpen(true)}>新建项目</Button></header>
    <section className="project-center-metrics" aria-label="团队项目概况">
      <div><Boxes aria-hidden="true" /><span><small>项目总数</small><strong>{projectList.length}</strong></span></div>
      <div><UploadCloud aria-hidden="true" /><span><small>已连接资料</small><strong>{connectedCount}</strong></span></div>
      <div><BookOpenCheck aria-hidden="true" /><span><small>已发布项目</small><strong>{publishedCount}</strong></span></div>
      <div><Users aria-hidden="true" /><span><small>团队成员</small><strong>{memberCount}</strong></span></div>
    </section>
    <section className="project-directory">
      <header><div><h2>项目工作台</h2><p>从资料接入到知识发布的当前状态</p></div><Tag>{projectList.length} 个项目</Tag></header>
      <Table<Project> rowKey="id" pagination={false} dataSource={projectList} scroll={{ x: 960 }} columns={[
        { title: "项目", width: 230, render: (_, project) => <div className="project-name-cell"><span>{project.name.slice(0, 1).toUpperCase()}</span><div><strong>{project.name}</strong><small className="mono">{project.slug}</small></div></div> },
        { title: "资料来源", width: 170, render: (_, project) => { const summary = summaryByProject.get(project.id); return summary?.repository ? <div className="project-data-cell"><strong>{summary.repository.name}</strong><small>{summary.repository.kind === "upload" ? "文件上传" : summary.repository.kind === "git" ? "Git 仓库" : "服务器路径"}</small></div> : <span className="muted">尚未接入</span>; } },
        { title: "最近导入", width: 180, render: (_, project) => { const snapshot = summaryByProject.get(project.id)?.latestSnapshot; return snapshot ? <div className="project-data-cell"><strong>{new Date(snapshot.commitTimestamp).toLocaleDateString("zh-CN")}</strong><small>{snapshot.fileCount ?? 0} 个文件</small></div> : <span className="muted">暂无快照</span>; } },
        { title: "当前发布", width: 140, render: (_, project) => { const release = summaryByProject.get(project.id)?.currentRelease; return release ? <div className="project-release-cell"><Tag color="green">已发布</Tag><strong>{release.version}</strong></div> : <Tag>未发布</Tag>; } },
        { title: "运行状态", width: 130, render: (_, project) => { const build = summaryByProject.get(project.id)?.latestBuild; return <Tag color={build?.status === "failed" ? "red" : build?.status === "published" || build?.status === "ready" ? "green" : build ? "blue" : "default"}>{build?.status === "failed" ? "构建失败" : build?.status === "published" ? "已发布" : build?.status === "ready" ? "待发布" : build ? "处理中" : "未构建"}</Tag>; } },
        { title: "成员", width: 90, render: (_, project) => <span className="project-member-count"><Users aria-hidden="true" />{summaryByProject.get(project.id)?.memberCount ?? 0} 人</span> },
        { title: "操作", width: 130, fixed: "right", align: "right", render: (_, project) => <Button type={project.id === activeProjectId ? "default" : "primary"} icon={<Settings2 aria-hidden="true" />} onClick={() => openProject(project)}>{project.id === activeProjectId ? "打开" : "切换"}</Button> }
      ]} />
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
