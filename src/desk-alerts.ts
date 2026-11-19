import type { PermissionRequest } from "./acp";
import { isMcpToolCall } from "./mcp-tool";
import { commandProgramsForGrant, type ShellDialect } from "./plan-gate";

export const DESK_ALERT_TITLES = {
  done: "Turn finished",
  error: "Turn failed",
  permission: "Permission needed",
  question: "Question needs an answer",
  plan: "Plan ready for review",
} as const;

export type DeskAlertKind = keyof typeof DESK_ALERT_TITLES;

export interface DeskAlert {
  kind: DeskAlertKind;
  title: string;
  body: string;
  open(): Promise<void>;
  approval?: { command: string; agent: string; approve(): boolean };
}

const DESK_APPROVAL_INPUT_KEYS = new Set([
  "command", "cwd", "description", "variant", "is_background", "run_in_background", "timeout",
]);

export const STALE_DESK_APPROVAL ="This request can no longer be approved from the alert.";

export function deskApprovalCommand(tool: PermissionRequest["toolCall"], dialect: ShellDialect): string | undefined {
  if (typeof tool?.kind !== "string" || tool.kind.toLowerCase() !== "execute" || isMcpToolCall(tool)
    || /^(mcp[._]|web[_ -]?fetch\b)/i.test(tool.title)) return undefined;
  const command: unknown = tool.rawInput?.command;
  if (tool.rawInput?.is_background === true || tool.rawInput?.run_in_background === true) return undefined;
  // A request can ask for more than running the command: network access, a
  // wider sandbox, or no sandbox. The toast shows only the command, so any
  // field it does not know gets Open.
  if (Object.keys(tool.rawInput ?? {}).some((key) => !DESK_APPROVAL_INPUT_KEYS.has(key))) return undefined;
  // Toasts collapse whitespace and can interpret links. Keep only commands
  // whose original text can be displayed directly, without shell operators.
  if (typeof command !== "string" || command.length > 120 || command !== command.trim()
    || /[^\x20-\x7e]| {2}|[;&|<>(){}$`%^\[\]]/.test(command)) return undefined;
  const programs = commandProgramsForGrant(command, dialect);
  if (programs?.length !== 1) return undefined;
  // An explicit shell wrapper can hide a second command grammar in its argv.
  if (/(?:^|[\\/])(?:bash|cmd|dash|fish|ksh|powershell|pwsh|sh|zsh)(?:\.exe)?$/i.test(programs[0])) return undefined;
  return command;
}
