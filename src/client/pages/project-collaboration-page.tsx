import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal, Select, Tag } from "antd";
import { Activity, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import { errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { ProjectMember, TeamMember } from "../api/types";
import { ProjectActivityItem } from "../components/project-activity";
import { Empty, ErrorState, Loading } from "../components/ui";
import { useProjectContext } from "../components/project-layout";
import { projectKeys } from "../hooks/use-domain";

const roleLabels: Record<TeamMember["role"], string> = {
  admin: "管理员",
  member: "成员",
  reader: "只读"
};

export function ProjectCollaborationPage({ api }: { api: ApiClient }) {
  const { projectId } = useProjectContext();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [userId, setUserId] = useState<string>();
  const [role, setRole] = useState<ProjectMember["role"]>("reader");
  const [editingMember, setEditingMember] = useState<ProjectMember>();
  const [removingMember, setRemovingMember] = useState<ProjectMember>();
  const query = useInfiniteQuery({
    queryKey: projectKeys.activity(projectId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listProjectActivity(projectId, {
      limit: LIST_PAGE_SIZE,
      offset: pageParam
    }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined
  });
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const available = useQuery({
    queryKey: ["project", projectId, "available-members"],
    queryFn: () => api.listAvailableProjectMembers(projectId),
    enabled: showAdd
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
  const addMember = useMutation({
    mutationFn: () => api.addProjectMember(projectId, { userId: userId!, role }),
    onSuccess: () => { setShowAdd(false); setUserId(undefined); setRole("reader"); invalidate(); }
  });
  const changeRole = useMutation({
    mutationFn: ({ memberId, nextRole }: { memberId: string; nextRole: ProjectMember["role"] }) =>
      api.updateProjectMemberRole(projectId, memberId, nextRole),
    onSuccess: () => { setEditingMember(undefined); invalidate(); }
  });
  const removeMember = useMutation({
    mutationFn: (memberId: string) => api.removeProjectMember(projectId, memberId),
    onSuccess: () => { setRemovingMember(undefined); invalidate(); }
  });

  if (query.isLoading) return <Loading label="正在加载团队协作信息" />;
  if (query.error) {
    return <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} />;
  }

  const pages = query.data?.pages ?? [];
  const members = pages[0]?.members ?? [];
  const activity = pages.flatMap((page) => page.activity);
  const current = session.data?.admin;
  const ownMembership = members.find((member) => member.id === current?.id);
  const canManage = current?.role === "admin" || ownMembership?.role === "admin";
  const candidates = (available.data?.members ?? []).filter((member) => !members.some((currentMember) => currentMember.id === member.id));
  const roleOptions = Object.entries(roleLabels).map(([value, label]) => ({ value, label }));

  return <div className="page project-collaboration-page">
    <header className="page-header">
      <div><p className="eyebrow">项目协作</p><h1>团队协作</h1><p>查看团队访问范围与该项目真实发生的操作记录。</p></div>
      <Tag color="blue" icon={<ShieldCheck aria-hidden="true" />}>项目权限</Tag>
    </header>
    <section className="admin-section member-section" aria-labelledby="members-heading">
      <header className="section-toolbar">
        <div><span className="section-title"><Users aria-hidden="true" /><h2 id="members-heading">项目成员</h2></span><small>{members.length} 人</small></div>
        {canManage && <Button type="primary" icon={<UserPlus aria-hidden="true" />} onClick={() => setShowAdd(true)}>添加成员</Button>}
      </header>
      {members.length === 0 ? <Empty>暂无项目成员</Empty> : <div className="member-list" role="table" aria-label="项目成员">
        <div className="member-list-heading" role="row">
          <div role="columnheader">成员</div><div role="columnheader">项目角色</div><div role="columnheader">加入时间</div>{canManage && <div role="columnheader">操作</div>}
        </div>
        {members.map((member) => <div className="member-row" role="row" key={member.id}>
          <div className="member-cell member-primary" role="cell"><span className="member-identity"><b>{member.email.slice(0, 1).toUpperCase()}</b><strong>{member.email}</strong></span></div>
          <div className="member-cell" role="cell"><Tag color={member.role === "admin" ? "blue" : member.role === "member" ? "green" : "default"}>{roleLabels[member.role]}</Tag></div>
          <div className="member-cell member-time" role="cell">{member.createdAt ? new Date(member.createdAt).toLocaleString("zh-CN") : "-"}</div>
          {canManage && <div className="member-cell member-table-actions" role="cell"><Button type="link" onClick={() => { setEditingMember(member); setRole(member.role); }}>调整角色</Button><Button type="link" danger onClick={() => setRemovingMember(member)}>移除</Button></div>}
        </div>)}
      </div>}
    </section>
    <section className="admin-section activity-section" aria-labelledby="activity-heading">
      <header className="section-toolbar">
        <div><span className="section-title"><Activity aria-hidden="true" /><h2 id="activity-heading">项目动态</h2></span><small>{pages[0]?.total ?? 0} 条记录</small></div>
      </header>
        {activity.length === 0 ? <Empty>该项目还没有活动记录</Empty> : <div className="activity-list">
          {activity.map((event) => <ProjectActivityItem event={event} key={event.id} />)}
        </div>}
        {query.hasNextPage && <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</Button>}
    </section>
    <Modal title="添加项目成员" open={showAdd} onCancel={() => setShowAdd(false)} onOk={() => void addMember.mutate()} okText="加入项目" okButtonProps={{ disabled: !userId, loading: addMember.isPending }}>
      <div className="member-dialog-fields">
        <label>工作区成员<Select aria-label="选择工作区成员" placeholder="选择工作区成员" value={userId} onChange={setUserId} options={candidates.map((member) => ({ value: member.id, label: member.email }))} loading={available.isLoading} /></label>
        <label>项目角色<Select aria-label="新成员项目角色" value={role} onChange={setRole} options={roleOptions} /></label>
      </div>
      {addMember.error && <ErrorState message={errorMessage(addMember.error)} />}
    </Modal>
    <Modal title="调整项目角色" open={Boolean(editingMember)} onCancel={() => setEditingMember(undefined)} onOk={() => editingMember && void changeRole.mutate({ memberId: editingMember.id, nextRole: role })} okText="保存" okButtonProps={{ loading: changeRole.isPending }}>
      <div className="member-dialog-fields"><label>项目角色<Select aria-label="调整后的项目角色" value={role} onChange={setRole} options={roleOptions} /></label></div>
      {changeRole.error && <ErrorState message={errorMessage(changeRole.error)} />}
    </Modal>
    <Modal title="移除项目成员" open={Boolean(removingMember)} onCancel={() => setRemovingMember(undefined)} onOk={() => removingMember && void removeMember.mutate(removingMember.id)} okText="移除" okButtonProps={{ danger: true, loading: removeMember.isPending }}>
      确认将 <strong>{removingMember?.email}</strong> 移出此项目？
      {removeMember.error && <ErrorState message={errorMessage(removeMember.error)} />}
    </Modal>
  </div>;
}
