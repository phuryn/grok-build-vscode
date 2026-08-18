/** Pure view-model helpers for `grok mcp list --json`. */

export const MCP_GLOBAL_SCOPE_WARNING =
  "Enable or disable applies globally to every Grok session on this machine.";

export interface McpServerView {
  name: string;
  enabled: boolean;
  scope?: string;
  source?: string;
  status?: string;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  toolCount?: number;
  error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length ? strings : undefined;
}

function parseServer(value: unknown): McpServerView | undefined {
  const item = record(value);
  const name = text(item?.name);
  if (!item || !name) return undefined;
  const session = record(item.session);
  const tools = Array.isArray(session?.tools)
    ? session.tools
    : Array.isArray(item.tools) ? item.tools : undefined;
  return {
    name,
    enabled: typeof session?.enabled === "boolean"
      ? session.enabled
      : typeof item.enabled === "boolean" ? item.enabled : true,
    ...(text(item.scope) ? { scope: text(item.scope) } : {}),
    ...(text(item.source) ? { source: text(item.source) } : {}),
    ...(text(session?.status) || text(item.status)
      ? { status: text(session?.status) || text(item.status) }
      : {}),
    ...(text(item.type) || text(item.transport)
      ? { type: text(item.type) || text(item.transport) }
      : {}),
    ...(text(item.command) ? { command: text(item.command) } : {}),
    ...(stringArray(item.args) ? { args: stringArray(item.args) } : {}),
    ...(text(item.url) ? { url: text(item.url) } : {}),
    ...(tools ? { toolCount: tools.length } : {}),
    ...(text(session?.error) || text(item.error)
      ? { error: text(session?.error) || text(item.error) }
      : {}),
  };
}

/** Parse the CLI's array response, accepting a future `{ servers: [] }` wrapper. */
export function parseMcpCliList(stdout: string): McpServerView[] {
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  const list = Array.isArray(parsed) ? parsed : record(parsed)?.servers;
  if (!Array.isArray(list)) throw new Error("Unexpected response from grok mcp list --json");
  return list
    .map(parseServer)
    .filter((server): server is McpServerView => !!server)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function mcpServerDetail(server: McpServerView): string {
  const parts: string[] = [];
  if (server.scope) parts.push(server.scope);
  if (server.source && server.source !== "local") parts.push(server.source);
  if (server.status) parts.push(server.status);
  if (typeof server.toolCount === "number") {
    parts.push(`${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`);
  }
  if (server.url) parts.push(server.url);
  else if (server.command) parts.push([server.command, ...(server.args ?? [])].join(" "));
  if (server.error) parts.push(server.error);
  return parts.join(" · ");
}
