import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness, type Posted } from "./webview-harness";

const { collect } = createRequire(import.meta.url)("../scripts/l10n-extract.cjs") as {
  collect(): { keys: string[] };
};
const pseudo = (text: string) => `⟦${text}⟧`;
const strings = Object.fromEntries(collect().keys.map((key) => [key, pseudo(key)]));
const windows: Harness["window"][] = [];

function boot(bundle: Record<string, string> | null = strings) {
  const h = bootWebview({ vscode: true, ...(bundle ? { strings: bundle } : {}) });
  windows.push(h.window);
  return h;
}

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

function el<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

// Exact, case-sensitive exceptions for the fixtures below.
const english = {
  context: [
    // Subscription labels, category names and details, and unavailable reasons from the host.
    "Weekly limit", "Tool category (advertised detail)", "Host selection reason",
    // DeepSeek's own names for its harness profiles.
    "Default", "Minimal",
    // Compact token units are formatted independently of the panel language.
    "0 / 1M (0%)", "320K / 1M (32%)", "40K / 1M (4%)", "500K", "2K", "3K", "4K", "6K", "30K", "288K",
  ],
  plan: [
    // Plan text and file names come from the agent. Permission option names come from its adapter.
    "Agent plan", "plan.md", "/tmp/plan.md", "Keep planning", "Approve edits", "Auto-approve edits",
    // A resolution without a plan falls through to the ordinary permission card.
    "Allowed", "Rejected", "Plan review",
  ],
  question: [
    // Question text, option labels and option descriptions are agent data.
    "Pick a color?", "Blue", "Red", "A cool color", "Other",
    // The stale-request notice is a failure notice. The draft and chosen answers are asserted separately.
    "Question is no longer open",
  ],
  tips: [
    // Editor command names and the CLI update message supplied by the host.
    "Toggle Agents Side Bar", "Host updater progress",
  ],
  onboarding: [
    // Product names and CLI names in the agent grid and unavailable Muse panel.
    "Grok Build CLI", "Codex", "OpenAI Codex CLI", "Claude Code", "Claude Code CLI",
    "Muse Code", "Meta Muse CLI", "DeepSeek", "Antigravity", "Google Antigravity",
    // Commands, file names and URL text.
    "irm https://x.ai/cli/install.ps1 | iex", "npm i -g @openai/codex", "claude --version",
    "irm https://dev.meta.ai/install.ps1 | iex", "curl -fsSL https://dev.meta.ai/install.sh | bash",
    "codex login", "claude auth login", "grok login", "grok logout", ".env", "console.x.ai", "XAI_API_KEY=your-key-here",
    // Host-managed sign-in code, failures, and explanatory content.
    "ADAPTER-CODE", "Host sign-in note", "Host install failure", "Host Muse unavailable reason", "Host sign-in failure",
    "Could not connect Antigravity",
  ],
};

function expectLocalized(root: HTMLElement, place: keyof typeof english) {
  expect(root.closest("[hidden]"), `hidden surface: ${root.id || root.className}`).toBeNull();
  const allow = new Set(english[place]);
  const untranslated: string[] = [];
  // A whole sentence can span a link or <strong>. Keep the text depth across
  // nodes, and track attributes separately because they are independent labels.
  let textDepth = 0;
  const check = (value: string, start: number, where: string) => {
    let depth = start;
    const parts: string[] = [];
    for (const part of value.split(/([⟦⟧])/)) {
      if (part === "⟦") depth++;
      else if (part === "⟧") depth--;
      else if (depth === 0) parts.push(part);
      expect(depth, where).toBeGreaterThanOrEqual(0);
    }
    for (const line of parts.join("").split("\n").map((part) => part.trim())) {
      if (/[A-Za-z]/.test(line) && !allow.has(line)) untranslated.push(`${where}: ${line}`);
    }
    return depth;
  };
  function visit(node: Element) {
    if (node.hasAttribute("hidden") || (node as HTMLElement).style?.display === "none") return;
    const name = `${node.tagName}.${node.getAttribute("class") || ""}`;
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const value = node.getAttribute(attr);
      if (value) expect(check(value, 0, `${name} ${attr}`)).toBe(0);
    }
    for (const child of node.childNodes) {
      if (child.nodeType === 1) visit(child as Element);
      if (child.nodeType === 3) textDepth = check(child.textContent || "", textDepth, name);
    }
  }
  visit(root);
  expect(textDepth).toBe(0);
  expect.soft(untranslated, `${place} / ${root.id || root.className}`).toEqual([]);
}

