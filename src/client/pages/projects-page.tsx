import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, Input, Modal, Table, Tag } from "antd";
import { FolderPlus, Settings2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { ACTIVE_PROJECT_STORAGE_KEY, errorMessage, type ApiClient } from "../api/client";
import type { Project } from "../api/types";
import { ErrorState, Loading } from "../components/ui";

function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function ProjectsPage({ api }: { api: ApiClient }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
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
      navigate("/overview");
    }
  });
  const openProject = (project: Project) => {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, project.id);
    navigate("/overview");
  };
  if (projects.isLoading) return <Loading label="正在加载项目中心" />;
  if (projects.error) return <ErrorState message={errorMessage(projects.error)} retry={() => void projects.refetch()} />;

  return <div className="page">
    <header className="page-header"><div><p className="eyebrow">团队知识库</p><h1>项目中心</h1><p>选择项目后，仓库、构建、发布和知识查询都会切换到该项目。</p></div><Button type="primary" icon={<FolderPlus aria-hidden="true" />} onClick={() => setOpen(true)}>新建项目</Button></header>
    <Table<Project> rowKey="id" pagination={false} dataSource={projects.data?.projects ?? []} columns={[
      { title: "项目", render: (_, project) => <div><strong>{project.name}</strong><div className="muted mono">{project.slug}</div></div> },
      { title: "状态", render: (_, project) => <Tag color={project.id === activeProjectId ? "blue" : "default"}>{project.id === activeProjectId ? "当前项目" : "可切换"}</Tag> },
      { title: "操作", align: "right", render: (_, project) => <Button type={project.id === activeProjectId ? "default" : "primary"} icon={<Settings2 aria-hidden="true" />} onClick={() => openProject(project)}>{project.id === activeProjectId ? "打开工作台" : "切换项目"}</Button> }
    ]} />
    <Modal title="新建团队项目" open={open} onCancel={() => setOpen(false)} onOk={() => void form.validateFields().then((values) => create.mutate(values))} okText="创建并进入" confirmLoading={create.isPending}>
      <Form form={form} layout="vertical" onValuesChange={(changed) => { if (changed.name && !form.isFieldTouched("slug")) form.setFieldValue("slug", slugFromName(changed.name)); }}>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true }]}><Input autoFocus /></Form.Item>
        <Form.Item name="slug" label="项目标识" rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9-]{0,79}$/ }]}><Input /></Form.Item>
      </Form>
      {create.error && <ErrorState message={errorMessage(create.error)} />}
    </Modal>
  </div>;
}
