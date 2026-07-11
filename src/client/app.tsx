import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { api as defaultApi, ApiError, errorMessage, type ApiClient } from "./api/client";
import { AppShell } from "./components/app-shell";
import { ErrorState, Loading } from "./components/ui";
import { FeedbackPage } from "./pages/feedback-page";
import { KnowledgePage } from "./pages/knowledge-page";
import { OverviewPage } from "./pages/overview-page";
import { SettingsPage } from "./pages/settings-page";

function AuthScreen({ mode, api, onAuthenticated, onSetup }: { mode: "setup" | "login"; api: ApiClient; onAuthenticated: (email: string) => void; onSetup: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => mode === "setup" ? api.setup({ email, password }) : api.login({ email, password }),
    onSuccess: (value) => mode === "setup" ? onSetup() : onAuthenticated((value as { admin: { email: string } }).admin.email)
  });
  return <main className="auth-screen"><section className="auth-panel"><div className="auth-brand"><div className="brand-mark large">DK</div><div><strong>Dev Knowledge Hub</strong><span>Operations console</span></div></div><div className="auth-heading">{mode === "setup" ? <BookOpen aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}<p className="eyebrow">{mode === "setup" ? "First run" : "Secure session"}</p><h1>{mode === "setup" ? "Create the administrator" : "Sign in"}</h1><p>{mode === "setup" ? "Set up the single administrator and default workspace." : "Continue to repository knowledge operations."}</p></div><form onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete={mode === "setup" ? "new-password" : "current-password"} minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} /><span>At least 12 characters</span></label>{mutation.error && <ErrorState message={errorMessage(mutation.error)} />}<button className="button primary full" disabled={mutation.isPending}>{mutation.isPending ? "Working..." : mode === "setup" ? "Create workspace" : "Sign in"}<ArrowRight aria-hidden="true" /></button></form></section><aside className="auth-context"><p className="eyebrow">Local-first knowledge</p><h2>Operate trusted repository context.</h2><ul><li><span>01</span>Connect an immutable repository snapshot</li><li><span>02</span>Review cited knowledge before publishing</li><li><span>03</span>Give agents revocable, scoped access</li></ul></aside></main>;
}

export function App({ api = defaultApi }: { api?: ApiClient }) {
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, enabled: setup.isSuccess && !setup.data.setupRequired, retry: false });
  const [setupFinished, setSetupFinished] = useState(false);
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => { queryClient.clear(); window.location.assign("/"); } });
  if (setup.isLoading) return <div className="boot"><Loading label="Starting console" /></div>;
  if (setup.error) return <div className="boot"><ErrorState message={errorMessage(setup.error)} retry={() => void setup.refetch()} /></div>;
  if (setup.data?.setupRequired && !setupFinished) return <AuthScreen mode="setup" api={api} onSetup={() => { setSetupFinished(true); void setup.refetch(); }} onAuthenticated={() => {}} />;
  if (session.isLoading) return <div className="boot"><Loading label="Checking session" /></div>;
  if (session.error instanceof ApiError && session.error.status === 401 || !session.data) return <AuthScreen mode="login" api={api} onSetup={() => {}} onAuthenticated={() => void session.refetch()} />;
  return <Routes><Route element={<AppShell email={session.data.admin.email} onLogout={() => logout.mutate()} />}><Route path="/overview" element={<OverviewPage api={api} />} /><Route path="/knowledge" element={<KnowledgePage api={api} />} /><Route path="/feedback" element={<FeedbackPage api={api} />} /><Route path="/settings" element={<SettingsPage api={api} />} /><Route path="*" element={<Navigate to="/overview" replace />} /></Route></Routes>;
}
