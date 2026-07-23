import { useQuery } from "@tanstack/react-query";
import { Button, Drawer } from "antd";
import { BookOpenText, FileInput, LayoutDashboard, Menu, Settings2, Workflow } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useParams } from "react-router-dom";

import { ACTIVE_PROJECT_STORAGE_KEY, errorMessage, type ApiClient } from "../api/client";
import type { Project } from "../api/types";
import { ErrorState, Loading } from "./ui";

interface ProjectContextValue {
  project: Project;
  projectId: string;
  workspaceRole?: "admin" | "member" | "reader";
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

const sections = [
  ["overview", "项目概览", LayoutDashboard],
  ["sources", "资料接入", FileInput],
  ["production", "知识生产", Workflow],
  ["knowledge/pages", "知识资料", BookOpenText],
  ["settings/team", "项目设置", Settings2]
] as const;

const knowledgeSections = [
  ["knowledge/pages", "页面"],
  ["knowledge/quality", "质量"],
  ["knowledge/graph", "图谱"],
  ["knowledge/frontend", "前端地图"]
] as const;

const settingsSections = [
  ["settings/team", "团队协作"],
  ["settings/codex", "Codex 接入"]
] as const;

export function useProjectContext(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("Project context is unavailable");
  return value;
}

export function ProjectLayout({ api, workspaceRole }: { api: ApiClient; workspaceRole?: "admin" | "member" | "reader" }) {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const project = projects.data?.projects.find((item) => item.id === projectId && !item.archivedAt);

  useLayoutEffect(() => {
    if (project) localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, project.id);
  }, [project]);

  if (projects.isLoading) return <Loading label="正在加载项目" />;
  if (projects.error) return <ErrorState message={errorMessage(projects.error)} retry={() => void projects.refetch()} />;
  if (!project) return <Navigate to="/projects" replace />;

  const isSectionActive = (path: string) => {
    if (path === "knowledge/pages") return location.pathname.includes("/knowledge/");
    if (path === "settings/team") return location.pathname.includes("/settings/");
    return location.pathname.endsWith(`/${path}`);
  };
  const projectNavigation = <nav className="project-tabs" aria-label="项目导航">
    {sections.map(([path, label, Icon]) => <NavLink
      className={isSectionActive(path) ? "active" : undefined}
      key={path}
      onClick={() => setNavigationOpen(false)}
      to={`/projects/${projectId}/${path}`}
    ><Icon aria-hidden="true" /><span>{label}</span></NavLink>)}
  </nav>;
  const secondarySections = location.pathname.includes("/knowledge/")
    ? knowledgeSections.filter(([path]) => path !== "knowledge/frontend" || workspaceRole === "admin")
    : location.pathname.includes("/settings/") ? settingsSections : null;

  return <ProjectContext.Provider value={{ project, projectId, workspaceRole }}>
    <div className="project-workbench">
      <header className="project-bar">
        <div><span className="project-context-label">当前项目</span><strong className="project-name">{project.name}</strong></div>
        <div className="project-meta"><span>{project.slug}</span><span>团队知识持续更新</span></div>
      </header>
      <Button className="project-navigation-trigger" icon={<Menu aria-hidden="true" />} onClick={() => setNavigationOpen(true)}>项目导航</Button>
      <div className="project-navigation-desktop">{projectNavigation}</div>
      <Drawer className="project-navigation-drawer" title={`${project.name} · 项目导航`} placement="left" width={280} open={navigationOpen} onClose={() => setNavigationOpen(false)}>
        {projectNavigation}
      </Drawer>
      {secondarySections && <nav className="project-subnav" aria-label={location.pathname.includes("/knowledge/") ? "知识资料导航" : "项目设置导航"}>
        {secondarySections.map(([path, label]) => <NavLink key={path} to={`/projects/${projectId}/${path}`}>{label}</NavLink>)}
      </nav>}
      <Outlet />
    </div>
  </ProjectContext.Provider>;
}
