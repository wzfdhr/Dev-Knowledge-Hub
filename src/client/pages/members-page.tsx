import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, Input, Select, Table, Tag } from "antd";
import { UserPlus, Users } from "lucide-react";
import { useState } from "react";

import { errorMessage, type ApiClient } from "../api/client";
import type { TeamMember } from "../api/types";
import { ErrorState, Loading } from "../components/ui";

const roleLabel: Record<TeamMember["role"], string> = { admin: "管理员", member: "成员", reader: "只读" };

export function MembersPage({ api }: { api: ApiClient }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const members = useQuery({ queryKey: ["members"], queryFn: api.listMembers, retry: false });
  const create = useMutation({
    mutationFn: api.createMember,
    onSuccess: async () => { setOpen(false); await client.invalidateQueries({ queryKey: ["members"] }); }
  });
  return <div className="page members-page">
    <header className="page-header"><div><p className="eyebrow">工作区协作</p><h1>成员</h1><p>管理团队对项目知识、构建与发布的访问范围。</p></div><Button type="primary" icon={<UserPlus />} onClick={() => setOpen(true)}>添加成员</Button></header>
    {members.isLoading ? <Loading label="正在加载成员" /> : members.error ? <ErrorState message={errorMessage(members.error)} retry={() => void members.refetch()} /> : <Table<TeamMember> rowKey="id" dataSource={members.data?.members ?? []} pagination={false} columns={[
      { title: "成员", dataIndex: "email" },
      { title: "角色", dataIndex: "role", render: (role: TeamMember["role"]) => <Tag color={role === "admin" ? "blue" : role === "member" ? "green" : "default"}>{roleLabel[role]}</Tag> },
      { title: "加入时间", dataIndex: "createdAt", render: (value?: string) => value ? new Date(value).toLocaleString("zh-CN") : "-" }
    ]} locale={{ emptyText: <span><Users size={16} /> 暂无成员</span> }} />}
    {open && <section className="panel"><h2>添加成员</h2><Form layout="vertical" onFinish={(value) => create.mutate(value)}><Form.Item label="邮箱" name="email" rules={[{ required: true, type: "email" }]}><Input /></Form.Item><Form.Item label="初始密码" name="password" rules={[{ required: true, min: 12 }]}><Input.Password /></Form.Item><Form.Item label="角色" name="role" initialValue="member"><Select options={Object.entries(roleLabel).map(([value, label]) => ({ value, label }))} /></Form.Item>{create.error && <ErrorState message={errorMessage(create.error)} />}<Button htmlType="submit" type="primary" loading={create.isPending}>创建成员</Button><Button onClick={() => setOpen(false)}>取消</Button></Form></section>}
  </div>;
}
