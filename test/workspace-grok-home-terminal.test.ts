import { afterEach, expect, it, vi } from "vitest";
import { configureWorkspaceGrokHome } from "../src/workspace-grok-home";

vi.mock("vscode", () => ({
  commands: { getCommands: vi.fn().mockResolvedValue([]) },
  window: { createTerminal: vi.fn(() => ({ show() {}, sendText() {}, dispose() {} })) },
}));
import * as vscode from "vscode";
import { createVsCodeHost } from "../src/vscode-host";

function configure(value: string) {
  configureWorkspaceGrokHome({ read: () => value, onChange: () => ({ dispose() {} }),
    warn() {}, prompt: async () => undefined, reload() {} }, {}, "linux", "/users/james");
}
afterEach(() => { configure(""); vi.clearAllMocks(); });

it.each([["login"], ["logout"]])("passes the latched home to the panel's %s terminal", (...args) => {
  configure("/accounts/james");
  const host = createVsCodeHost({} as vscode.OutputChannel);
  host.createTerminal({ name: "Grok account", shellPath: "grok", shellArgs: args });
  expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
    shellPath: "grok", shellArgs: args, env: { GROK_HOME: "/accounts/james" },
  }));
});

it("keeps the ordinary terminal environment when no setting is in use", () => {
  configure("");
  createVsCodeHost({} as vscode.OutputChannel).createTerminal({ name: "Grok Login", shellPath: "grok", shellArgs: ["login"] });
  expect(vscode.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ env: undefined }));
});
