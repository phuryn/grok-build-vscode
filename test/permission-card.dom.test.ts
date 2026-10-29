// DOM-level test of the permission card's diff-preview UX (issue #21) — drives
// the REAL shipped media/chat.js in a happy-dom window. It seeds the edit diff
// (via the toolCallUpdate the host posts), renders the permission card, and
// asserts the webview now:
//   - auto-opens the diff (posts `openDiff`) the moment the card appears,
//   - carries the `requestId` on both `openDiff` and `permissionAnswer` so the
//     host can pair the auto-opened tab with the answer and close it,
//   - still offers a manual "open diff →" button to re-open it.
import { afterEach, describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const DIFF = { type: "diff", path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" };

afterEach(() => vi.restoreAllMocks());

function mockWrappedCommandLayout(win: any) {
  for (const [property, size] of [["clientWidth", 120], ["clientHeight", 52], ["scrollHeight", 208]] as const) {
    vi.spyOn(win.HTMLElement.prototype, property, "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("command-card-title") ? size : 0;
    });
  }
}

function seedDiffAndCard(window: any, requestId: number | string = 7) {
  // The host posts the edit content as a toolCallUpdate; chat.js stashes it in
  // pendingDiffByToolCallId keyed by toolCallId.
  dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
  dispatch(window, {
    type: "permissionRequest",
    req: {
      id: requestId,
      toolCall: { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "rej", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}

describe("permission card diff preview (real chat.js in a DOM)", () => {
  it("updates an existing card's options when Plan mode changes", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 77,
        toolCall: { toolCallId: "tc-mode", kind: "execute", title: "Run a command" },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    dispatch(window, {
      type: "permissionOptions",
      requestId: 77,
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    expect([...doc.querySelectorAll(".card.permission .card-actions button")]
      .map((button) => button.textContent)).toEqual(["Allow once", "Reject"]);

    dispatch(window, {
      type: "permissionOptions",
      requestId: 77,
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const buttons = [...doc.querySelectorAll(".card.permission .card-actions button")] as HTMLButtonElement[];
    expect(buttons.map((button) => button.textContent))
      .toEqual(["Allow once", "Allow always", "Reject"]);

    buttons[1].click();
    expect(posted).toContainEqual({
      type: "permissionAnswer",
      requestId: 77,
      optionId: "always",
    });
  });

  it("auto-opens the diff with the file content and requestId when the card appears", () => {
    const { window, posted, doc } = bootWebview();
    seedDiffAndCard(window, 7);

    const card = doc.querySelector(".card.permission");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".card-subtitle")!.textContent).toContain("src/foo.ts");

    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(1);
    expect(openDiffs[0]).toEqual({
      type: "openDiff",
      path: "src/foo.ts",
      oldText: "a\nb",
      newText: "a\nB\nc",
      requestId: 7,
    });
  });

  it("does NOT auto-open again when the same card is re-rendered (#132)", () => {
    // The reported bug: close the proposed diff, switch conversations, come
    // back, and it reopens — on top of the files you were actually working in.
    // Re-entering a chat rebuilds its pending cards from the transcript, and
    // that rebuild was firing auto-open a second time. A card being redrawn is
    // not the card arriving.
    const { window, posted, doc } = bootWebview();
    seedDiffAndCard(window, 11);
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(1);

    // The same permission arriving again, exactly as a transcript replay
    // delivers it.
    seedDiffAndCard(window, 11);

    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(1);
    // The card is still there and still offers the manual control — the fix
    // removes the surprise, not the ability to look.
    const btn = doc.querySelector(".card.permission .preview-link") as HTMLButtonElement;
    expect(btn).not.toBeNull();
  });

  it("still auto-opens a DIFFERENT request, because that is a new proposal", () => {
    // The dedupe must be per request, not a one-shot for the whole window: a
    // fresh edit is a fresh thing to look at.
    const { window, posted } = bootWebview();
    seedDiffAndCard(window, 21);
    seedDiffAndCard(window, 22);

    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(2);
    expect(openDiffs.map((m: any) => m.requestId)).toEqual([21, 22]);
  });

  it("keeps a manual 'open diff' button that re-opens the same diff", () => {
    const { window, posted, doc } = bootWebview();
    seedDiffAndCard(window, 9);

    const btn = doc.querySelector(".card.permission .preview-link") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("open diff");
    click(window, btn);

    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(2); // auto-open + the manual re-open
    expect(openDiffs[1].requestId).toBe(9);
  });

  it("expands the existing inline tool diff instead of posting a native editor action remotely", () => {
    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" },
    });
    seedDiffAndCard(window, 10);

    const details = doc.querySelector(".tool-item-diff") as HTMLElement;
    expect(details).not.toBeNull();
    expect(details.hidden).toBe(true);
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);

    click(window, doc.querySelector(".card.permission .preview-link")!);

    expect(details.hidden).toBe(false);
    expect(doc.querySelector(".tool-group-body")!.hasAttribute("hidden")).toBe(false);
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
  });

  it("answering carries the same requestId so the host can close the auto-opened tab", () => {
    const { window, posted, doc } = bootWebview();
    seedDiffAndCard(window, 11);

    const allow = [...doc.querySelectorAll(".card.permission .card-actions button")]
      .find((b) => b.textContent === "Allow once") as HTMLButtonElement;
    click(window, allow);

    const answer = posted.find((m: any) => m.type === "permissionAnswer");
    expect(answer).toEqual({ type: "permissionAnswer", requestId: 11, optionId: "allow" });
  });

  it("does not auto-open when the permission has no diff (e.g. a command)", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 12,
        toolCall: { toolCallId: "tc-exec", kind: "execute", title: "Run npm test" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      },
    });

    expect(doc.querySelector(".card.permission")).not.toBeNull();
    expect(doc.querySelector(".card.permission .preview-link")).toBeNull();
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
  });

  it("scrolls even a single wrapped command and keeps its editor View all path", () => {
    const { window, doc, posted } = bootWebview({
      beforeScripts: mockWrappedCommandLayout,
    });
    const command = `python -c "${"print('x');".repeat(300)}"`;
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 13,
        toolCall: { toolCallId: "tc-long", kind: "execute", title: command },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    const card = doc.querySelector(".card.permission")!;
    const title = card.querySelector(".command-card-title") as HTMLElement;
    expect(title.textContent).toBe(command);
    expect(title.title).toBe(command);
    expect(title.tagName).toBe("PRE");
    expect(title.classList.contains("command-preview-capped")).toBe(true);
    expect(title.classList.contains("permission-command-scroll")).toBe(true);
    expect(title.tabIndex).toBe(0);
    // Ten lines of a command you are asked to approve (#208), not four.
    expect(title.style.getPropertyValue("--command-preview-lines")).toBe("10");
    expect(card.querySelector(".command-view-all")!.textContent).toBe("View all (1 lines) →");
    expect(card.querySelectorAll(".card-actions button")).toHaveLength(2);
    click(window, card.querySelector(".command-view-all")!);
    expect(posted).toContainEqual({ type: "openText", content: `# Command\n${command}` });
  });

  it("keeps a wrapped remote permission command in its scroll box without View all", () => {
    const { window, doc, posted } = bootWebview({
      remote: true,
      beforeScripts: mockWrappedCommandLayout,
    });
    const command = `python -c "${"print('x');".repeat(300)}"`;
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 14,
        toolCall: { toolCallId: "tc-remote-long", kind: "execute", title: command },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      },
    });

    const title = doc.querySelector(".command-card-title") as HTMLElement;
    expect(doc.querySelector(".command-view-all")).toBeNull();
    expect(title.textContent).toBe(command);
    expect(title.classList.contains("command-full")).toBe(false);
    expect(title.classList.contains("permission-command-scroll")).toBe(true);
    expect(doc.querySelector("#preview-overlay")).toBeNull();
    expect(doc.querySelector(".permission-command-caption")!.textContent).toBe("1 line · scroll to read all");
    expect(posted.filter((m: any) => m.type === "openText")).toHaveLength(0);
  });
});