it("localizes the context ledger and native-window controls while keeping their values", () => {
  const { window, doc, posted } = boot();
  const selection = { sessionId: "s", modelId: "grok-main", generation: 2, available: true,
    sizes: [256000, 500000], defaultSize: 256000, selectedSize: 256000, changing: false };
  dispatch(window, { type: "initialState", appPurpose: "coding" });
  dispatch(window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok-main",
    models: [{ modelId: "grok-main", name: "Grok", totalContextTokens: 1000000 }] });
  dispatch(window, { type: "contextWindowSelection", selection });
  dispatch(window, { type: "subscriptionUsage", windows: [] });
  click(window, el(doc, "#donut"));
  const popup = el(doc, "#context-popover");
  expectLocalized(popup, "context");
  expect(el<HTMLButtonElement>(popup, ".context-compact").disabled).toBe(true);
  dispatch(window, { type: "contextUsage", used: 320000, window: 1000000, autoCompact: { source: "agent", tokens: 800000 },
    systemPromptTokens: 2000, toolDefinitionsTokens: 3000, toolDefinitionsCount: 1,
    messageTokens: 288000, freeTokens: 6000, categories: [{ label: "Tool category", detail: "advertised detail", tokens: 4000 }] });
  const usage = { inputTokens: 30000, cachedReadTokens: 2000, cachedWriteTokens: 3000,
    outputTokens: 6000, reasoningTokens: 4000, costUsdTicks: 100000000, modelCalls: 2 };
  dispatch(window, { type: "usage", turn: usage, session: usage });
  dispatch(window, { type: "subscriptionUsage", windows: [{
    label: "Weekly limit", usedPercent: 40, observedAt: new Date().toISOString(),
    periodType: "week", periodEnd: new Date(Date.now() + 86400000).toISOString(),
  }] });
  for (const fold of ["counted", "session", "lastTurn"]) click(window, el(popup, `[data-fold="${fold}"]`));
  expectLocalized(popup, "context");
  expect(el(popup, ".popover-info-sub span").textContent).toBe(`↳ ${pseudo("cache read")}`);
  expect(popup.textContent).toContain("Weekly limit");
  expect(popup.textContent).toContain("Tool category (advertised detail)");
  expect(popup.textContent).toContain(pseudo("Tool definitions (1 tool)"));
  const select = el<HTMLSelectElement>(popup, "#context-window-select");
  expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
    ["256000", pseudo("256K · CLI default · will compact")], ["500000", "500K"],
  ]);
  dispatch(window, { type: "contextUsage", used: 320000 });
  expect(el(popup, "#context-window-select")).toBe(select);
  select.value = "500000";
  select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  expect(posted).toContainEqual({ type: "setContextWindow", sessionId: "s", modelId: "grok-main", generation: 2, size: 500000 });
  for (const change of [{ changing: true }, { stale: true }, { available: false }, { available: false, reason: "Host selection reason" }]) {
    dispatch(window, { type: "contextWindowSelection", selection: { ...selection, ...change } });
    expectLocalized(popup, "context");
  }
  click(window, el(popup, ".context-compact"));
  expect(posted.at(-1)).toEqual({ type: "send", text: "/compact", bare: true });
});

it("localizes the editable, pending and locked DeepSeek harness control", () => {
  const { window, doc, posted } = boot();
  const identity = { sessionId: "s", modelId: "deepseek-main", generation: 2 };
  dispatch(window, { type: "providerState", providers: [{ id: "deepseek", connected: true }] });
  dispatch(window, { type: "session", sessionId: "s", provider: "deepseek", currentModelId: identity.modelId,
    models: [{ modelId: identity.modelId, name: "DeepSeek", totalContextTokens: 1000000 }] });
  const mode = { type: "modeChanged", modeId: "agent", modes: ["agent", "yolo"],
    deepseekHarness: "default", deepseekHarnessContext: identity };
  dispatch(window, mode);
  dispatch(window, { type: "contextUsage", used: 40000, window: 1000000 });
  click(window, el(doc, "#donut"));
  const popup = el(doc, "#context-popover");
  expectLocalized(popup, "context");
  const select = el<HTMLSelectElement>(popup, "#deepseek-harness");
  expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
    ["default", "Default"], ["minimal", "Minimal"],
  ]);
  select.value = "minimal";
  select.dispatchEvent(new window.Event("change") as unknown as Event);
  expect(posted.at(-1)).toEqual({ type: "setDeepSeekHarness", ...identity, harness: "minimal", draftId: expect.any(String) });
  expectLocalized(popup, "context");
  dispatch(window, { ...mode, deepseekHarnessLocked: true });
  expect(el<HTMLSelectElement>(popup, "#deepseek-harness").disabled).toBe(true);
  expectLocalized(popup, "context");
});

