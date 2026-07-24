// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ImportSourceSwitcher, type ImportSourceKind } from "./import-source-switcher";

afterEach(cleanup);

function renderSwitcher(value: ImportSourceKind = "upload") {
  const props = {
    value,
    currentRepository: null,
    location: "",
    token: "",
    pending: false,
    onChange: vi.fn(),
    onLocationChange: vi.fn(),
    onTokenChange: vi.fn(),
    onChooseFolder: vi.fn(),
    onSubmitAlternative: vi.fn()
  };
  return { ...render(<ImportSourceSwitcher {...props} />), props };
}

describe("ImportSourceSwitcher", () => {
  test("switches source views without submitting a source", async () => {
    const user = userEvent.setup();
    const { props } = renderSwitcher();
    await user.click(screen.getByRole("radio", { name: "Git HTTPS" }).closest("label")!);
    expect(props.onChange).toHaveBeenCalledWith("git");
    expect(props.onSubmitAlternative).not.toHaveBeenCalled();
  });

  test("renders the folder action and safety contract", async () => {
    const user = userEvent.setup();
    const { props } = renderSwitcher("upload");
    expect(screen.getByText("本机预过滤")).toBeVisible();
    expect(screen.getByText("上传不会自动改变正式知识")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect(props.onChooseFolder).toHaveBeenCalledTimes(1);
  });

  test("renders Git credentials and submits only from the explicit button", async () => {
    const user = userEvent.setup();
    const { props } = renderSwitcher("git");
    expect(screen.getByLabelText("个人访问 Token（可选）")).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("HTTPS URL"), { target: { value: "https://github.com/acme/web.git" } });
    expect(props.onLocationChange).toHaveBeenLastCalledWith("https://github.com/acme/web.git");
    expect(props.onSubmitAlternative).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "连接 Git 仓库" }));
    expect(props.onSubmitAlternative).toHaveBeenCalledTimes(1);
  });

  test("shows the connected source with text, not color alone", () => {
    render(<ImportSourceSwitcher
      value="local"
      currentRepository={{ id: "r1", projectId: "p1", kind: "local", name: "Production source", path: "/srv/app", defaultBranch: "local" }}
      location="/srv/app"
      token=""
      pending={false}
      onChange={vi.fn()}
      onLocationChange={vi.fn()}
      onTokenChange={vi.fn()}
      onChooseFolder={vi.fn()}
      onSubmitAlternative={vi.fn()}
    />);
    expect(screen.getByText("当前来源：Production source")).toBeVisible();
    expect(screen.getByLabelText("服务器绝对路径")).toBeVisible();
  });
});
