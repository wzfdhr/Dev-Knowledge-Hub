import { createApp } from "vue";

import { cspNonceFromDocument } from "../client/csp-nonce";
import "./styles/tokens.css";

const root = document.querySelector<HTMLDivElement>("#vue-root");
if (!root) throw new Error("Missing Vue console root");

const cspNonce = cspNonceFromDocument(document);
if (cspNonce) root.dataset.cspNonce = "present";

createApp({
  template: `
    <main class="vue-console-shell" aria-labelledby="vue-console-title">
      <p class="vue-console-eyebrow">Dev Knowledge Hub</p>
      <h1 id="vue-console-title">Vue 控制台基线</h1>
      <p>Vue 与 React 入口并行运行，后续页面仅使用项目内组件与 CSS token。</p>
    </main>
  `
}).mount(root);