const locales = [null, strings] as const;
const sameMessages = (a: Posted[], b: Posted[]) => expect(JSON.stringify(b)).toBe(JSON.stringify(a));

it("localizes live, permission and historical plan cards while preserving every action", () => {
  const verdicts = ["approved", "rejected", "abandoned"] as const;
  const verdictLabels = ["Approved", "Rejected", "Cancelled"];
  const options = [
    { optionId: "allow", kind: "allow_once", name: "Approve edits" },
    { optionId: "auto", kind: "allow_always", name: "Auto-approve edits" },
    { optionId: "deny", kind: "reject_once", name: "Keep planning" },
  ];
  const [englishRun, pseudoRun] = locales.map((bundle) => {
    const { window, doc, posted } = boot(bundle);
    const scan = (card: HTMLElement) => { if (bundle) expectLocalized(card, "plan"); };
    for (const [i, verdict] of verdicts.entries()) {
      const id = i + 1;
      dispatch(window, { type: "exitPlanRequest", req: { id, plan: i ? "Agent plan" : "" } });
      const card = el(doc, `[data-plan-req-id="${id}"]`);
      scan(card);
      el<HTMLTextAreaElement>(card, ".plan-feedback").value = " comment & <verbatim> ";
      click(window, el(card, `[data-verdict="${verdict}"]`));
      expect(posted.at(-1)).toEqual({ type: "exitPlanAnswer", requestId: id, verdict, comment: "comment & <verbatim>" });
      expect(el(card, ".plan-verdict-label").textContent).toBe(bundle ? pseudo(verdictLabels[i]) : verdictLabels[i]);
      scan(card);
      const toggle = el(card, ".plan-toggle");
      const before = posted.length;
      click(window, toggle);
      scan(card);
      click(window, toggle);
      expect(posted).toHaveLength(before);
    }
    dispatch(window, { type: "exitPlanRequest", req: { id: 4, plan: "Agent plan", planName: "plan.md", planPath: "/tmp/plan.md" } });
    const planWithFile = el(doc, '[data-plan-req-id="4"]');
    scan(planWithFile);
    click(window, el(planWithFile, ".plan-file-link"));
    expect(posted.at(-1)).toEqual({ type: "openFile", path: "/tmp/plan.md" });
    for (const plan of ["", "Agent plan"]) for (const [i, option] of options.entries()) {
      const id = 10 + i;
      dispatch(window, { type: "permissionRequest", req: { id, options, plan, toolCall: { kind: "switch_mode" } } });
      const card = el(doc, `.plan.permission[data-perm-req-id="${id}"]`);
      scan(card);
      const buttons = [...card.querySelectorAll(".card-actions button")];
      expect(buttons.map((button) => button.textContent)).toEqual(options.map((item) => item.name));
      click(window, buttons[i]);
      expect(posted.filter((message) => message.type === "permissionAnswer").at(-1))
        .toEqual({ type: "permissionAnswer", requestId: id, optionId: option.optionId });
      scan(card);
    }
    dispatch(window, { type: "planHistoryQueue", plans: [...verdicts, undefined].map((verdict) => ({ verdict, text: "Agent plan" })) });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "historyReplay", active: false });
    const history = [...doc.querySelectorAll<HTMLElement>(".plan-history")];
    expect(history).toHaveLength(4);
    for (const card of history) {
      scan(card);
      click(window, el(card, ".plan-toggle"));
      scan(card);
    }
    return posted;
  });
  sameMessages(englishRun, pseudoRun);
});

