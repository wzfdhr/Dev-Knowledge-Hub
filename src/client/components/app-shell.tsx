import { Button, Drawer, Layout, Menu, type MenuProps } from "antd";
import { BookOpen, FolderKanban, LogOut, Menu as MenuIcon, MessageSquareText, Settings, Users } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { APP_NAME } from "../../shared/contracts";

const navigation = [
  { to: "/projects", label: "项目中心", icon: FolderKanban },
  { to: "/knowledge", label: "知识库", icon: BookOpen },
  { to: "/feedback", label: "反馈", icon: MessageSquareText },
  { to: "/members", label: "成员", icon: Users },
  { to: "/settings", label: "设置", icon: Settings }
];

export function AppShell({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const selectedKey = location.pathname.startsWith("/projects/") ? "/projects" : location.pathname;
  const menuItems: MenuProps["items"] = navigation.map(({ to, label, icon: Icon }) => ({
    key: to,
    icon: <Icon aria-hidden="true" />,
    label: <NavLink to={to} onClick={() => setOpen(false)}>{label}</NavLink>
  }));
  const navigationContent = <nav aria-label="主导航"><Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={menuItems} /></nav>;
  const account = <footer><div className="admin"><span>{email.slice(0, 1).toUpperCase()}</span><div><strong>管理员</strong><small>{email}</small></div></div><Button type="text" aria-label="退出登录" icon={<LogOut aria-hidden="true" />} onClick={onLogout} /></footer>;

  return <Layout className="app-shell">
    <Button className="mobile-menu" type="default" shape="circle" aria-label="打开导航" icon={<MenuIcon aria-hidden="true" />} onClick={() => setOpen(true)} />
    <Layout.Sider className="sidebar" width={244} theme="dark">
      <header><div className="brand-mark">DK</div><div><strong>{APP_NAME}</strong><span>运营控制台</span></div></header>
      {navigationContent}
      {account}
    </Layout.Sider>
    <Drawer className="mobile-navigation" title={APP_NAME} placement="left" width={244} open={open} onClose={() => setOpen(false)}>
      {navigationContent}
      {account}
    </Drawer>
    <Layout.Content className="content"><Outlet /></Layout.Content>
  </Layout>;
}
