// Open-path history window (#102). A long replay renders only the last N
// counted user turns; earlier turns prepend on demand. Live sessions stay whole.
import { describe, it, expect } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

function setHistoryWindow(window: Window, n: number) {
  (window as unknown as { __grokHistoryWindow: number }).__grokHistoryWindow = n;
}

function api(window: Window) {
  return (window as unknown as {
    __grokHistory: {
      prefixRemaining: () => number;
      prefixLength: () => number;
      expandMore: () => boolean;
      expandAll: () => void;
    };
    __grokFind: {
      open: () => void;
      setQuery: (q: string) => void;
      matchCount: () => number;
    };
  });
}

function playLiveTurn(window: Window, user: string, agent: string) {
  dispatch(window, { type: "userMessage", text: user, chips: [] });
  dispatch(window, { type: "agentStart" });
  dispatch(window, { type: "messageChunk", text: agent });
  dispatch(window, { type: "agentEnd" });
}

function replayTurns(window: Window, n: number, label: (i: number) => { user: string; agent: string }) {
  dispatch(window, { type: "historyReplay", active: true });
  for (let i = 0; i < n; i++) {
    const t = label(i);
    dispatch(window, { type: "userMessage", text: t.user, chips: [] });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: t.agent });
    dispatch(window, { type: "agentEnd" });
  }
  dispatch(window, { type: "historyReplay", active: false });
}

function userBodies(doc: Document) {
  return [...doc.querySelectorAll(".msg.user:not(.queued) .body")].map((el) => (el.textContent || "").trim());
}

describe("history window on open (#102)", () => {
  it("renders a short replay in full", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 5);
    replayTurns(window, 4, (i) => ({ user: `short-user-${i}`, agent: `short-agent-${i}` }));
    expect(userBodies(doc)).toEqual([
      "short-user-0", "short-user-1", "short-user-2", "short-user-3",
    ]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
  });

  it("renders only the last window of a long replay", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 5);
    replayTurns(window, 12, (i) => ({ user: `user-${i}`, agent: `agent-${i}` }));
    expect(userBodies(doc)).toEqual([
      "user-7", "user-8", "user-9", "user-10", "user-11",
    ]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(7);
    expect(doc.body.textContent).not.toContain("user-0");
    const last = doc.querySelectorAll(".msg.user:not(.queued)")[4] as HTMLElement;
    expect(last.dataset.userBubbleIndex).toBe("11");
  });

  it("prepends earlier turns without dropping the live tail", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 4);
    replayTurns(window, 10, (i) => ({ user: `u${i}`, agent: `a${i}` }));
    expect(userBodies(doc)).toEqual(["u6", "u7", "u8", "u9"]);
    api(window).__grokHistory.expandMore();
    const users = userBodies(doc);
    expect(users[0]).toBe("u0");
    expect(users.slice(-4)).toEqual(["u6", "u7", "u8", "u9"]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
  });

  it("prepends older chunks from the top without unloading later ones", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 5);
    replayTurns(window, 50, (i) => ({ user: `u${i}`, agent: `a${i}` }));
    expect(userBodies(doc)).toEqual(["u45", "u46", "u47", "u48", "u49"]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(45);
    expect(api(window).__grokHistory.expandMore()).toBe(true);
    const afterFirst = userBodies(doc);
    expect(afterFirst.slice(-5)).toEqual(["u45", "u46", "u47", "u48", "u49"]);
    expect(afterFirst[0]).toBe("u5");
    expect(api(window).__grokHistory.prefixRemaining()).toBe(5);
    expect(api(window).__grokHistory.expandMore()).toBe(true);
    const afterSecond = userBodies(doc);
    expect(afterSecond[0]).toBe("u0");
    expect(afterSecond.slice(-5)).toEqual(["u45", "u46", "u47", "u48", "u49"]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
  });

  it("does not window a live session that grows one turn at a time", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 3);
    for (let i = 0; i < 8; i++) playLiveTurn(window, `live-${i}`, `reply-${i}`);
    expect(userBodies(doc)).toHaveLength(8);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
  });

  it("find expands unrendered history before searching", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 4);
    replayTurns(window, 10, (i) => ({
      user: i === 0 ? "EARLY_NEEDLE_TOKEN hello" : `user-${i}`,
      agent: `agent-${i}`,
    }));
    expect(doc.body.textContent).not.toContain("EARLY_NEEDLE_TOKEN");
    const find = api(window).__grokFind;
    find.open();
    find.setQuery("EARLY_NEEDLE_TOKEN");
    expect(find.matchCount()).toBe(1);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
    expect(userBodies(doc)[0]).toContain("EARLY_NEEDLE_TOKEN");
  });

  it("export includes unrendered prefix turns", () => {
    const { window, posted } = bootWebview();
    setHistoryWindow(window, 3);
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Long", cwd: "/w" });
    replayTurns(window, 6, (i) => ({ user: i === 0 ? "export-early-token" : `user-${i}`, agent: `agent-${i}` }));
    expect(api(window).__grokHistory.prefixRemaining()).toBe(3);
    const slot = window.document.getElementById("session-head-actions");
    const btn = slot?.querySelector(".rail-menu-btn") as HTMLButtonElement;
    click(window, btn);
    const item = [...window.document.querySelectorAll(".rail-menu-item")]
      .find((el) => (el.textContent || "").includes("Export as Markdown")) as HTMLButtonElement;
    click(window, item);
    const sent = posted.filter((m) => m.type === "openText");
    expect(sent).toHaveLength(1);
    expect(String(sent[0].content)).toContain("export-early-token");
  });
});

