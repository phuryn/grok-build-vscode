// DOM tests for the v1.4.20 tool-call summary simplification, driving the REAL
// media/chat.js. Covers the two bugs the user reported from live sessions:
//   - reads/globs/greps were miscounted as "Ran N commands" (now categorized by
//     ACP kind → "Explored N items"), and
//   - search tools leaked their raw regex/glob as a bare label (now "Search …");
// plus the requirement that a tool we didn't predict STILL renders (via grok's
// own title), and that all of this works on resumed sessions where the wire form
// carries only a leading-verb title and no `kind`.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const tc = (call: any) => ({ type: "toolCall", call });
const close = (window: Window) => dispatch(window, { type: "messageChunk", text: "done" } as any);

function groupLabel(doc: Document): string | null {
  return doc.querySelector(".tool-group .tool-group-label")?.textContent ?? null;
}
function flatLabel(doc: Document): string | null {
  // The label span only — a command's flat row also carries the #41 details
  // block (full command text), which is not part of the label.
  return doc.querySelector(".tool-flat .tool-label")?.textContent ?? null;
}

describe("tool-call rollup categorization (live, kind present)", () => {
  it("5 reads/globs roll up as 'Explored 5 items', not 'Ran 5 commands'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "read", title: "Read `/a.ts`", rawInput: { path: "/a.ts" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "read", rawInput: { path: "/b.ts" } }));
    dispatch(window, tc({ toolCallId: "3", kind: "search", title: "Glob `**/*`", rawInput: { glob_pattern: "**/*" } }));
    dispatch(window, tc({ toolCallId: "4", kind: "read", rawInput: { path: "/c.ts" } }));
    dispatch(window, tc({ toolCallId: "5", kind: "search", rawInput: { pattern: "foo|bar" } }));
    close(window);
    expect(groupLabel(doc)).toBe("Explored 5 items");
  });

  it("mixes buckets accurately: reads + a command + an edit", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "read", rawInput: { path: "/a.ts" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "execute", rawInput: { command: "npm test" } }));
    dispatch(window, tc({ toolCallId: "3", kind: "edit", rawInput: { path: "/a.ts", contents: "x" } }));
    close(window);
    expect(groupLabel(doc)).toBe("Explored 1 item, edited 1 file, ran 1 command");
  });

  it("counts deletes as deletes, not commands", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "delete", title: "Delete `/x/.env`", rawInput: { path: "/x/.env" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "execute", rawInput: { command: "rm /x/.env" } }));
    close(window);
    expect(groupLabel(doc)).toBe("Deleted 1 file, ran 1 command");
  });
});

describe("tool-call labels (single-call flat line)", () => {
  it("a search tool shows 'Search <pattern>', never a bare leaked regex", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "search", title: "image_edit|/imagine", rawInput: { pattern: "image_edit|/imagine" } }));
    close(window);
    expect(flatLabel(doc)).toBe("Search image_edit|/imagine");
  });

  it("a command shows 'Run <program>' (flags/payload dropped — full text is in the IN/OUT detail)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "execute", title: "Execute `ls`", rawInput: { command: "ls -la /tmp" } }));
    close(window);
    expect(flatLabel(doc)).toBe("Run ls"); // -la is a flag → dropped
  });

  it("a command keeps a non-flag subcommand: 'Run git status'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "execute", title: "Execute", rawInput: { command: "git status --short" } }));
    close(window);
    expect(flatLabel(doc)).toBe("Run git status");
  });

  it("a tool we didn't predict still renders, using grok's own title", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "frobnicate", title: "FrobnicateWidget" }));
    close(window);
    expect(flatLabel(doc)).toBe("FrobnicateWidget");
  });

  // The live first tool_call carries title = raw tool name + the parsed rawInput;
  // these field names are verified against real on-disk sessions.
  it("list_dir shows the folder via target_directory, with a trailing slash", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", title: "list_dir", rawInput: { target_directory: "docs" } }));
    close(window);
    expect(flatLabel(doc)).toBe("List docs/");
  });

  it("list_dir keeps the full relative path (not just the leaf)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", title: "list_dir", rawInput: { target_directory: "docs/screenshots" } }));
    close(window);
    expect(flatLabel(doc)).toBe("List docs/screenshots/");
  });

  it("list_dir on '.' reads as 'List root folder'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", title: "list_dir", rawInput: { target_directory: "." } }));
    close(window);
    expect(flatLabel(doc)).toBe("List root folder");
  });

  it("read_file with a line range shows 'Read <file> lines a-b'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "read", title: "read_file", rawInput: { target_file: "README.md", offset: 1, limit: 30 } }));
    close(window);
    expect(flatLabel(doc)).toBe("Read README.md lines 1-30");
  });

  it("web_fetch shows the page URL ('Fetch <host/path>'), protocol stripped", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", title: "web_fetch", rawInput: { url: "https://example.com/page" } }));
    close(window);
    expect(flatLabel(doc)).toBe("Fetch example.com/page");
  });
});