it("localizes live and restored questions while preserving answers, skips and recovered drafts", () => {
  const question = "Pick a color?";
  const options = [{ label: "Blue", description: "A cool color" }, { label: "Red" }];
  const draft = "   Keep <this> & this spacing.  ";
  const [englishRun, pseudoRun] = locales.map((bundle) => {
    const { window, doc, posted } = boot(bundle);
    const scan = (card: HTMLElement) => { if (bundle) expectLocalized(card, "question"); };
    const open = (id: number, multiSelect = false, hostOther = false) => {
      dispatch(window, { type: "questionRequest", req: { id, questions: [{
        question, options: hostOther ? [...options, { label: "Other" }] : options, multiSelect,
      }] } });
      const card = el(doc, `[data-question-req-id="${id}"]`);
      scan(card);
      return { card, choices: [...card.querySelectorAll(".question-option")] };
    };
    for (const [i, option] of options.entries()) {
      const id = i + 1;
      const { card, choices } = open(id);
      click(window, choices[i]);
      expect(posted.at(-1)).toEqual({ type: "questionAnswer", requestId: id, answers: { [question]: option.label }, annotations: {} });
      scan(card);
      dispatch(window, { type: "questionResolved", requestId: id, outcome: "accepted" });
      scan(card);
    }
    for (const hostOther of [false, true]) {
      const id = hostOther ? 4 : 3;
      const { card, choices } = open(id, true, hostOther);
      for (const i of [0, 1, 1, 2, 2, 2]) click(window, choices[i]);
      expect(el(choices[2], ".question-option-label").textContent)
        .toBe(bundle && !hostOther ? pseudo("Other") : "Other");
      const custom = el<HTMLTextAreaElement>(card, ".question-other-input");
      expect(custom.hidden).toBe(false);
      scan(card);
      custom.value = draft;
      custom.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      click(window, el(card, ".card-actions button"));
      expect(posted.at(-1)).toEqual({ type: "questionAnswer", requestId: id, answers: { [question]: `Blue, ${draft.trim()}` }, annotations: {} });
      scan(card);
    }
    for (const withDraft of [false, true]) {
      const id = withDraft ? 6 : 5;
      const { card, choices } = open(id, true);
      if (withDraft) {
        click(window, choices[2]);
        const custom = el<HTMLTextAreaElement>(card, ".question-other-input");
        custom.value = draft;
        custom.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      }
      click(window, el(card, ".question-skip"));
      expect(posted.at(-1)).toEqual({ type: "questionCancel", requestId: id });
      scan(card);
      dispatch(window, { type: "questionResolved", requestId: id, outcome: "stale" });
      scan(card);
      const recovery = el<HTMLButtonElement>(card, ".question-recover");
      expect(recovery.disabled).toBe(!withDraft);
      if (withDraft) {
        click(window, recovery);
        expect(el<HTMLTextAreaElement>(doc, "#input").value).toBe(`${question}\n${draft}`);
      }
    }
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "toolCall", call: { toolCallId: "restored", title: "ask_user_question",
      rawInput: { questions: [{ question, options }] } } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "restored", status: "completed",
      content: [{ type: "content", content: { type: "text", text: `User has answered your questions: "${question}"="Red"` } }] } });
    dispatch(window, { type: "historyReplay", active: false });
    const restored = el(doc, ".card.question.resolved:not([data-question-req-id])");
    scan(restored);
    expect(el(restored, ".question-answer").textContent).toBe(bundle ? pseudo("✓ Red") : "✓ Red");
    return posted;
  });
  sameMessages(englishRun, pseudoRun);
});

function settleWelcome(h: Harness) {
  dispatch(h.window, { type: "initialized", info: { provider: "grok", version: "1.0.5" } });
  dispatch(h.window, { type: "setBusy", value: false });
}

it("localizes all IDE welcome tips, including their action and dismiss affordances", () => {
  const h = boot();
  const { window, doc, posted } = h;
  dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: { moveViewHint: true } });
  dispatch(window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
  dispatch(window, { type: "remoteStatus", linked: false });
  dispatch(window, { type: "voiceConfigured", value: false });
  dispatch(window, { type: "welcomeTips", routineCount: 0, connectorCount: 0, dismissed: [], shownToday: [] });
  settleWelcome(h);
  const move = el(doc, '#welcome-tip[data-tip="moveView"]');
  expectLocalized(move, "tips");
  click(window, el(move, "#welcome-tip-link"));
  expect(posted).toContainEqual({ type: "moveView", location: "pick" });
  dispatch(window, { type: "moveViewHint", value: false });
  for (const id of ["providers", "routines", "connectors", "remote", "readAloud", "voice", "mentions", "worktrees", "dragShift", "pasteScreenshot"]) {
    const tip = el(doc, `#welcome-tip[data-tip="${id}"]`);
    expectLocalized(tip, "tips");
    expect(posted).toContainEqual({ type: "welcomeTipShown", id });
    click(window, el(tip, ".welcome-tip-dismiss"));
  }
  expect(doc.querySelector("#welcome-tip")).toBeNull();
});