describe("pending command scroll box (#208)", () => {
  const longCommand = Array.from({ length: 40 }, (_, i) => `echo line-${i + 1}`).join("\n");
  const request = (title = longCommand, kind = "execute") => ({
    type: "permissionRequest",
    req: {
      id: 208,
      toolCall: { toolCallId: "tc-scroll", kind, title },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });

  for (const surface of ["editor", "desktop", "remote"]) {
    const boot = () => {
      const harness = bootWebview({ remote: surface === "remote" });
      if (surface === "desktop") {
        dispatch(harness.window, { type: "initialState", capabilities: { previewInApp: true } });
      }
      return harness;
    };

    it(`${surface}: keeps all 40 lines in a scroll region beside the actions`, () => {
      const { window, doc, posted } = boot();
      dispatch(window, request());
      const box = doc.querySelector(".permission-command-scroll")!;
      expect(box.textContent).toBe(longCommand);
      expect(box.getAttribute("role")).toBe("region");
      expect(box.getAttribute("aria-label")).toBe("Command awaiting approval");
      expect(box.querySelector(".card-actions")).toBeNull();
      expect(doc.querySelectorAll(".card-actions button")).toHaveLength(2);
      if (surface === "remote") {
        expect(doc.querySelector(".command-view-all")).toBeNull();
        expect(doc.querySelector("#preview-overlay")).toBeNull();
        const caption = doc.querySelector(".permission-command-caption") as HTMLElement;
        expect(caption.textContent).toBe("40 lines · scroll to read all");
        expect(box.nextElementSibling).toBe(caption);
        expect(caption.tagName).toBe("DIV");
        expect(caption.tabIndex).toBe(-1);
        click(window, caption);
        expect(doc.querySelector("#preview-overlay")).toBeNull();
        expect(posted.filter((m) => m.type === "openText" || m.type === "permissionAnswer")).toHaveLength(0);
      } else {
        expect(doc.querySelector(".command-view-all")!.textContent).toBe("View all (40 lines) →");
        expect(doc.querySelector(".permission-command-caption")).toBeNull();
      }
      if (surface === "desktop") {
        click(window, doc.querySelector(".command-view-all")!);
        expect(doc.querySelector("#preview-overlay .preview-body")!.textContent).toContain(longCommand);
      }
    });

    it(`${surface}: leaves a three-line command without a scroll region or extra tab stop`, () => {
      const { window, doc } = boot();
      dispatch(window, request("echo one\necho two\necho three"));
      expect(doc.querySelector(".permission-command-scroll")).toBeNull();
      expect(doc.querySelector(".permission-command-caption")).toBeNull();
      expect(doc.querySelector(".command-view-all")).toBeNull();
      expect(doc.querySelector(".command-card-title")!.hasAttribute("tabindex")).toBe(false);
    });

    it.each(["allow", "reject"])(`${surface}: removes the scroll box after %s`, (option) => {
      const { window, doc } = boot();
      dispatch(window, request());
      const actions = doc.querySelectorAll(".card-actions button");
      click(window, actions[option === "allow" ? 0 : 1]);
      expect(doc.querySelector(".perm-resolved")).not.toBeNull();
      expect(doc.querySelector(".permission-command-scroll")).toBeNull();
      expect(doc.querySelector(".command-card-title")).toBeNull();
      expect(doc.querySelector(".command-view-all")).toBeNull();
      expect(doc.querySelector(".permission-command-caption")).toBeNull();
    });

    it(`${surface}: rebuilds a pending box on replay and removes it on buffered resolution`, () => {
      const { window, doc } = boot();
      dispatch(window, { type: "historyReplay", active: true });
      dispatch(window, request());
      dispatch(window, { type: "historyReplay", active: false });
      expect(doc.querySelector(".permission-command-scroll")!.textContent).toBe(longCommand);
      if (surface === "remote") {
        expect(doc.querySelector(".command-view-all")).toBeNull();
        expect(doc.querySelector(".permission-command-caption")!.textContent).toBe("40 lines · scroll to read all");
      }
      // Re-enter again with the resolution buffered after the original request.
      dispatch(window, { type: "clearMessages" });
      dispatch(window, { type: "historyReplay", active: true });
      dispatch(window, request());
      dispatch(window, { type: "permissionResolved", requestId: 208, optionId: "allow" });
      dispatch(window, { type: "historyReplay", active: false });
      expect(doc.querySelector(".perm-resolved")).not.toBeNull();
      expect(doc.querySelector(".permission-command-scroll")).toBeNull();
      expect(doc.querySelector(".command-view-all")).toBeNull();
      expect(doc.querySelector(".permission-command-caption")).toBeNull();
    });

    it(`${surface}: leaves transcript IN/OUT previews clipped, with their existing View all`, () => {
      const { window, doc, posted } = boot();
      dispatch(window, { type: "expandCommandOutputs", value: true });
      dispatch(window, { type: "toolCall", call: {
        toolCallId: "tc-transcript", kind: "execute", title: longCommand,
        rawInput: { command: longCommand },
      } });
      dispatch(window, { type: "commandOutput", command: longCommand,
        output: longCommand, exitCode: 0 });
      const previews = [...doc.querySelectorAll(".cmd-io pre")];
      expect(previews).toHaveLength(2);
      for (const preview of previews) {
        expect(preview.classList.contains("command-preview-capped")).toBe(true);
        expect(preview.classList.contains("permission-command-preview")).toBe(false);
        expect(preview.hasAttribute("tabindex")).toBe(false);
      }
      expect(doc.querySelector(".permission-command-scroll")).toBeNull();
      expect(doc.querySelector(".permission-command-caption")).toBeNull();
      click(window, doc.querySelector(".command-view-all")!);
      if (surface === "remote") {
        expect(doc.querySelector(".tool-cmd.command-full")).not.toBeNull();
        expect(doc.querySelector("#preview-overlay")).toBeNull();
        expect(posted.filter((m) => m.type === "openText")).toHaveLength(0);
      }
    });
  }

  it("removes the remote caption when a wrapped command fits after resize and restores it once", () => {
    const { window, doc } = bootWebview({ remote: true, beforeScripts: mockWrappedCommandLayout });
    dispatch(window, request("echo one\necho two\necho three"));
    const box = doc.querySelector(".command-card-title") as HTMLElement & { _syncOverflowAffordance(): void };
    expect(doc.querySelector(".permission-command-caption")!.textContent).toBe("3 lines · scroll to read all");
    const height = vi.spyOn(window.HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(52);
    box._syncOverflowAffordance();
    expect(doc.querySelector(".permission-command-scroll")).toBeNull();
    expect(doc.querySelector(".permission-command-caption")).toBeNull();
    height.mockReturnValue(208);
    box._syncOverflowAffordance();
    box._syncOverflowAffordance();
    expect(doc.querySelectorAll(".permission-command-caption")).toHaveLength(1);
    expect(box.nextElementSibling).toBe(doc.querySelector(".permission-command-caption"));
  });

  it("does not turn other permission kinds or plan reviews into command scrollers", () => {
    const { window, doc } = bootWebview();
    dispatch(window, request(longCommand, "read"));
    const plan = request();
    dispatch(window, { ...plan, req: { ...plan.req, id: 209, plan: longCommand } });
    expect(doc.querySelectorAll(".card.permission")).toHaveLength(2);
    expect(doc.querySelector(".plan-body")!.textContent).toContain("echo line-40");
    expect(doc.querySelector(".permission-command-preview")).toBeNull();
    expect(doc.querySelector(".permission-command-caption")).toBeNull();
  });
});
