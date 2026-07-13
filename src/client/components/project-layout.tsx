import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useLayoutEffect } from "react";
import { Navigate, NavLink, Outlet, useParams } from "react-router-dom";

import { ACTIVE_PROJECT_STORAGE_KEY, errorMessage, type ApiClient } from "../api/client";
import type { Project } from "../api/types";
import { ErrorState, Loading } from "./ui";

interface ProjectContextValue {
  project: Project;
  projectId: string;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

const sections = [
  ["overview", "项目概览"],
  ["imports", "资料上传"],
  ["versions", "知识版本"],
  ["collaboration", "团队协作"],
  ["codex", "Codex 接入"]
] as const;

export function useProjectContext(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("Project context is unavailable");
  return value;
}

export function ProjectLayout({ api }: { api: ApiClient }) {
  const { projectId = "" } = useParams();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const project = projects.data?.projects.find((item) => item.id === projectId && !item.archivedAt);

  useLayoutEffect(() => {
    if (project) localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, project.id);
  }, [project]);

  if (projects.isLoading) return <Loading label="正在加载项目" />;
  if (projects.error) return <ErrorState message={errorMessage(projects.error)} retry={() => void projects.refetch()} />;
  if (!project) return <Navigate to="/projects" replace />;

  return <ProjectContext.Provider value={{ project, projectId }}>
    <div className="project-workbench">
      <header className="project-bar">
        <div><p className="eyebrow">项目工作台</p><h1>{project.name}</h1></div>
        <div className="project-meta"><span>{project.slug}</span><span>团队知识持续更新</span></div>
      </header>
      <nav className="project-tabs" aria-label="项目导航">
        {sections.map(([path, label]) => <NavLink key={path} to={`/projects/${projectId}/${path}`}>{label}</NavLink>)}
      </nav>
      <Outlet />
    </div>
  </ProjectContext.Provider>;
}
