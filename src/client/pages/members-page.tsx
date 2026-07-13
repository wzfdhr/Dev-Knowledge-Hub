import { Users } from "lucide-react";

import { Empty } from "../components/ui";

export function MembersPage() {
  return <div className="page members-page">
    <header className="page-header"><div><p className="eyebrow">工作区协作</p><h1>成员</h1><p>成员目录将在工作区成员接口可用后显示。</p></div></header>
    <section className="panel"><Empty><Users aria-hidden="true" /><span>当前没有可展示的成员数据。</span></Empty></section>
  </div>;
}
