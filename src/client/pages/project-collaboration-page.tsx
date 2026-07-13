import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Tag } from "antd";
import { Activity, ShieldCheck, Users } from "lucide-react";

import { errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { TeamMember } from "../api/types";
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
  const query = useInfiniteQuery({
    queryKey: projectKeys.activity(projectId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listProjectActivity(projectId, {
      limit: LIST_PAGE_SIZE,
      offset: pageParam
    }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined
  });

  if (query.isLoading) return <Loading label="正在加载团队协作信息" />;
  if (query.error) {
    return <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} />;
  }

  const pages = query.data?.pages ?? [];
  const members = pages[0]?.members ?? [];
  const activity = pages.flatMap((page) => page.activity);

  return <div className="page project-collaboration-page">
    <header className="page-header">
      <div><p className="eyebrow">项目协作</p><h1>团队协作</h1><p>查看团队访问范围与该项目真实发生的操作记录。</p></div>
      <Tag color="blue" icon={<ShieldCheck aria-hidden="true" />}>工作区权限</Tag>
    </header>
    <div className="collaboration-grid">
      <section className="collaboration-panel member-roster">
        <header><span><Users aria-hidden="true" /><strong>团队成员</strong></span><small>{members.length} 人</small></header>
        <div className="roster-heading"><span>成员</span><span>团队角色</span></div>
        {members.length === 0 ? <Empty>暂无团队成员</Empty> : <div className="roster-list">
          {members.map((member) => <div key={member.id}>
            <span className="member-identity"><b>{member.email.slice(0, 1).toUpperCase()}</b><strong>{member.email}</strong></span>
            <Tag color={member.role === "admin" ? "blue" : member.role === "member" ? "green" : "default"}>{roleLabels[member.role]}</Tag>
          </div>)}
        </div>}
        <p className="collaboration-note">成员身份属于团队空间，当前可访问已发布的项目知识。</p>
      </section>
      <section className="collaboration-panel activity-stream">
        <header><span><Activity aria-hidden="true" /><strong>项目动态</strong></span><small>{pages[0]?.total ?? 0} 条记录</small></header>
        {activity.length === 0 ? <Empty>该项目还没有活动记录</Empty> : <div className="activity-list">
          {activity.map((event) => <ProjectActivityItem event={event} key={event.id} />)}
        </div>}
        {query.hasNextPage && <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</Button>}
      </section>
    </div>
  </div>;
}