describe("works on resumed sessions (kind absent, title-only)", () => {
  it("recovers the category from a leading-verb title", () => {
    const { window, doc } = bootWebview();
    // The persisted replay form: good titles, no `kind`.
    dispatch(window, tc({ toolCallId: "1", title: "Read `/a.ts`", rawInput: { path: "/a.ts" } }));
    dispatch(window, tc({ toolCallId: "2", title: "Grep", rawInput: { pattern: "foo" } }));
    dispatch(window, tc({ toolCallId: "3", title: "Glob `**/*.json`", rawInput: { glob_pattern: "**/*.json" } }));
    close(window);
    expect(groupLabel(doc)).toBe("Explored 3 items");
  });

  it("a title-only 'Shell' counts as a command, not exploration", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", title: "Shell" }));
    dispatch(window, tc({ toolCallId: "2", title: "Execute `npm run build`", rawInput: { command: "npm run build" } }));
    close(window);
    expect(groupLabel(doc)).toBe("Ran 2 commands");
  });
});

// Regression fixtures rebuilt from the actual Grok + Composer transcripts the user
// screenshotted. Each previously rolled up wrong ("Ran N commands"); these pin the
// corrected summary. Composer (the `cursor` agent) and Grok Build (`grok-build`)
// emit the same ACP kinds, so one categorizer serves both — these tests prove it
// across both agents' real shapes.
describe("real transcripts — Grok + Composer", () => {
  it("Composer: 4 real shell commands stay 'Ran 4 commands'", () => {
    const { window, doc } = bootWebview();
    for (const [i, c] of [
      `grok -p "Use image_edit on /Users/…"`,
      `grok -p "/imagine Elon Musk in a vast su…"`,
      `ls -la "/Users/pawelhuryn/Downloads/imag…"`,
      `ls -lah "/Users/pawelhuryn/Downloads/elo…"`,
    ].entries()) {
      dispatch(window, tc({ toolCallId: String(i), kind: "execute", rawInput: { command: c } }));
    }
    close(window);
    expect(groupLabel(doc)).toBe("Ran 4 commands"); // genuine commands — unchanged
  });

  it("Composer: a grep + an edit was 'Ran 2 commands' → 'Explored 1 item, edited 1 file'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "search", title: "Write\\(|Edit\\(", rawInput: { pattern: "Write\\(|Edit\\(" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "edit", title: "Edit `/x/.env`", rawInput: { path: "/x/.env", contents: "" } }));
    close(window);
    expect(groupLabel(doc)).toBe("Explored 1 item, edited 1 file");
  });

  it("Composer: a delete + an rm was 'Ran 2 commands' → 'Deleted 1 file, ran 1 command'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "delete", title: "Delete `/Users/pawelhuryn/grok-build-vscode/.env`", rawInput: { path: "/Users/pawelhuryn/grok-build-vscode/.env" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "execute", rawInput: { command: `rm "/Users/pawelhuryn/grok-build-vscode/.env"` } }));
    close(window);
    expect(groupLabel(doc)).toBe("Deleted 1 file, ran 1 command");
  });

  it("Grok: was 'Explored 1 item, ran 4 commands' → 'Explored 3 items, searched web, ran 1 command'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "execute", rawInput: { command: `grok -p '/imagine Elon Musk in a vast su…'` } }));
    dispatch(window, tc({ toolCallId: "2", title: "Web search: Elon Musk CEO Tesla SpaceX 2026" }));
    dispatch(window, tc({ toolCallId: "3", kind: "read", title: "Read image-generation.md", rawInput: { path: "research/image-generation.md" } }));
    dispatch(window, tc({ toolCallId: "4", kind: "search", title: "Glob `**/*imagine*`", rawInput: { glob_pattern: "**/*imagine*" } }));
    dispatch(window, tc({ toolCallId: "5", kind: "search", title: "image_edit|/imagine", rawInput: { pattern: "image_edit|/imagine" } }));
    close(window);
    expect(groupLabel(doc)).toBe("Explored 3 items, searched web, ran 1 command");
  });

  it("Grok: was 'Ran 3 commands' → 'Explored 1 item, ran 2 commands'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "execute", rawInput: { command: `grok -p '/imagine Elon Musk in a vast su…'` } }));
    dispatch(window, tc({ toolCallId: "2", kind: "search", title: "image_edit|grok-build|agent", rawInput: { pattern: "image_edit|grok-build|agent" } }));
    dispatch(window, tc({ toolCallId: "3", kind: "execute", rawInput: { command: "grok models" } }));
    close(window);
    expect(groupLabel(doc)).toBe("Explored 1 item, ran 2 commands");
  });

  it("Grok: a glob + 4 reads was 'Ran 5 commands' → 'Explored 5 items'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "search", title: "Glob", rawInput: { glob_pattern: "**/*" } }));
    for (let i = 2; i <= 5; i++) dispatch(window, tc({ toolCallId: String(i), kind: "read", rawInput: { path: `/f${i}.ts` } }));
    close(window);
    expect(groupLabel(doc)).toBe("Explored 5 items");
  });
});

// grok narrates each step then runs its tools (narrate → tools → narrate → tools).
// The bubble for each narration must sit directly ABOVE the tools it introduced —
// not coalesce into one bubble with N consecutive tool summaries stacked below it.
describe("narration interleaves with tool groups", () => {
  function seq(doc: Document): string[] {
    const messages = doc.getElementById("messages")!;
    return (Array.from(messages.children) as HTMLElement[])
      .filter((c) => c.id !== "welcome")
      .map((c) => {
        if (c.classList.contains("agent")) return "agent:" + (c.querySelector(".body")?.textContent ?? "");
        if (c.classList.contains("tool-group")) return "tools:" + (c.querySelector(".tool-group-label")?.textContent ?? "");
        if (c.classList.contains("tool-flat")) return "tool:" + c.textContent;
        return c.className;
      });
  }

  it("each narration renders above its own tool group, in order", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "messageChunk", text: "First, reading the files." } as any);
    dispatch(window, tc({ toolCallId: "1", kind: "read", rawInput: { path: "/a.ts" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "read", rawInput: { path: "/b.ts" } }));
    dispatch(window, { type: "messageChunk", text: "Now running the build." } as any);
    dispatch(window, tc({ toolCallId: "3", kind: "execute", rawInput: { command: "npm run build" } }));
    dispatch(window, tc({ toolCallId: "4", kind: "execute", rawInput: { command: "npm test" } }));
    dispatch(window, { type: "messageChunk", text: "Done." } as any); // closes the 2nd group

    const s = seq(doc);
    // Two distinct narration bubbles, each immediately above the group it introduced
    // — NOT one merged bubble followed by two back-to-back summaries.
    expect(s.slice(0, 4)).toEqual([
      "agent:First, reading the files.",
      "tools:Explored 2 items",
      "agent:Now running the build.",
      "tools:Ran 2 commands",
    ]);
    // Three separate agent bubbles (the third holds "Done."), not one coalesced.
    expect(s.filter((x) => x.startsWith("agent:"))).toHaveLength(3);
  });
});

// Plan / permission cards finalize the in-flight turn (commitAgentTurn) so they land
// BELOW everything that led to them. With narration now interleaved among the tool
// groups, the lead-up must stay interleaved and the card stay at the bottom — the
// card is a terminal artifact, not a tool group, so it isn't split. These guard the
// interaction between the interleave change and the card machinery.
// Each tool row gets one lucide category icon on the LEFT, picked by the strongest
// action in the group: square-terminal (command/delete/generate) > pencil (edit) >
// folder-search (search) > file (read).
describe("tool-row category icons", () => {
  const iconKind = (el: Element | null): string => {
    const h = (el as any)?.outerHTML || "";
    if (h.includes("M14.5 2H6")) return "file";
    if (h.includes("M11 20H4")) return "search";
    if (h.includes("M21.17")) return "pencil";
    if (h.includes("M11 13h4")) return "terminal";
    return "?";
  };

  it("a single read row gets the file icon, as the first (left) child", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "read", rawInput: { path: "/a.ts" } }));
    close(window);
    const flat = doc.querySelector(".tool-flat")!;
    expect(flat.firstElementChild?.classList.contains("tool-icon")).toBe(true);
    expect(iconKind(flat.querySelector(".tool-icon"))).toBe("file");
  });

  it("a group picks the strongest icon: read + command → terminal", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "read", rawInput: { path: "/a" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "execute", rawInput: { command: "npm test" } }));
    close(window);
    const hdr = doc.querySelector(".tool-group .tool-group-header")!;
    expect(hdr.firstElementChild?.classList.contains("tool-icon")).toBe(true);
    expect(iconKind(hdr.querySelector(".tool-icon"))).toBe("terminal");
  });

  it("search → folder-search, edit → pencil", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "1", kind: "search", rawInput: { pattern: "foo" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "read", rawInput: { path: "/a" } }));
    close(window);
    expect(iconKind(doc.querySelector(".tool-group .tool-icon"))).toBe("search");

    const w2 = bootWebview();
    dispatch(w2.window, tc({ toolCallId: "3", kind: "edit", rawInput: { path: "/a", contents: "x" } }));
    dispatch(w2.window, tc({ toolCallId: "4", kind: "read", rawInput: { path: "/b" } }));
    close(w2.window);
    expect(iconKind(w2.doc.querySelector(".tool-group .tool-icon"))).toBe("pencil");
  });
});

// A failed tool call (e.g. `image_to_video failed: image reference not readable`)
// used to be dropped silently — grok just looked like it gave up. Now the row goes
// error-colored and shows the reason.
describe("failed tool calls surface the reason", () => {
  const FAIL = (id: string, msg: string) => ({
    type: "toolCallUpdate",
    call: {
      toolCallId: id, status: "failed",
      content: [{ type: "content", content: { type: "text", text: msg } }],
      rawOutput: { error: "tool_execution_failed", message: msg },
    },
  });

  it("a single failed tool shows error styling + the reason on its flat row", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "v1", title: "image_to_video", kind: "fetch" }));
    dispatch(window, FAIL("v1", 'image reference not readable: ["/x/1.jpg"]') as any);
    close(window); // single → flat
    const flat = doc.querySelector(".tool-flat")!;
    expect(flat.classList.contains("tool-failed")).toBe(true);
    expect(flat.querySelector(".tool-error")!.textContent).toContain("image reference not readable");
  });

  it("a failed tool inside a group marks the row and flags the group", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "r1", kind: "read", rawInput: { path: "/a" } }));
    dispatch(window, tc({ toolCallId: "e1", kind: "execute", rawInput: { command: "bad" } }));
    dispatch(window, FAIL("e1", "command not found: bad") as any);
    close(window); // multiple → group
    const group = doc.querySelector(".tool-group")!;
    expect(group.classList.contains("has-error")).toBe(true);
    const failed = group.querySelector(".tool-item.tool-failed")!;
    expect(failed.querySelector(".tool-error")!.textContent).toContain("command not found");
  });

  it("a completed tool is never marked failed", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "x", kind: "read", rawInput: { path: "/a" } }));
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "x", status: "completed" } } as any);
    close(window);
    expect(doc.querySelector(".tool-failed")).toBeNull();
  });
});

describe("plan / permission cards sit below interleaved narration + tools", () => {
  function cardSeq(doc: Document): string[] {
    const messages = doc.getElementById("messages")!;
    return (Array.from(messages.children) as HTMLElement[])
      .filter((c) => c.id !== "welcome")
      .map((c) => {
        if (c.classList.contains("thinking")) return "thinking";
        if (c.classList.contains("card") && c.classList.contains("plan")) return "PLAN-CARD";
        if (c.classList.contains("card") && c.classList.contains("permission")) return "PERM-CARD";
        if (c.classList.contains("turn-diff-summary")) return "turn-diff-summary";
        if (c.classList.contains("agent")) return "agent:" + (c.querySelector(".body")?.textContent ?? "");
        if (c.classList.contains("tool-group")) return "tools:" + (c.querySelector(".tool-group-label")?.textContent ?? "");
        if (c.classList.contains("tool-flat")) return "tool:" + c.textContent;
        return c.className;
      });
  }

  it("a plan turn: thinking + interleaved narration/tools, then the plan card at the bottom", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "thoughtChunk", text: "Planning the approach." } as any);
    dispatch(window, { type: "messageChunk", text: "Let me explore the code." } as any);
    dispatch(window, tc({ toolCallId: "1", kind: "read", rawInput: { path: "/a.ts" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "read", rawInput: { path: "/b.ts" } }));
    dispatch(window, { type: "messageChunk", text: "Here's my plan." } as any);
    dispatch(window, { type: "exitPlanRequest", req: { id: 7, plan: "1. do X\n2. do Y" } } as any);

    expect(cardSeq(doc)).toEqual([
      "thinking",
      "agent:Let me explore the code.",
      "tools:Explored 2 items",
      "agent:Here's my plan.",
      "PLAN-CARD",
    ]);
  });

  it("a permission card lands below the narration + tool that triggered it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "messageChunk", text: "I'll remove the stale files." } as any);
    dispatch(window, tc({ toolCallId: "1", kind: "execute", rawInput: { command: "rm /a.tmp" } }));
    dispatch(window, tc({ toolCallId: "2", kind: "execute", rawInput: { command: "rm /b.tmp" } }));
    dispatch(window, {
      type: "permissionRequest",
      req: { id: 9, toolCall: { toolCallId: "x", kind: "execute", title: "Run rm" }, options: [{ optionId: "a", kind: "allow_once", name: "Allow" }, { optionId: "r", kind: "reject_once", name: "Reject" }] },
    } as any);

    expect(cardSeq(doc)).toEqual([
      "agent:I'll remove the stale files.",
      "tools:Ran 2 commands",
      // rm commands are tracked as turn-level deletes (Changed N files card).
      "turn-diff-summary",
      "PERM-CARD",
    ]);
  });
});