it("paints a translated welcome sentence even when it loses its action marker", () => {
  const key = "Grok isn’t your only agent. {Connect Codex or Claude Code} and pick one per conversation.";
  const sentence = pseudo("Learn about agents <here> & keep working.");
  const h = boot({ ...strings, [key]: sentence });
  dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
  settleWelcome(h);
  const tip = el(h.doc, '#welcome-tip[data-tip="providers"]');
  expectLocalized(tip, "tips");
  expect(el(tip, ".welcome-tip-body").textContent).toBe(sentence);
  expect(tip.querySelector(".welcome-tip-body [role=button], .welcome-tip-body here")).toBeNull();
});

it("localizes the Codex update offer and confirmation and shows host progress verbatim", async () => {
  const { window, doc, posted } = boot();
  const codex = { id: "codex", connected: true, cliVersion: "0.149.0", latestCliVersion: "0.153.4", updateAvailable: true };
  dispatch(window, { type: "session", provider: "codex", models: [] });
  dispatch(window, { type: "providerState", providers: [{ ...codex, cliUpdate: { status: "idle" } }] });
  const offer = el(doc, "#welcome-codex-update");
  expectLocalized(offer, "tips");
  expect(offer.textContent).toContain(pseudo("Codex CLI v0.149.0 is older than v0.153.4, the version included with this app. Update to discover newer models."));
  click(window, el(offer, "button"));
  const dialog = el(doc, ".confirm-overlay");
  expectLocalized(dialog, "tips");
  click(window, [...dialog.querySelectorAll("button")].find((button) => button.textContent === pseudo("Update Codex CLI"))!);
  await Promise.resolve();
  expect(posted).toContainEqual({ type: "updateCodex" });
  dispatch(window, { type: "providerState", providers: [{ ...codex, cliUpdate: { status: "running", message: "Host updater progress" } }] });
  const progress = el(doc, "#welcome-codex-update");
  expectLocalized(progress, "tips");
  expect(progress.textContent).toBe("Host updater progress");
});

const providers = ["grok", "codex", "claude", "muse", "deepseek", "agy"];

it("localizes the IDE agent grid, missing CLIs, terminal sign-in and connected panels", () => {
  const { window, doc, posted } = boot();
  dispatch(window, { type: "initialState", capabilities: { installMuse: true, remoteAgentSignIn: true } });
  dispatch(window, { type: "providerState", providers: providers.map((id) => ({ id, connected: false })) });
  const panel = el(doc, "#welcome-onboarding");
  const show = (state: string, fields = {}) => {
    dispatch(window, { type: "onboarding", state, platform: "win32", ...fields });
    expect(panel.childElementCount).toBeGreaterThan(0);
    expectLocalized(panel, "onboarding");
  };
  show("connect-agent");
  expect([...panel.querySelectorAll<HTMLElement>(".onb-agent-tile")].map((tile) => tile.dataset.provider)).toEqual(providers);
  expect(el(doc, "#welcome-version").textContent).toBe("Connect an agent");
  click(window, el(panel, '[data-provider="grok"]'));
  expect(posted).toContainEqual({ type: "runGrokLogin", provider: "grok" });
  expectLocalized(panel, "onboarding");
  for (const mode of ["missing-cli", "missing-codex", "missing-claude", "codex-login", "claude-login", "auth-required", "missing-muse", "muse-login", "no-project"]) {
    show(mode);
  }
  expect(el(doc, "#welcome-version").textContent).toBe("No project folder");
  for (const provider of providers) {
    show("provider-connected", { provider });
    expect(el(panel, ".onb-heading").textContent).toBe(pseudo("Connected"));
    expect(el(doc, "#welcome-version").textContent).toBe("Connected");
  }
});

