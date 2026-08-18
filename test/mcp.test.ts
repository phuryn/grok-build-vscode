import { describe, expect, it } from "vitest";
import { mcpServerDetail, parseMcpCliList } from "../src/mcp";

describe("MCP CLI catalog", () => {
  it("parses, sorts, and preserves display fields", () => {
    expect(parseMcpCliList(JSON.stringify([
      { name: "zeta", enabled: false, scope: "project", url: "https://mcp.example" },
      { name: "alpha", enabled: true, scope: "user", command: "npx", args: ["-y", "alpha-mcp"] },
    ]))).toEqual([
      { name: "alpha", enabled: true, scope: "user", command: "npx", args: ["-y", "alpha-mcp"] },
      { name: "zeta", enabled: false, scope: "project", url: "https://mcp.example" },
    ]);
  });

  it("accepts a wrapped response and ignores malformed rows", () => {
    expect(parseMcpCliList('{"servers":[null,{"enabled":true},{"name":"docs"}]}'))
      .toEqual([{ name: "docs", enabled: true }]);
  });

  it("rejects non-catalog JSON", () => {
    expect(() => parseMcpCliList("{}"))
      .toThrow("Unexpected response from grok mcp list --json");
  });

  it("builds a compact server subtitle", () => {
    expect(mcpServerDetail({
      name: "docs",
      enabled: true,
      scope: "user",
      status: "ready",
      command: "npx",
      args: ["docs-mcp"],
      toolCount: 2,
    })).toBe("user · ready · 2 tools · npx docs-mcp");
  });
});