function cardTranscript(doc: Document): string[] {
  const messages = doc.getElementById("messages")!;
  const out: string[] = [];
  for (const child of Array.from(messages.children) as HTMLElement[]) {
    if (child.id === "welcome" || child.id === "history-head") continue;
    if (child.classList.contains("plan-history")) {
      out.push(`plan:${(child.querySelector(".plan-body")?.textContent || "").trim()}`);
    } else if (child.classList.contains("perm-resolved")) {
      out.push(`perm:${(child.querySelector(".perm-resolved-what")?.textContent || "").trim()}`);
    } else if (child.classList.contains("user") && !child.classList.contains("queued")) {
      out.push(`user:${(child.querySelector(".body")?.textContent || "").trim()}`);
    }
  }
  return out;
}

function replayUserTurns(window: Window, n: number) {
  dispatch(window, { type: "historyReplay", active: true });
  for (let i = 1; i <= n; i++) {
    dispatch(window, { type: "userMessage", text: `u${i}`, chips: [] });
  }
  dispatch(window, { type: "historyReplay", active: false });
}

describe("history window plan/permission cards (#102 prepend)", () => {
  it("resolves parked permissions in the park without changing a live card with the same id", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 1);
    const request = (title: string) => ({ type: "permissionRequest", req: { id: 0,
      toolCall: { title, kind: "other" }, options: [{ optionId: title, kind: "allow_once", name: title }],
    } });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessage", text: "old turn" });
    dispatch(window, request("Old request"));
    dispatch(window, { type: "permissionOptions", requestId: 0,
      options: [{ optionId: "old-update", kind: "allow_once", name: "Old options" }] });
    dispatch(window, { type: "permissionResolved", requestId: 0, outcome: "closed" });
    dispatch(window, { type: "userMessage", text: "new turn" });
    dispatch(window, request("New request"));
    dispatch(window, { type: "historyReplay", active: false });
    expect(api(window).__grokHistory.prefixRemaining()).toBe(1);
    const live = doc.querySelector(".card.permission")!;
    expect(live.querySelector("button")!.textContent).toBe("New request");

    api(window).__grokHistory.expandMore();
    const cards = [...doc.querySelectorAll(".card.permission")];
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Closed");
    expect(cards[0].textContent).toContain("Old request");
    expect(cards[0].querySelector("button")).toBeNull();
    expect(cards[1]).toBe(live);
    expect(live.querySelector("button")!.textContent).toBe("New request");
    expect(live.classList.contains("perm-resolved")).toBe(false);
    // Outside hydration, both frames still target the live transcript.
    dispatch(window, { type: "permissionOptions", requestId: 0,
      options: [{ optionId: "new-update", kind: "allow_once", name: "New options" }] });
    expect(live.querySelector("button")!.textContent).toBe("New options");
    dispatch(window, { type: "permissionResolved", requestId: 0, outcome: "closed" });
    expect(live.querySelector("button")).toBeNull();
    expect(live.textContent).toContain("Closed");
  });

  it("a conversation shorter than one window still places cards beside their turns", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 80);
    dispatch(window, {
      type: "planHistoryQueue",
      plans: [{ text: "short-plan", verdict: "approved", afterUserMessage: 2 }],
    });
    dispatch(window, {
      type: "permissionHistoryQueue",
      permissions: [{ title: "short-perm", outcome: "allowed", afterUserMessage: 1 }],
    });
    replayUserTurns(window, 4);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
    expect(cardTranscript(doc)).toEqual([
      "user:u1",
      "perm:short-perm",
      "user:u2",
      "plan:short-plan",
      "user:u3",
      "user:u4",
    ]);
  });

  it("after two prepends, each card sits beside its own turn and earlier ones stay deferred", () => {
    // Window 80 + two prepends of 40 = 160 rendered from the end. Cards on
    // still-unrendered turns must not drain into the first prepended chunk.
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 80);
    dispatch(window, {
      type: "planHistoryQueue",
      plans: [
        { text: "plan-early", verdict: "approved", afterUserMessage: 10 },
        { text: "plan-mid", verdict: "rejected", afterUserMessage: 1360 },
        { text: "plan-tail", verdict: "abandoned", afterUserMessage: 1480 },
      ],
    });
    dispatch(window, {
      type: "permissionHistoryQueue",
      permissions: [
        { title: "perm-early", outcome: "allowed", afterUserMessage: 20 },
        { title: "perm-mid", outcome: "rejected", afterUserMessage: 1390 },
        { title: "perm-tail", outcome: "allowed", afterUserMessage: 1490 },
      ],
    });
    replayUserTurns(window, 1500);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(1420);
    const initial = cardTranscript(doc);
    expect(initial[0]).toBe("user:u1421");
    expect(initial.at(-1)).toBe("user:u1500");
    expect(initial).not.toContain("plan:plan-early");
    expect(initial).not.toContain("perm:perm-early");
    expect(initial).not.toContain("plan:plan-mid");
    expect(initial.indexOf("plan:plan-tail")).toBe(initial.indexOf("user:u1480") + 1);
    expect(initial.indexOf("perm:perm-tail")).toBe(initial.indexOf("user:u1490") + 1);

    expect(api(window).__grokHistory.expandMore()).toBe(true);
    expect(api(window).__grokHistory.expandMore()).toBe(true);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(1340);

    const afterTwo = cardTranscript(doc);
    expect(afterTwo).not.toContain("plan:plan-early");
    expect(afterTwo).not.toContain("perm:perm-early");
    const at = (label: string) => afterTwo.indexOf(label);
    expect(at("user:u10")).toBe(-1);
    expect(at("user:u1360")).toBeGreaterThan(-1);
    expect(at("plan:plan-mid")).toBe(at("user:u1360") + 1);
    expect(at("user:u1361")).toBe(at("plan:plan-mid") + 1);
    expect(at("perm:perm-mid")).toBe(at("user:u1390") + 1);
    expect(at("user:u1391")).toBe(at("perm:perm-mid") + 1);
    expect(at("plan:plan-tail")).toBe(at("user:u1480") + 1);
    expect(at("perm:perm-tail")).toBe(at("user:u1490") + 1);
    expect(afterTwo[0]).toBe("user:u1341");
    expect(afterTwo.at(-1)).toBe("user:u1500");
  }, 20_000);
});
