import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { ArrowRight, BookOpen, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { api as defaultApi, ApiError, errorMessage, type ApiClient } from "./api/client";
import { AppShell } from "./components/app-shell";
import { ErrorState, Loading } from "./components/ui";
import { FeedbackPage } from "./pages/feedback-page";
import { KnowledgePage } from "./pages/knowledge-page";
import { MembersPage } from "./pages/members-page";
import { OverviewPage } from "./pages/overview-page";
import { SettingsPage } from "./pages/settings-page";

function AuthScreen({ mode, api, onAuthenticated, onSetup }: { mode: "setup" | "login"; api: ApiClient; onAuthenticated: (email: string) => void; onSetup: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => mode === "setup" ? api.setup({ email, password }) : api.login({ email, password }),
    onSuccess: (value) => mode === "setup" ? onSetup() : onAuthenticated((value as { admin: { email: string } }).admin.email)
  });
  return <main className="auth-screen"><section className="auth-panel"><div className="auth-brand"><div className="brand-mark large">DK</div><div><strong>Dev Knowledge Hub</strong><span>运营控制台</span></div></div><div className="auth-heading">{mode === "setup" ? <BookOpen aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}<p className="eyebrow">{mode === "setup" ? "首次运行" : "安全会话"}</p><h1>{mode === "setup" ? "创建管理员" : "登录"}</h1><p>{mode === "setup" ? "设置唯一管理员和默认工作区。" : "继续进行仓库知识运营。"}</p></div><form onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><label>邮箱<Input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>密码<Input.Password autoComplete={mode === "setup" ? "new-password" : "current-password"} minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} /><span>至少 12 个字符</span></label>{mutation.error && <ErrorState message={errorMessage(mutation.error)} />}<Button className="auth-submit" type="primary" htmlType="submit" loading={mutation.isPending} icon={<ArrowRight aria-hidden="true" />}>{mode === "setup" ? "创建工作区" : "登录"}</Button></form></section><aside className="auth-context"><p className="eyebrow">本地优先的知识库</p><h2>管理可信的仓库上下文。</h2><ul><li><span>01</span>连接不可变的仓库快照</li><li><span>02</span>在发布前审核带引用的知识</li><li><span>03</span>为智能体提供可撤销的范围化访问</li></ul></aside></main>;
}

export function App({ api = defaultApi }: { api?: ApiClient }) {
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, enabled: setup.isSuccess && !setup.data.setupRequired, retry: false });
  const [setupFinished, setSetupFinished] = useState(false);
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => { queryClient.clear(); window.location.assign("/"); } });
  if (setup.isLoading) return <div className="boot"><Loading label="正在启动控制台" /></div>;
  if (setup.error) return <div className="boot"><ErrorState message={errorMessage(setup.error)} retry={() => void setup.refetch()} /></div>;
  if (setup.data?.setupRequired && !setupFinished) return <AuthScreen mode="setup" api={api} onSetup={() => { setSetupFinished(true); void setup.refetch(); }} onAuthenticated={() => {}} />;
  if (session.isLoading) return <div className="boot"><Loading label="正在检查会话" /></div>;
  if (session.error instanceof ApiError && session.error.status === 401 || !session.data) return <AuthScreen mode="login" api={api} onSetup={() => {}} onAuthenticated={() => void session.refetch()} />;
  return <Routes><Route element={<AppShell email={session.data.admin.email} onLogout={() => logout.mutate()} />}><Route path="/projects" element={<OverviewPage api={api} />} /><Route path="/overview" element={<Navigate to="/projects" replace />} /><Route path="/knowledge" element={<KnowledgePage api={api} />} /><Route path="/feedback" element={<FeedbackPage api={api} />} /><Route path="/members" element={<MembersPage />} /><Route path="/settings" element={<SettingsPage api={api} />} /><Route path="*" element={<Navigate to="/projects" replace />} /></Route></Routes>;
}
