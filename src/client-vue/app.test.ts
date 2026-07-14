// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.resetModules();
});

test("mounts the Vue shell and reads the server CSP nonce without a component library", async () => {
  document.head.innerHTML = '<meta name="devkh-csp-nonce" content="server-generated-nonce" />';
  document.body.innerHTML = '<div id="vue-root"></div>';

  await import("./main");

  expect(document.querySelector("#vue-root")).toHaveAttribute("data-csp-nonce", "present");
  expect(document.querySelector("#vue-root")).toHaveTextContent("Vue 控制台基线");
});
