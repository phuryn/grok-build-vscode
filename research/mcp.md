# MCP settings GUI

The shared Settings surface owns the MCP catalog. Opening **MCP servers** posts
`listMcpServers`; the host executes `grok mcp list --json` without a visible
terminal and replies with a typed `mcpServers` frame. The renderer displays
scope, source, status, tool count, URL or stdio command when those fields exist.

Enable/disable posts `setMcpServerEnabled { name, enabled }`. The host invokes
`grok mcp enable|disable <name>` as an argument array (never shell text), then
re-lists so the CLI remains authoritative. These commands edit the user Grok
configuration and apply globally, which is stated at the top of the page.

The feature is host-local in both directions:

- `listMcpServers` and `setMcpServerEnabled` are rejected from remote clients.
- `mcpServers` is never mirrored to AFK Pilot.
- The host-local catalog row disappears from `visibleRows`, so the MCP category
  itself is absent remotely rather than rendering a control that cannot work.

The current GUI deliberately covers list, refresh, enable, and disable. Adding
or editing arbitrary transport credentials remains an advanced config-file/CLI
operation; the renderer never receives secrets from `config.toml`.
