// Keyboard model for the permission card (#68) — drives the REAL shipped
// media/chat.js in a happy-dom window.
//
// The reporter asked for "Yes" first plus Enter-to-approve, and for the card to
// stay out of the way "until the user stops typing for 1 second". The timer is
// deliberately NOT implemented: it would make the same keystroke approve a
// command or not depending on invisible state. These tests pin the alternative —
// the action a key takes always follows VISIBLE focus:
//   - approve is ordered first and is the only button in the tab order,
//   - a card takes focus only when the composer is genuinely idle,
//   - typing at a focused button goes to the composer instead of activating it.
import { describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";
import {
  orderPermissionOptions,
  defaultPermissionIndex,
  shouldFocusPermissionCard,
  isTypeThroughKey,
} from "../media/webview-helpers.js";

const ALLOW = { optionId: "a", name: "Allow once", kind: "allow_once" };
const ALWAYS = { optionId: "aa", name: "Allow always", kind: "allow_always" };
const REJECT = { optionId: "r", name: "Reject", kind: "reject_once" };

function card(window: any, options: unknown[], id = 1, title = "Run npm test") {
  dispatch(window, {
    type: "permissionRequest",
    req: { id, toolCall: { toolCallId: "tc", kind: "execute", title }, options },
  });
}

const buttons = (doc: Document) =>
  [...doc.querySelectorAll(".card.permission .card-actions button")] as HTMLButtonElement[];

function key(window: any, el: Element, init: Record<string, unknown>) {
  el.dispatchEvent(new (window as any).KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("orderPermissionOptions (#68)", () => {
  it("puts approve first and reject last regardless of the CLI's order", () => {
    const out = orderPermissionOptions([REJECT, ALWAYS, ALLOW]);
    expect(out.map((o: any) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });

  it("is stable within a rank — two same-kind options keep the CLI's order", () => {
    const a = { optionId: "1", kind: "allow_once", name: "A" };
    const b = { optionId: "2", kind: "allow_once", name: "B" };
    expect(orderPermissionOptions([a, b]).map((o: any) => o.optionId)).toEqual(["1", "2"]);
  });

  it("sorts an unknown kind between allow and reject — never the default, never below reject", () => {
    const weird = { optionId: "w", kind: "some_future_kind", name: "?" };
    const out = orderPermissionOptions([REJECT, weird, ALLOW]);
    expect(out.map((o: any) => o.kind)).toEqual(["allow_once", "some_future_kind", "reject_once"]);
  });

  it("tolerates junk instead of throwing on a malformed card", () => {
    expect(orderPermissionOptions(undefined)).toEqual([]);
    expect(orderPermissionOptions([null] as any)).toEqual([null]);
  });
});

describe("defaultPermissionIndex (#68)", () => {
  it("defaults to allow_once", () => {
    expect(defaultPermissionIndex(orderPermissionOptions([REJECT, ALLOW]))).toBe(0);
  });

  it("never defaults to allow_always — a keystroke must not widen scope for the session", () => {
    expect(defaultPermissionIndex(orderPermissionOptions([REJECT, ALWAYS]))).toBe(-1);
  });

  it("never defaults to a reject-only card", () => {
    expect(defaultPermissionIndex(orderPermissionOptions([REJECT]))).toBe(-1);
  });
});

describe("shouldFocusPermissionCard (#68)", () => {
  const base = { replaying: false, composing: false, composerText: "", defaultIndex: 0 };

  it("takes focus when the composer is idle and empty", () => {
    expect(shouldFocusPermissionCard(base)).toBe(true);
  });

  it("leaves focus alone when the user has text in the composer", () => {
    expect(shouldFocusPermissionCard({ ...base, composerText: "wait, also " })).toBe(false);
  });

  it("treats whitespace-only as empty", () => {
    expect(shouldFocusPermissionCard({ ...base, composerText: "  \n " })).toBe(true);
  });

  it("never steals focus mid-IME-composition — value is empty but the preedit is not", () => {
    expect(shouldFocusPermissionCard({ ...base, composing: true })).toBe(false);
  });

  it("never takes focus during replay — a re-focused session must not grab the keyboard", () => {
    expect(shouldFocusPermissionCard({ ...base, replaying: true })).toBe(false);
  });

  it("takes no focus when there is no safe default", () => {
    expect(shouldFocusPermissionCard({ ...base, defaultIndex: -1 })).toBe(false);
  });
});

describe("isTypeThroughKey (#68)", () => {
  it("treats a printable character as typing", () => {
    expect(isTypeThroughKey({ key: "a" })).toBe(true);
    expect(isTypeThroughKey({ key: " " })).toBe(true);
  });

  it("does not treat navigation/activation keys as typing", () => {
    for (const k of ["Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "Backspace"]) {
      expect(isTypeThroughKey({ key: k })).toBe(false);
    }
  });

  it("ignores modified keys so Ctrl+C etc. still reach the browser", () => {
    expect(isTypeThroughKey({ key: "c", ctrlKey: true })).toBe(false);
    expect(isTypeThroughKey({ key: "v", metaKey: true })).toBe(false);
  });
});

describe("permission card keyboard (real chat.js in a DOM)", () => {
  const longCommand = Array.from({ length: 40 }, (_, i) => `echo line-${i + 1}`).join("\n");

  it.each([false, true])("a long command is tabbable without taking the default button's focus (remote=%s)", (remote) => {
    const { window, doc, posted } = bootWebview({ remote });
    card(window, [REJECT, ALLOW], 208, longCommand);
    const box = doc.querySelector(".permission-command-scroll") as HTMLElement;
    expect(box.tabIndex).toBe(0);
    expect(doc.activeElement).toBe(buttons(doc)[0]);
    expect(buttons(doc).map((b) => b.classList.contains("chosen"))).toEqual([true, false]);

    box.focus();
    for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "]) {
      const event = new (window as any).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      box.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false); // native scrolling stays available
      expect(doc.activeElement).toBe(box);
    }
    expect(posted.filter((m) => m.type === "permissionAnswer")).toHaveLength(0);
    buttons(doc)[0].focus();
    key(window, doc.activeElement!, { key: "ArrowRight" });
    expect(doc.activeElement).toBe(buttons(doc)[1]);
    key(window, doc.activeElement!, { key: "ArrowLeft" });
    click(window, doc.activeElement!); // browser activation of the focused button
    expect(posted).toContainEqual({ type: "permissionAnswer", requestId: 208, optionId: "a" });
    expect(doc.querySelector(".permission-command-scroll")).toBeNull();
  });

  it("a replayed long command leaves focus in the composer", () => {
    const { window, doc } = bootWebview();
    const input = doc.querySelector("#input") as HTMLTextAreaElement;
    input.focus();
    dispatch(window, { type: "historyReplay", active: true });
    card(window, [REJECT, ALLOW], 208, longCommand);
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".permission-command-scroll")).not.toBeNull();
    expect(doc.activeElement).toBe(input);
  });

  it("renders approve first even when the CLI sends reject first", () => {
    const { window, doc } = bootWebview();
    card(window, [REJECT, ALLOW]);
    expect(buttons(doc).map((b) => b.textContent)).toEqual(["Allow once", "Reject"]);
  });

  it("guards reject for 1000ms when thinking traces are visible (#76)", () => {
    const { window, doc } = bootWebview();
    const scheduled: Array<{ handler: TimerHandler; timeout?: number }> = [];
    const timer = vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      scheduled.push({ handler, timeout });
      return scheduled.length;
    }) as typeof window.setTimeout);
    try {
      // Thinking traces only surface under Coding purpose.
      dispatch(window, { type: "appPurpose", value: "coding" });
      dispatch(window, { type: "showThinking", value: true });
      card(window, [REJECT, ALLOW]);
      const reject = buttons(doc)[1];
      expect(reject.classList.contains("arming")).toBe(true);
      const guard = scheduled.find(({ timeout }) => timeout === 1000);
      expect(guard).toBeDefined();
      if (typeof guard!.handler === "function") guard!.handler();
      expect(reject.classList.contains("arming")).toBe(false);
    } finally {
      timer.mockRestore();
    }
  });

  it("leaves reject immediately clickable when thinking traces are hidden (#76)", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "showThinking", value: false });
    card(window, [REJECT, ALLOW], 6);
    const reject = buttons(doc)[1];
    expect(reject.classList.contains("arming")).toBe(false);
    click(window, reject);
    expect(posted.find((m: any) => m.type === "permissionAnswer")).toEqual({
      type: "permissionAnswer",
      requestId: 6,
      optionId: "r",
    });
  });

  it("focuses approve when the card arrives at an empty composer", () => {
    const { window, doc } = bootWebview();
    card(window, [REJECT, ALLOW]);
    expect(doc.activeElement).toBe(buttons(doc)[0]);
    expect(buttons(doc)[0].textContent).toBe("Allow once");
    expect(buttons(doc).map((b) => b.classList.contains("chosen"))).toEqual([true, false]);
  });

  it("leaves focus in the composer when the user is mid-message", () => {
    const { window, doc } = bootWebview();
    const input = doc.querySelector("#input") as HTMLTextAreaElement;
    input.value = "hold on, also do";
    card(window, [REJECT, ALLOW]);
    expect(doc.activeElement).not.toBe(buttons(doc)[0]);
  });

  it("puts only the default button in the tab order, so Tab escapes the card", () => {
    const { window, doc } = bootWebview();
    card(window, [REJECT, ALLOW]);
    expect(buttons(doc).map((b) => b.tabIndex)).toEqual([0, -1]);
  });

  it("Enter on the focused approve button answers allow_once", () => {
    const { window, posted, doc } = bootWebview();
    card(window, [REJECT, ALLOW], 5);
    // The browser turns Enter/Space on a focused button into a click; assert the
    // payload that click produces is the approve option, not the reject.
    click(window, doc.activeElement as Element);
    expect(posted.find((m: any) => m.type === "permissionAnswer")).toEqual({
      type: "permissionAnswer",
      requestId: 5,
      optionId: "a",
    });
    expect(doc.activeElement).toBe(doc.querySelector("#input"));
  });

  it("arrow keys move focus, the tab stop, and the visible chosen marker together", () => {
    const { window, doc } = bootWebview();
    card(window, [REJECT, ALLOW]);
    key(window, doc.activeElement!, { key: "ArrowRight" });
    expect(doc.activeElement).toBe(buttons(doc)[1]);
    expect(buttons(doc).map((b) => b.tabIndex)).toEqual([-1, 0]);
    expect(buttons(doc).map((b) => b.classList.contains("chosen"))).toEqual([false, true]);
    // Wraps back around rather than dead-ending.
    key(window, doc.activeElement!, { key: "ArrowRight" });
    expect(doc.activeElement).toBe(buttons(doc)[0]);
    expect(buttons(doc).map((b) => b.classList.contains("chosen"))).toEqual([true, false]);
  });

  it("Escape hands the keyboard back WITHOUT answering — never an implicit reject", () => {
    const { window, posted, doc } = bootWebview();
    card(window, [REJECT, ALLOW]);
    key(window, doc.activeElement!, { key: "Escape" });
    expect(doc.activeElement).toBe(doc.querySelector("#input"));
    expect(posted.filter((m: any) => m.type === "permissionAnswer")).toHaveLength(0);
    expect(doc.querySelector(".card.permission.resolved")).toBeNull(); // still pending
  });

  it("typing at a focused button goes to the composer instead of answering", () => {
    const { window, posted, doc } = bootWebview();
    card(window, [REJECT, ALLOW]);
    const input = doc.querySelector("#input") as HTMLTextAreaElement;
    key(window, doc.activeElement!, { key: "n" });
    expect(doc.activeElement).toBe(input);
    expect(input.value).toBe("n"); // the keystroke is not swallowed
    expect(posted.filter((m: any) => m.type === "permissionAnswer")).toHaveLength(0);
  });

  it("takes no focus at all when the only options are allow_always / reject", () => {
    const { window, doc } = bootWebview();
    card(window, [ALWAYS, REJECT]);
    expect(buttons(doc).map((b) => b.textContent)).toEqual(["Allow always", "Reject"]);
    expect(doc.activeElement).not.toBe(buttons(doc)[0]);
  });
});