it("localizes managed install progress in each IDE panel and preserves host reasons", () => {
  for (const [provider, mode, progressType, label] of [
    ["codex", "missing-codex", "codexInstallProgress", "Downloading Codex (25%)..."],
    ["deepseek", "missing-deepseek", "agyInstallProgress", "Downloading DeepSeek (25%)"],
    ["agy", "missing-agy", "agyInstallProgress", "Downloading Antigravity (25%)"],
  ]) {
    const { window, doc } = boot();
    dispatch(window, { type: "providerState", providers: [{ id: provider, connected: false }] });
    dispatch(window, { type: "onboarding", state: mode, provider, reason: "Host install failure" });
    const panel = el(doc, "#welcome-onboarding");
    expectLocalized(panel, "onboarding");
    expect(el(panel, ".onb-install-error").textContent).toBe("Host install failure");
    for (const phase of ["downloading", "verifying", "installing"]) {
      dispatch(window, { type: progressType, provider, phase, receivedBytes: 25, totalBytes: 100 });
      expectLocalized(panel, "onboarding");
      if (phase === "downloading") expect(el(panel, ".onb-install-progress").textContent).toContain(pseudo(label));
    }
  }
  const { window, doc } = boot();
  dispatch(window, { type: "providerState", providers: [{ id: "agy", connected: false, agyCli: { installing: true } }] });
  dispatch(window, { type: "onboarding", state: "missing-agy", provider: "agy" });
  const panel = el(doc, "#welcome-onboarding");
  expectLocalized(panel, "onboarding");
  expect(el(panel, "progress").getAttribute("aria-label")).toBe(pseudo("Installing the Antigravity CLI"));
});

it("localizes DeepSeek's key choices and the IDE's Muse and Antigravity sign-in flows", () => {
  const { window, doc } = boot();
  dispatch(window, { type: "initialState", capabilities: { remoteAgentSignIn: true } });
  const panel = el(doc, "#welcome-onboarding");
  const wizard = () => el(doc, ".connect-wizard-panel");
  const closeWizard = () => click(window, el(wizard(), ".confirm-btn"));
  for (const keySource of [undefined, "saved", "environment"]) {
    dispatch(window, { type: "providerState", providers: [{ id: "deepseek", connected: false, keySource }] });
    dispatch(window, { type: "onboarding", state: "deepseek-login", provider: "deepseek" });
    expectLocalized(panel, "onboarding");
    expectLocalized(wizard(), "onboarding");
    closeWizard();
  }
  dispatch(window, { type: "providerState", providers: [
    { id: "agy", connected: false, savedSignIns: ["google", "api-key"], signInMethod: "api-key" },
    { id: "muse", connected: true },
  ] });
  dispatch(window, { type: "onboarding", state: "agy-login", provider: "agy", agyChoice: true });
  expectLocalized(wizard(), "onboarding");
  expect(el(wizard(), 'a[href="https://aistudio.google.com/api-keys"]').textContent).toBe(pseudo("get one in AI Studio"));
  for (const status of ["starting", "waiting", "verifying", "done", "failed"]) {
    dispatch(window, { type: "onboarding", state: "agy-login", provider: "agy", device: {
      status, url: "https://accounts.google.com/signin", note: "Host sign-in note",
      ...(status === "failed" ? { message: "Host sign-in failure" } : {}),
    } });
    expectLocalized(panel, "onboarding");
    expectLocalized(wizard(), "onboarding");
  }
  closeWizard();
  dispatch(window, { type: "onboarding", state: "muse-login", provider: "muse" });
  expectLocalized(panel, "onboarding");
  dispatch(window, { type: "onboarding", state: "muse-login", provider: "muse", device: {
    status: "waiting", url: "https://www.meta.com/device", code: "ADAPTER-CODE",
  } });
  expectLocalized(panel, "onboarding");
  expectLocalized(wizard(), "onboarding");
  expect(el(wizard(), ".onb-cmd code").textContent).toBe("ADAPTER-CODE");
  closeWizard();
  dispatch(window, { type: "providerState", providers: [{ id: "muse", connected: false, unavailableReason: "Host Muse unavailable reason" }] });
  dispatch(window, { type: "onboarding", state: "muse-login", provider: "muse" });
  expectLocalized(panel, "onboarding");
});

it("escapes translated onboarding attributes and restores only our markup in sentences", () => {
  const label = '⟦Copy " <i> &⟧';
  const sentence = '⟦<i> & {0}⟧';
  const { window, doc } = boot({ ...strings, Copy: label, "Open terminal & run {0}": sentence });
  dispatch(window, { type: "onboarding", state: "auth-required", provider: "grok" });
  const panel = el(doc, "#welcome-onboarding");
  expectLocalized(panel, "onboarding");
  expect(el(panel, ".onb-copy").title).toBe(label);
  const login = el(panel, '[data-act="runLogin"]');
  expect(login.textContent).toBe("⟦<i> & grok login⟧");
  expect(login.querySelector("i")).toBeNull();
  expect(el(login, "code").textContent).toBe("grok login");
});
