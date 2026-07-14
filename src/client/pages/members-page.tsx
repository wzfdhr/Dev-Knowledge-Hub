import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, Input, Modal, Select, Tag, Tooltip } from "antd";
import { KeyRound, UserCheck, UserPlus, UserX } from "lucide-react";
import { useState } from "react";

import { errorMessage, type ApiClient } from "../api/client";
import type { TeamMember } from "../api/types";
import { Empty, ErrorState, Loading } from "../components/ui";

const roleLabel: Record<TeamMember["role"], string> = { admin: "管理员", member: "成员", reader: "只读" };

export function MembersPage({ api }: { api: ApiClient }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<TeamMember | null>(null);
  const members = useQuery({ queryKey: ["members"], queryFn: api.listMembers, retry: false });
  const create = useMutation({
    mutationFn: api.createMember,
    onSuccess: async () => { setOpen(false); await client.invalidateQueries({ queryKey: ["members"] }); }
  });
  const resetPassword = useMutation({
    mutationFn: ({ userId, password }: { userId: string; password: string }) => api.resetMemberPassword(userId, password),
    onSuccess: async () => { setPasswordTarget(null); await client.invalidateQueries({ queryKey: ["members"] }); }
  });
  const setDisabled = useMutation({
    mutationFn: ({ userId, disabled }: { userId: string; disabled: boolean }) => api.setMemberDisabled(userId, disabled),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["members"] }); }
  });
  return <div className="page members-page">
    <header className="page-header"><div><p className="eyebrow">工作区协作</p><h1>成员</h1><p>管理团队对项目知识、构建与发布的访问范围。</p></div><Button type="primary" icon={<UserPlus />} onClick={() => setOpen(true)}>添加成员</Button></header>
    {members.isLoading ? <Loading label="正在加载成员" /> : members.error ? <ErrorState message={errorMessage(members.error)} retry={() => void members.refetch()} /> : members.data?.members.length ? <div className="member-list workspace-member-list" role="table" aria-label="工作区成员">
      <div className="member-list-heading" role="row"><div role="columnheader">成员</div><div role="columnheader">角色</div><div role="columnheader">加入时间</div><div role="columnheader">操作</div></div>
      {members.data.members.map((member) => <div className="member-row" role="row" key={member.id}>
        <div className="member-cell member-primary" role="cell"><span className="member-identity"><b>{member.email.slice(0, 1).toUpperCase()}</b><strong>{member.email}</strong>{member.disabledAt && <Tag color="default">已禁用</Tag>}</span></div>
        <div className="member-cell" role="cell"><Tag color={member.role === "admin" ? "blue" : member.role === "member" ? "green" : "default"}>{roleLabel[member.role]}</Tag></div>
        <div className="member-cell member-time" role="cell">{member.createdAt ? new Date(member.createdAt).toLocaleString("zh-CN") : "-"}</div>
        <div className="member-cell member-actions" role="cell"><Tooltip title="重置密码"><Button type="text" aria-label={`重置 ${member.email} 的密码`} icon={<KeyRound size={16} />} onClick={() => setPasswordTarget(member)} /></Tooltip><Tooltip title={member.disabledAt ? "启用成员" : "禁用成员"}><Button type="text" danger={!member.disabledAt} aria-label={`${member.disabledAt ? "启用" : "禁用"} ${member.email}`} icon={member.disabledAt ? <UserCheck size={16} /> : <UserX size={16} />} loading={setDisabled.isPending && setDisabled.variables?.userId === member.id} onClick={() => setDisabled.mutate({ userId: member.id, disabled: !member.disabledAt })} /></Tooltip></div>
      </div>)}
    </div> : <Empty>暂无成员</Empty>}
    {open && <section className="panel"><h2>添加成员</h2><Form layout="vertical" onFinish={(value) => create.mutate(value)}><Form.Item label="邮箱" name="email" rules={[{ required: true, type: "email" }]}><Input /></Form.Item><Form.Item label="初始密码" name="password" rules={[{ required: true, min: 12 }]}><Input.Password /></Form.Item><Form.Item label="角色" name="role" initialValue="member"><Select options={Object.entries(roleLabel).map(([value, label]) => ({ value, label }))} /></Form.Item>{create.error && <ErrorState message={errorMessage(create.error)} />}<Button htmlType="submit" type="primary" loading={create.isPending}>创建成员</Button><Button onClick={() => setOpen(false)}>取消</Button></Form></section>}
    <Modal title="重置成员密码" open={Boolean(passwordTarget)} footer={null} onCancel={() => setPasswordTarget(null)} destroyOnHidden><Form layout="vertical" onFinish={({ password }) => passwordTarget && resetPassword.mutate({ userId: passwordTarget.id, password })}><Form.Item label="新密码" name="password" rules={[{ required: true, min: 12 }]}><Input.Password autoComplete="new-password" /></Form.Item>{resetPassword.error && <ErrorState message={errorMessage(resetPassword.error)} />}<div className="form-actions"><Button htmlType="submit" type="primary" loading={resetPassword.isPending}>确认重置</Button><Button onClick={() => setPasswordTarget(null)}>取消</Button></div></Form></Modal>
  </div>;
}
