import { BookOpen, LayoutDashboard, LogOut, MessageSquareText, PanelLeft, Settings, X } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { APP_NAME } from "../../shared/contracts";

const navigation = [
  { to: "/overview", label: "总览", icon: LayoutDashboard },
  { to: "/knowledge", label: "知识库", icon: BookOpen },
  { to: "/feedback", label: "反馈", icon: MessageSquareText },
  { to: "/settings", label: "设置", icon: Settings }
];

export function AppShell({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  return <div className="app-shell">
    <button className="mobile-menu icon-button" aria-label="打开导航" onClick={() => setOpen(true)}><PanelLeft aria-hidden="true" /></button>
    {open && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setOpen(false)} />}
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <header><div className="brand-mark">DK</div><div><strong>{APP_NAME}</strong><span>运营控制台</span></div><button className="icon-button sidebar-close" aria-label="关闭导航" onClick={() => setOpen(false)}><X aria-hidden="true" /></button></header>
      <nav aria-label="主导航">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => setOpen(false)}><Icon aria-hidden="true" />{label}</NavLink>)}</nav>
      <footer><div className="admin"><span>{email.slice(0, 1).toUpperCase()}</span><div><strong>管理员</strong><small>{email}</small></div></div><button className="icon-button" aria-label="退出登录" onClick={onLogout}><LogOut aria-hidden="true" /></button></footer>
    </aside>
    <div className="content"><Outlet /></div>
  </div>;
}
