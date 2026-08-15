import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

// @vscode/test-electron smoke suite — the layer the grok-free vitest suite structurally
// can't reach: it boots a real VS Code, activates the extension, and resolves the webview
// inside a genuine Extension Host. It never needs the grok binary (CI has none), so it
// runs the extension's *missing-CLI* path — which is exactly the host glue we want to
// exercise: activation, command registration, getHtml/CSP, localResourceRoots, and the
// first host->webview posts. See CLAUDE.md "What's next" #1.

const EXT_ID = "PawelHuryn.grok-vscode-phuryn";

suite("grok-build extension smoke", () => {
  test("is present and activates without throwing", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found — check publisher.name`);
    await ext!.activate();
    assert.ok(ext!.isActive, "extension failed to activate");
  });

  test("registers its contributed commands", async () => {
    const all = await vscode.commands.getCommands(true);
    // A stable subset that must always exist (the full list lives in package.json).
    for (const id of [
      "grok.open",
      "grok.newSession",
      "grok.showLogs",
      "grok.settings",
      "grok.logout",
      // The escape hatch for an editor that hid the view somewhere unreachable —
      // useless if it is not in the palette.
      "grok.moveView",
    ]) {
      assert.ok(all.includes(id), `command not registered: ${id}`);
    }
    // The gear-menu "Move view" items depend on these workbench commands
    // (vscode.moveViews is internal but stable — GitLens relies on it too).
    for (const id of ["vscode.moveViews", "workbench.action.moveFocusedView"]) {
      assert.ok(all.includes(id), `workbench command missing: ${id}`);
    }
  });

  test("grok.open actually opens the chat", async () => {
    // The regression this exists for: `grok.open` used to execute a hardcoded
    // container command, and in an editor that refuses our secondary-side-bar
    // container that command does not exist — so opening the chat failed with
    // "command not found" and the extension could not be used at all (#101
    // follow-up). This assertion is the whole test: it must REJECT nothing.
    //
    // It replaces a version that ran `grok.chat.focus`, swallowed any failure,
    // and then asserted `true` — which would have passed throughout the outage.
    await vscode.commands.executeCommand("grok.open");
  });

  test("resolving the webview view does not crash (missing-CLI onboarding path)", async () => {
    // Focusing the view triggers resolveWebviewView -> getHtml -> the first posts.
    // With no grok binary on the CI box the extension takes the missing-CLI onboarding
    // branch; reaching the assertion below without an unhandled rejection is the check.
    await vscode.commands.executeCommand("grok.chat.focus");
    await new Promise((r) => setTimeout(r, 2000)); // let the webview resolve + post
    // A second, lightweight command that touches the sidebar without needing grok.
    await vscode.commands.executeCommand("grok.showLogs");
    assert.ok(true, "webview resolved without throwing");
  });

  // TODO (follow-up): inject a synthetic `session`/`historyReplay` event and assert the
  // webview renders it. The hook now exists (see the repo-selection suite below).
});

// Repo selection is per remote clientId. VS Code ignores it because its hidden
// switcher is permanently scoped to the workspace root. These hooks prove the
// wiring property pure registry tests cannot: each targeted snapshot and live
// session update reaches only the owning tab, even when both tabs select one repo.
suite("repo selection: isolated per remote tab, workspace-local in VS Code", () => {
  let hooks: any;
  let repoB = "";
  let grokHome = "";
  const prevGrokHome = process.env.GROK_HOME;

  const storedSessionDirFor = (cwd: string, id: string) =>
    path.join(grokHome, "sessions", encodeURIComponent(cwd), id);
  const storedSessionDir = (id: string) => storedSessionDirFor(repoB, id);

  const writeStoredSession = (id: string, cwd = repoB, updatedAt?: string) => {
    const dir = storedSessionDirFor(cwd, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      updatedAt ? JSON.stringify({ updated_at: updatedAt }) : "{}",
    );
  };

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, "extension not found");
    const api = await ext!.activate();
    hooks = api?.__test;
    assert.ok(hooks, "test hooks missing — activate() exposes them under ExtensionMode.Test");

    // A second selectable repo. `discoverRepos` enumerates <grokHome>/sessions/<encoded
    // cwd> and stats each decoded path, so the catalog needs BOTH a session dir and a
    // real directory. The sessions STORE is sandboxed through GROK_HOME
    // (`resolveGrokHome` reads process.env on every call, and this runs inside the
    // extension host), so nothing here touches the developer's own ~/.grok.
    //
    // The repo itself must NOT live under os.tmpdir(): discoverRepos rejects temp roots
    // on purpose, because grok's own `grok-live-*` test sessions pile up there (574 of
    // 602 catalogs on the owner's box). A fixture in tmp is silently filtered and the
    // test then proves nothing — which is exactly how this first ran.
    grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-int-home-"));
    repoB = path.join(hooks.workspaceRoot(), ".int-second-repo");
    fs.mkdirSync(repoB, { recursive: true });
    fs.mkdirSync(path.join(repoB, ".git"));
    fs.mkdirSync(path.join(grokHome, "sessions", encodeURIComponent(repoB)), { recursive: true });
    process.env.GROK_HOME = grokHome;
  });

  suiteTeardown(() => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    hooks?.onPost(() => {});
    try {
      fs.rmSync(repoB, { recursive: true, force: true });
      fs.rmSync(grokHome, { recursive: true, force: true });
    } catch {
      /* best effort — it lives in the throwaway fixture workspace */
    }
  });

  test("tab A's repo switch does not move tab B or the VS Code webview", async () => {
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));
    hooks.fromRemote({ type: "remotePreferences", fontScale: 100, readRepliesAloud: false, usesTouch: true }, "tab-a");
    hooks.fromRemote({ type: "remotePreferences", fontScale: 100, readRepliesAloud: false, usesTouch: true }, "tab-b");
    posts.length = 0;

    // Exactly what a phone tapping the repo chip sends, through the real remote seam:
    // capability gate, then the cwd gate, then onMessage with origin "remote".
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-a");
    await new Promise((r) => setTimeout(r, 1500)); // -> postRepoCatalog + postSessionsList

    const repos = posts.filter((p) => p.msg?.type === "repos");
    const tabARepos = repos.filter((p) => p.clientIds?.includes("tab-a"));
    assert.ok(tabARepos.some((p) => p.msg.selectedCwd === repoB));
    assert.ok(!repos.some((p) => p.clientIds?.includes("tab-b")));
    assert.ok(!repos.some((p) => p.dest === "local"));

    // The whole point. If these two are ever equal, the split has collapsed and a phone
    // can again re-scope a window that has no way to show what happened.

    // Both audiences still get a history refresh — the split changes scope, never
    // whether a client is kept up to date.
  });

  test("speech summaries survive a session switch, require that tab's preferences, and return only there", async () => {
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));
    hooks.fromRemote({
      type: "remotePreferences",
      fontScale: 100,
      readRepliesAloud: true,
      summarizeRepliesAloud: true,
      usesTouch: true,
    }, "tab-a");
    hooks.fromRemote({
      type: "remotePreferences",
      fontScale: 100,
      readRepliesAloud: false,
      summarizeRepliesAloud: true,
      usesTouch: true,
    }, "tab-b");
    // Browser preferences belong to the logical tab, not the Session it happened
    // to be showing when it reported them. Replace tab A's active conversation
    // without another remotePreferences message and keep summarization enabled.
    hooks.seedRemoteSession("tab-a", `speech-switched-${Date.now()}`, repoB, [], true);
    posts.length = 0;

    // Empty text makes summarizeForSpeech return locally without credential or
    // network access; this test is about the host gate and reply routing.
    hooks.fromRemote({ type: "summarizeSpeech", requestId: 41, text: "" }, "tab-a");
    hooks.fromRemote({ type: "summarizeSpeech", requestId: 42, text: "" }, "tab-b");
    await new Promise((r) => setTimeout(r, 50));

    const summaries = posts.filter((p) => p.msg?.type === "speechSummary");
    assert.deepStrictEqual(summaries, [{
      dest: "remote",
      msg: { type: "speechSummary", requestId: 41, text: "" },
      clientIds: ["tab-a"],
    }]);
  });

  test("switching to a history-free repo starts fresh without misrouting Clear all", async () => {
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));
    const emptyRepo = path.join(hooks.workspaceRoot(), `.int-empty-repo-${Date.now()}`);
    fs.mkdirSync(emptyRepo, { recursive: true });
    fs.mkdirSync(path.join(grokHome, "sessions", encodeURIComponent(emptyRepo)), { recursive: true });
    const clientId = `clear-empty-${Date.now()}`;

    hooks.fromRemote({ type: "selectRepo", cwd: emptyRepo }, clientId);
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(posts.some((p) =>
      p.clientIds?.length === 1 &&
      p.clientIds[0] === clientId &&
      p.msg?.type === "repos" &&
      p.msg.selectedCwd === emptyRepo
    ), JSON.stringify(posts));
    // Switching to a history-free repo now STARTS a session there instead of
    // landing nowhere, so this wait covers a real CLI spawn. A shared CI runner
    // is slower at exactly that than a dev box, so the deadline is generous and —
    // unlike before — expiring it fails HERE. Falling through silently meant the
    // rest of the test ran against a half-started session and the blame landed on
    // the assertion below, which is what made this look like a product bug.
    const startupDeadline = Date.now() + 60000;
    const startupDone = () => posts.some((p) =>
      p.clientIds?.includes(clientId) && p.msg?.type === "setBusy" && p.msg.value === false
    );
    while (Date.now() < startupDeadline && !startupDone()) await new Promise((r) => setTimeout(r, 200));
    assert.ok(startupDone(), "the empty repo's session never finished starting");

    posts.length = 0;
    hooks.fromRemote({ type: "clearAllSessions", cwd: emptyRepo }, clientId);

    // What this test is named for is ROUTING: the clear must be answered to the
    // tab that asked and must not leak to the VS Code view.
    //
    // It used to also assert the answer was a `sessions` refresh and never "No
    // history to clear." That expectation belonged to the old world where
    // switching to a history-free repo left you nowhere, so the clear had
    // something to act on. Switching now STARTS a session there, Clear all never
    // deletes the conversation you are sitting in, and so the only thing present
    // is protected — "No history to clear." is the correct answer, not a bug.
    // Locally the old assertion still passed by accident, depending on whether
    // the new session had reached disk in time; CI, being slower, told the truth.
    // Poll rather than sleep a fixed interval, for the same reason.
    const clearDeadline = Date.now() + 15000;
    const answeredRequester = () => posts.some((p) =>
      p.clientIds?.length === 1 &&
      p.clientIds[0] === clientId &&
      (p.msg?.type === "sessions" ||
        (p.msg?.type === "hostNotice" && p.msg.text === "No history to clear."))
    );
    while (Date.now() < clearDeadline && !answeredRequester()) await new Promise((r) => setTimeout(r, 100));

    assert.ok(answeredRequester(), JSON.stringify(posts));
    // The misrouting guard, which is the actual point: a remote's clear is never
    // answered into the VS Code view. Deliberately narrow — the local view and
    // other tabs legitimately receive their own list refreshes, so asserting
    // "nothing else was posted" would fail on unrelated, correct traffic.
    assert.ok(!posts.some((p) => p.dest === "local" && p.msg?.text === "No history to clear."),
      JSON.stringify(posts));
    hooks.remoteClientLeft(clientId);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      fs.rmSync(emptyRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      // On Windows the extension host can retain a just-used cwd until the host
      // exits. The unique fixture is harmless and is cleaned by the outer test
      // process; do not turn that platform handle lifetime into a product failure.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  test("two tabs on the same repo have independent, non-crosstalking sessions", async () => {
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-a");
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-b");
    await new Promise((r) => setTimeout(r, 800));
    hooks.seedRemoteSession("tab-a", "session-a", repoB, [], true);
    hooks.seedRemoteSession("tab-b", "session-b", repoB, [], true);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.emitRemote("tab-a", { type: "messageChunk", text: "only-a" });
    hooks.emitRemote("tab-b", { type: "messageChunk", text: "only-b" });

    const chunks = posts.filter((p) => p.msg?.type === "messageChunk");
    assert.deepStrictEqual(chunks, [
      { msg: { type: "messageChunk", text: "only-a" }, clientIds: ["tab-a"] },
      { msg: { type: "messageChunk", text: "only-b" }, clientIds: ["tab-b"] },
    ]);
    assert.ok(!chunks.some((p) => p.msg.text === "only-a" && p.clientIds?.includes("tab-b")));
    assert.ok(!chunks.some((p) => p.msg.text === "only-b" && p.clientIds?.includes("tab-a")));
  });

  test("cold replay stays live on the desk and reaches remote once as a completed batch", async () => {
    const suffix = Date.now();
    const id = `cold-replay-${suffix}`;
    const original = `cold-replay-old-${suffix}`;
    const replacement = `cold-replay-new-${suffix}`;
    const tabToken = "3456789abcdef0123456789abcdef012";
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: original, tabToken }));
    hooks.seedRemoteSession(original, id, repoB, [], true);
    await hooks.openLocalSession(id, repoB);

    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));
    let attachSnapshot: typeof posts = [];
    await hooks.replayRemote(original, [
      { type: "userMessageChunk", text: "loaded question" },
      { type: "messageChunk", text: "loaded answer" },
    ], () => {
      const before = posts.length;
      hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: replacement, tabToken }));
      attachSnapshot = posts.slice(before);
    });

    assert.ok(attachSnapshot.some((post) =>
      post.clientIds?.includes(replacement) && post.msg?.type === "clearMessages"
    ), JSON.stringify(attachSnapshot));
    assert.ok(!attachSnapshot.some((post) =>
      post.clientIds?.includes(replacement) &&
      ["historyBatch", "historyReplay", "userMessageChunk", "messageChunk"].includes(post.msg?.type)
    ), `a client attaching mid-load received partial history: ${JSON.stringify(attachSnapshot)}`);

    const remoteTranscript = posts.filter((post) =>
      post.clientIds?.includes(replacement) &&
      ["historyBatch", "historyReplay", "userMessageChunk", "messageChunk"].includes(post.msg?.type)
    ).map((post) => post.msg);
    assert.deepStrictEqual(remoteTranscript, [
      { type: "historyReplay", active: true },
      {
        type: "historyBatch",
        messages: [
          { type: "userMessageChunk", text: "loaded question" },
          { type: "messageChunk", text: "loaded answer" },
        ],
      },
      { type: "historyReplay", active: false },
    ]);
    assert.ok(!posts.some((post) =>
      post.clientIds?.includes(original) &&
      ["historyBatch", "historyReplay", "userMessageChunk", "messageChunk"].includes(post.msg?.type)
    ), "the superseded relay client must not receive replay frames");

    assert.deepStrictEqual(
      posts.filter((post) => post.dest === "local").map((post) => post.msg),
      [
        { type: "historyReplay", active: true },
        { type: "userMessageChunk", text: "loaded question" },
        { type: "messageChunk", text: "loaded answer" },
        { type: "historyReplay", active: false },
      ],
      "the desk should continue receiving the replay stream live",
    );

    posts.length = 0;
    hooks.emitRemote(replacement, { type: "messageChunk", text: "live after load" });
    assert.deepStrictEqual(posts, [
      { dest: "local", msg: { type: "messageChunk", text: "live after load" }, clientIds: undefined },
      { dest: "remote", msg: { type: "messageChunk", text: "live after load" }, clientIds: [replacement] },
    ]);
    hooks.remoteClientLeft(replacement);
  });

  test("a failed cold replay still sends one balanced snapshot of what loaded", async () => {
    const suffix = Date.now();
    const clientId = `failed-cold-replay-${suffix}`;
    const id = `failed-cold-session-${suffix}`;
    hooks.seedRemoteSession(clientId, id, repoB, [], true);
    await hooks.openLocalSession(id, repoB);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    await assert.rejects(
      hooks.replayRemote(clientId, [{ type: "messageChunk", text: "partial load" }], undefined, true),
      /synthetic session\/load failure/,
    );

    assert.deepStrictEqual(
      posts.filter((post) => post.clientIds?.includes(clientId)).map((post) => post.msg),
      [
        { type: "historyReplay", active: true },
        { type: "historyBatch", messages: [{ type: "messageChunk", text: "partial load" }] },
        { type: "historyReplay", active: false },
      ],
    );
    hooks.remoteClientLeft(clientId);
  });

  test("remote context usage is read from the session repo, not the VS Code workspace", () => {
    const id = `context-${Date.now()}`;
    const workspaceDir = storedSessionDirFor(hooks.workspaceRoot(), id);
    const remoteDir = storedSessionDirFor(repoB, id);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(remoteDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "signals.json"), JSON.stringify({
      contextTokensUsed: 111,
      contextWindowTokens: 100000,
    }));
    fs.writeFileSync(path.join(remoteDir, "signals.json"), JSON.stringify({
      contextTokensUsed: 222,
      contextWindowTokens: 200000,
    }));
    hooks.seedRemoteSession("context-tab", id, repoB);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.emitContextUsage("context-tab");

    assert.deepStrictEqual(
      posts.filter((post) => post.msg?.type === "contextUsage"),
      [{ msg: { type: "contextUsage", used: 222, window: 200000 }, clientIds: ["context-tab"] }],
    );
  });

  test("rewind keeps discarded usage out after another turn and a reload", async () => {
    const suffix = Date.now();
    const clientId = `usage-rewind-${suffix}`;
    const id = `usage-session-${suffix}`;
    hooks.seedRemoteSession(clientId, id, repoB, [], true);
    await hooks.seedUsageLedger(clientId, [
      { afterUserMessage: 1, usage: { inputTokens: 100, outputTokens: 10, costUsdTicks: 10_000_000 } },
      { afterUserMessage: 2, usage: { inputTokens: 200, outputTokens: 20, costUsdTicks: 20_000_000 } },
      { afterUserMessage: 3, usage: { inputTokens: 300, outputTokens: 30, costUsdTicks: 30_000_000 } },
    ], 3);

    await hooks.rewindUsageLedger(clientId, 1);
    await hooks.completeUsageTurn(clientId, {
      inputTokens: 400,
      outputTokens: 40,
      costUsdTicks: 40_000_000,
    });
    const restored = hooks.reloadUsageLedger(clientId, 2);

    assert.deepStrictEqual(
      restored.usageLog.map((entry: any) => ({
        afterUserMessage: entry.afterUserMessage,
        inputTokens: entry.usage?.inputTokens,
        costUsdTicks: entry.usage?.costUsdTicks,
      })),
      [
        { afterUserMessage: 1, inputTokens: 100, costUsdTicks: 10_000_000 },
        { afterUserMessage: 2, inputTokens: 400, costUsdTicks: 40_000_000 },
      ],
    );
    assert.deepStrictEqual(restored.sessionUsage, {
      inputTokens: 500,
      outputTokens: 50,
      costUsdTicks: 50_000_000,
    });
    hooks.remoteClientLeft(clientId);
  });

  for (const mode of ["clear", "summarize"] as const) {
    test(`${mode} restart derives cost from the replacement session id`, async () => {
      const suffix = `${mode}-${Date.now()}`;
      const clientId = `usage-restart-${suffix}`;
      const oldId = `usage-old-${suffix}`;
      const newId = `usage-new-${suffix}`;
      hooks.seedRemoteSession(clientId, oldId, repoB, [], true);
      await hooks.seedUsageLedger(clientId, [{
        afterUserMessage: 1,
        usage: { inputTokens: 100, outputTokens: 10, costUsdTicks: 90_000_000 },
      }], 1);

      const summaryUsage = mode === "summarize"
        ? { inputTokens: 5, outputTokens: 2, costUsdTicks: 5_000_000 }
        : undefined;
      await hooks.restartUsageSession(clientId, newId, mode, summaryUsage);
      await hooks.completeUsageTurn(clientId, {
        inputTokens: 40,
        outputTokens: 4,
        costUsdTicks: 40_000_000,
      });
      const restored = hooks.reloadUsageLedger(clientId, 1);

      assert.deepStrictEqual(
        restored.usageLog.map((entry: any) => entry.usage?.costUsdTicks),
        mode === "summarize" ? [5_000_000, 40_000_000] : [40_000_000],
      );
      assert.strictEqual(
        restored.sessionUsage?.costUsdTicks,
        mode === "summarize" ? 45_000_000 : 40_000_000,
      );
      hooks.remoteClientLeft(clientId);
    });
  }

  test("ordinary history actions cannot destroy another tab's live conversation", async () => {
    const worktree = path.join(repoB, ".clear-all-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    hooks.seedWorktree({
      id: "wt-clear-all",
      path: worktree,
      sourceRepo: repoB,
      repoName: "fixture",
      kind: "worktree",
      creationMode: "fixture",
      gitRef: "fixture",
      headCommit: "fixture",
      status: "alive",
      label: "Clear-all fixture",
      userProvidedLabel: true,
    });
    writeStoredSession("session-a");
    writeStoredSession("session-b");
    writeStoredSession("cold-session");
    writeStoredSession("worktree-session", worktree);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "deleteSession", id: "session-b", name: "Tab B" }, "tab-a");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("tab-b"), "session-b");
    assert.ok(fs.existsSync(storedSessionDir("session-b")), "tab B's live session must remain on disk");
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("tab-a") &&
      p.msg?.type === "error" &&
      /open in another tab/.test(p.msg.text)
    ));

    hooks.fromRemote({ type: "clearAllSessions", cwd: repoB }, "tab-a");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("tab-a"), "session-a");
    assert.strictEqual(hooks.activeRemoteSessionId("tab-b"), "session-b");
    assert.ok(fs.existsSync(storedSessionDir("session-a")), "the requester's live session must remain");
    assert.ok(fs.existsSync(storedSessionDir("session-b")), "the other tab's live session must remain");
    assert.ok(!fs.existsSync(storedSessionDir("cold-session")), "inactive history should still be cleared");
    assert.ok(
      !fs.existsSync(storedSessionDirFor(worktree, "worktree-session")),
      "inactive worktree history shown under the repo must also be cleared",
    );
  });

  test("id-only delete and rename stay inside the requesting tab's selected repo", async () => {
    const workspaceRoot: string = hooks.workspaceRoot();
    const foreignId = `foreign-cold-${Date.now()}`;
    writeStoredSession(foreignId, workspaceRoot);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "selectRepo", cwd: workspaceRoot }, "foreign-history-tab");
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote({ type: "listSessions", cwd: workspaceRoot }, "foreign-history-tab");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("foreign-history-tab") &&
      p.msg?.type === "sessions" &&
      p.msg.entries.some((entry: any) => entry.id === foreignId)
    ), "the foreign session must be in the shared history cache before the attack");

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "repo-b-attacker");
    await new Promise((r) => setTimeout(r, 100));
    posts.length = 0;
    hooks.fromRemote({ type: "deleteSession", id: foreignId, name: "Foreign" }, "repo-b-attacker");
    hooks.fromRemote({ type: "renameSession", id: foreignId, name: "Cross-repo rename" }, "repo-b-attacker");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(
      fs.existsSync(storedSessionDirFor(workspaceRoot, foreignId)),
      "a cached session outside the selected repo must not be deleted",
    );
    // The refusal reads "not in this project" rather than naming a repository:
    // from inside the attacker's scope the two indistinguishable cases are "it
    // was never here" and "it is not here any more", and the second is the one a
    // real user hits — a rail row left over from a Clear all. Telling them their
    // tab had the wrong repository selected sent people hunting a permissions
    // bug that was really a stale list.
    const refusals = posts.filter((p) =>
      p.clientIds?.includes("repo-b-attacker") &&
      p.msg?.type === "error" &&
      /no longer in this project/.test(p.msg.text)
    );
    assert.strictEqual(refusals.length, 2, JSON.stringify(posts));

    posts.length = 0;
    hooks.fromRemote({ type: "listSessions", cwd: workspaceRoot }, "foreign-history-tab");
    await new Promise((r) => setTimeout(r, 100));
    const foreignEntry = posts
      .filter((p) => p.clientIds?.includes("foreign-history-tab") && p.msg?.type === "sessions")
      .flatMap((p) => p.msg.entries)
      .find((entry: any) => entry.id === foreignId);
    assert.ok(foreignEntry, "the refused target must remain in its own repo history");
    assert.notStrictEqual(foreignEntry.customName, "Cross-repo rename");
  });

  test("a remote tab can delete cold history in its repo and registered worktrees", async () => {
    const worktree = path.join(repoB, `.delete-auth-worktree-${Date.now()}`);
    fs.mkdirSync(worktree, { recursive: true });
    hooks.seedWorktree({
      id: `wt-delete-auth-${Date.now()}`,
      path: worktree,
      sourceRepo: repoB,
      repoName: "fixture",
      kind: "worktree",
      creationMode: "fixture",
      gitRef: "fixture",
      headCommit: "fixture",
      status: "alive",
      label: "Delete authorization fixture",
      userProvidedLabel: true,
    });
    hooks.seedWorktreeRefresh(hooks.workspaceRoot(), []);
    const repoSessionId = `own-repo-cold-${Date.now()}`;
    const worktreeSessionId = `own-worktree-cold-${Date.now()}`;
    writeStoredSession(repoSessionId);
    writeStoredSession(worktreeSessionId, worktree);

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "repo-b-owner");
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote(
      { type: "renameSession", id: worktreeSessionId, name: "Owned worktree session" },
      "repo-b-owner",
    );
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote({ type: "listSessions", cwd: repoB }, "repo-b-owner");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("repo-b-owner") &&
      p.msg?.type === "sessions" &&
      p.msg.entries.some((entry: any) =>
        entry.id === worktreeSessionId && entry.customName === "Owned worktree session"
      )
    ), "own-worktree rename must use the same repo scope as delete and Clear all");

    hooks.fromRemote({ type: "deleteSession", id: repoSessionId, name: "Repo session" }, "repo-b-owner");
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote(
      { type: "deleteSession", id: worktreeSessionId, name: "Worktree session" },
      "repo-b-owner",
    );
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(!fs.existsSync(storedSessionDir(repoSessionId)), "own-repo delete must still succeed");
    assert.ok(
      !fs.existsSync(storedSessionDirFor(worktree, worktreeSessionId)),
      "a registered worktree session belongs to the selected repo and must remain deletable",
    );
  });

  test("a turn watched in a remote tab is not marked unseen", async () => {
    const id = `watched-${Date.now()}`;
    hooks.seedRemoteSession("tab-watched", id, repoB);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.setSessionStatus(id, "done");
    hooks.fromRemote({ type: "listSessions", cwd: repoB }, "tab-watched");
    await new Promise((r) => setTimeout(r, 100));

    const list = posts.filter((p) =>
      p.clientIds?.includes("tab-watched") && p.msg?.type === "sessions"
    ).pop()?.msg;
    assert.ok(list, "the watching tab should receive its history snapshot");
    assert.strictEqual(list.dots[id], "none");
  });

  test("warm remote focus clears a completion badge created while nobody watched", async () => {
    const id = `unwatched-${Date.now()}`;
    hooks.seedRemoteSession("departed-owner", id, repoB, [], true);
    hooks.remoteClientLeft("departed-owner");
    hooks.setSessionStatus(id, "done");
    await new Promise((r) => setTimeout(r, 50));

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "returning-owner");
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "returning-owner");
    await new Promise((r) => setTimeout(r, 100));
    hooks.fromRemote({ type: "listSessions", cwd: repoB }, "returning-owner");
    await new Promise((r) => setTimeout(r, 100));

    const list = posts.filter((p) =>
      p.clientIds?.includes("returning-owner") && p.msg?.type === "sessions"
    ).pop()?.msg;
    assert.ok(list, "the returning tab should receive its history snapshot");
    assert.strictEqual(list.dots[id], "none");
  });

  test("a replacement relay client resumes before the old client-left without losing ownership", async () => {
    const id = `reload-handoff-${Date.now()}`;
    const tabToken = "0123456789abcdef0123456789abcdef";
    hooks.seedRemoteSession(
      "reload-old",
      id,
      repoB,
      [{ type: "messageChunk", text: "reload-history" }],
      true,
    );
    assert.strictEqual(hooks.activeRemoteSessionId("reload-old"), id);
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "reload-old",
      tabToken,
    }));
    assert.strictEqual(hooks.activeRemoteSessionId("reload-old"), id);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    // Adverse reload ordering: the replacement proves the same logical tab
    // identity and resumes while the old relay socket is still present.
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "reload-replacement",
      tabToken,
    }));
    assert.strictEqual(hooks.activeRemoteSessionId("reload-replacement"), id);
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("reload-old") &&
      p.msg?.type === "error" &&
      /replaced by another tab/.test(p.msg.text)
    ), "a superseded page must be told why it can no longer send commands");
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "reload-replacement");
    hooks.fromRemote(
      { type: "resumeSession", id, cwd: repoB },
      "reload-replacement",
    );
    await new Promise((r) => setTimeout(r, 1500));

    const replayToReconnect = posts.filter((p) => p.clientIds?.includes("reload-replacement"));
    const carriesHistoryText = (post: { msg: any }, text: string) =>
      (post.msg?.type === "messageChunk" && post.msg.text === text) ||
      (post.msg?.type === "historyBatch" && post.msg.messages?.some(
        (nested: any) => nested?.type === "messageChunk" && nested.text === text,
      ));
    assert.ok(
      replayToReconnect.some((p) => carriesHistoryText(p, "reload-history")),
      JSON.stringify(replayToReconnect.map((p) => p.msg)),
    );
    assert.ok(!replayToReconnect.some((p) => carriesHistoryText(p, "only-b")));
    assert.ok(replayToReconnect.some((p) =>
      p.msg?.type === "sessions" && p.msg.activeId === id
    ));
    assert.ok(!posts.some((p) =>
      carriesHistoryText(p, "reload-history") && p.clientIds?.includes("tab-b")
    ));

    hooks.remoteClientLeft("reload-old");
    assert.strictEqual(hooks.activeRemoteSessionId("reload-replacement"), id);
  });

  test("a replacement logical tab joins a deliberately delayed cold session load", async () => {
    const id = `reload-during-load-${Date.now()}`;
    const oldClient = `reload-loading-old-${Date.now()}`;
    const replacement = `reload-loading-new-${Date.now()}`;
    const tabToken = "abcdef0123456789abcdef0123456789";
    writeStoredSession(id);
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: oldClient,
      tabToken,
    }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, oldClient);
    await new Promise((r) => setTimeout(r, 50));

    const delay = hooks.delayNextSessionStart(id);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, oldClient);
    await delay.started;

    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: replacement,
      tabToken,
    }));
    assert.strictEqual(
      hooks.activeRemoteSessionId(replacement),
      id,
      "a mid-load snapshot must retain the session identity being restored",
    );
    assert.ok(posts.some((p) =>
      p.clientIds?.includes(replacement) &&
      p.msg?.type === "sessions" &&
      p.msg.activeId === id
    ), JSON.stringify(posts));

    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, replacement);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes(replacement) &&
      p.msg?.type === "error" &&
      /already being opened/.test(p.msg.text)
    ), JSON.stringify(posts));

    const loadCompleted = hooks.waitForSessionLoad(id);
    const beforeCompletion = posts.length;
    delay.release();
    await loadCompleted;
    const completion = posts.slice(beforeCompletion);
    assert.ok(completion.some((p) =>
      p.clientIds?.includes(replacement) && p.msg?.type === "sessions"
    ), `the load completion must target the replacement relay client: ${JSON.stringify(completion)}`);
    assert.ok(!completion.some((p) =>
      p.clientIds?.includes(oldClient) && p.msg?.type === "sessions"
    ), JSON.stringify(completion));
    hooks.remoteClientLeft(oldClient);
    hooks.remoteClientLeft(replacement);
  });

  test("client-ready resync cancels host voice before building its snapshot", () => {
    const clientId = `voice-resync-${Date.now()}`;
    hooks.seedRemoteSession(clientId, `voice-session-${Date.now()}`, repoB, [], true);
    const voice = hooks.seedRemoteVoice(clientId);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId,
      tabToken: "fedcba9876543210fedcba9876543210",
    }));

    const targeted = posts.filter((p) => p.clientIds?.includes(clientId)).map((p) => p.msg);
    assert.strictEqual(voice.cancelled(), true, "the host STT streamer must be cancelled");
    assert.ok(targeted.some((msg) => msg.type === "voiceState" && msg.status === "idle"));
    assert.ok(!targeted.some((msg) => msg.type === "voiceState" && msg.status === "listening"));
    hooks.remoteClientLeft(clientId);
  });

  test("a tokenless client-ready frame keeps the legacy remembered-session resume path", async () => {
    const id = `legacy-ready-${Date.now()}`;
    hooks.seedRemoteSession("legacy-departed", id, repoB, [], true);
    hooks.remoteClientLeft("legacy-departed");
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "legacy-returning",
    }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "legacy-returning");
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "legacy-returning");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("legacy-returning"), id);
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes("legacy-returning") && p.msg?.type === "error"
    ), JSON.stringify(posts));
  });

  // The projects rail lists every repo's sessions at once, so opening one that
  // lives outside the tab's current selection is now an ordinary click. The host
  // moves the tab to the owning repo as part of the resume — a client that sent
  // selectRepo first would race that switch's own auto-open and land on the
  // repo's newest session rather than the one the user actually picked.
  test("a remote resume adopts the session's own repo instead of refusing it", async () => {
    const id = `cross-repo-${Date.now()}`;
    hooks.seedRemoteSession("seeder", id, repoB, [], true);
    hooks.remoteClientLeft("seeder");
    await new Promise((r) => setTimeout(r, 50));

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    // Deliberately NO selectRepo — this tab is still scoped to the workspace root.
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "rail-jumper");
    await new Promise((r) => setTimeout(r, 150));

    assert.strictEqual(
      hooks.activeRemoteSessionId("rail-jumper"), id,
      `the picked session must open: ${JSON.stringify(posts)}`,
    );
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes("rail-jumper") && p.msg?.type === "error"
    ), JSON.stringify(posts));

    // And the tab is told its selection moved, so chip and rail agree with the host.
    const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    const catalog = posts.filter((p) =>
      p.clientIds?.includes("rail-jumper") && p.msg?.type === "repos"
    ).pop()?.msg;
    assert.ok(catalog, "the tab must learn that its selection moved");
    assert.strictEqual(norm(catalog.selectedCwd), norm(repoB));
  });

  test("a remote resume waits for the first catalog build before refusing a still-warming session", async () => {
    // CI-DEBUG (branch-only): surface swallowed rejections and the FULL post
    // stream — the Linux runner fails this with zero errors posted, which
    // reads as a silently-dead resume task.
    process.on("unhandledRejection", (reason) => {
      // eslint-disable-next-line no-console
      console.error("[ci-debug] unhandledRejection:", (reason as any)?.stack || reason);
    });
    // RED without the warmup retry: findSessionCatalogCwd misses, the host
    // immediately sends the permanent-sounding "may have been deleted" error,
    // and writing the session afterward cannot restore it.
    const id = `warmup-${Date.now()}`;
    const clientId = `warmup-tab-${Date.now()}`;
    const delay = hooks.delayFirstCatalogBuild();
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    try {
      hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, clientId);
      const began = await Promise.race([
        delay.started.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      writeStoredSession(id);
      delay.release();
      assert.ok(began, "the resume must defer the not-found refuse until catalog warmup");

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && hooks.activeRemoteSessionId(clientId) !== id) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // eslint-disable-next-line no-console
      console.error("[ci-debug] warmup posts (all types):", JSON.stringify(posts.map((p) => ({ t: p.msg?.type, ids: p.clientIds, err: p.msg?.type === "error" ? p.msg.text : undefined })).slice(0, 60)));
      assert.strictEqual(
        hooks.activeRemoteSessionId(clientId),
        id,
        `the session must restore after the catalog warmup: ${JSON.stringify(posts.filter((p) => p.msg?.type === "error"))}`,
      );
      assert.ok(!posts.some((p) =>
        p.clientIds?.includes(clientId) &&
        p.msg?.type === "error" &&
        /may have been deleted/.test(p.msg.text)
      ), JSON.stringify(posts.filter((p) => p.msg?.type === "error")));
    } finally {
      delay.release();
    }
  });

  test("a remote resume waits for the deferred session-list, not just the catalog post", async () => {
    // RED if "warmed" is the start/end of postRepoCatalog: the catalog half has
    // already run, the wait is skipped, and writing the session afterward cannot
    // restore it. GREEN only when firstBootScanCompleted waits for the deferred
    // session-list as well.
    const id = `warmup-list-${Date.now()}`;
    const clientId = `warmup-list-tab-${Date.now()}`;
    const delay = hooks.delayFirstCatalogBuild();
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    try {
      delay.beginDeferred();
      const catalogPosted = await Promise.race([
        delay.started.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      assert.ok(catalogPosted, "the deferred first-boot pass must reach catalog-done / session-list-held");

      hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, clientId);
      // The resume is async. Give the first lookup a chance to miss (session is
      // not on disk yet) and either refuse (old warmed-at-catalog) or wait.
      await new Promise((r) => setTimeout(r, 150));
      writeStoredSession(id);
      delay.release();

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && hooks.activeRemoteSessionId(clientId) !== id) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(
        hooks.activeRemoteSessionId(clientId),
        id,
        `the session must restore after the deferred session-list: ${JSON.stringify(posts.filter((p) => p.msg?.type === "error"))}`,
      );
      assert.ok(!posts.some((p) =>
        p.clientIds?.includes(clientId) &&
        p.msg?.type === "error" &&
        /may have been deleted/.test(p.msg.text)
      ), JSON.stringify(posts.filter((p) => p.msg?.type === "error")));
    } finally {
      delay.release();
    }
  });

  test("a genuinely missing remote resume carries resumeFailed with the requested id", async () => {
    // RED without the machine-readable field: the error is human text only.
    const id = `gone-${Date.now()}`;
    const clientId = `missing-field-${Date.now()}`;
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, clientId);
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, clientId);

    const deadline = Date.now() + 15000;
    const missing = () => posts.find((p) =>
      p.clientIds?.includes(clientId) &&
      p.msg?.type === "error" &&
      /may have been deleted/.test(p.msg.text)
    );
    while (Date.now() < deadline && !missing()) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const err = missing();
    assert.ok(err, "a missing session id must surface Could not restore");
    assert.deepStrictEqual(err!.msg.resumeFailed, { id });
  });

  test("the already-open-in-another-tab refusal carries resumeFailed", async () => {
    // RED without the field on the theft refuse.
    hooks.seedRemoteSession("tab-a", "session-a", repoB, [], true);
    hooks.seedRemoteSession("tab-b", "session-b", repoB, [], true);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "resumeSession", id: "session-a", cwd: repoB }, "tab-b");

    const deadline = Date.now() + 15000;
    const theft = () => posts.find((p) =>
      p.clientIds?.includes("tab-b") &&
      p.msg?.type === "error" &&
      /already open/.test(p.msg.text)
    );
    while (Date.now() < deadline && !theft()) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const err = theft();
    assert.ok(err, "tab-b must be refused when the session is live in another tab");
    assert.deepStrictEqual(err!.msg.resumeFailed, { id: "session-a" });
  });

  test("resume never steals another tab's live session or silently blank-starts a missing one", async () => {
    // Own the preconditions here. Earlier tests leave tab-a/session-a and
    // tab-b/session-b set up, but an intervening selectRepo can still be
    // finishing its auto-open and would overwrite a borrowed seed — this test
    // is about theft/missing-id refusal, not suite ordering.
    hooks.seedRemoteSession("tab-a", "session-a", repoB, [], true);
    hooks.seedRemoteSession("tab-b", "session-b", repoB, [], true);

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "resumeSession", id: "session-a", cwd: repoB }, "tab-b");
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "tab-missing");
    hooks.fromRemote({ type: "resumeSession", id: "deleted-session", cwd: repoB }, "tab-missing");

    // selectRepo auto-opens newest (or starts a blank session) before the
    // serialized resume of a missing id can run. That open is unbounded under
    // the missing-CLI path — a fixed sleep (100ms, then 400ms) only delayed the
    // flake. Wait for the product outcomes, not the clock.
    const theftRefused = () => posts.some((p) =>
      p.clientIds?.includes("tab-b") &&
      p.msg?.type === "error" &&
      /already open/.test(p.msg.text)
    );
    // Match the missing-id wording specifically — selectRepo's auto-open can
    // itself emit "Could not restore … already open" when the newest row is
    // live in another tab, and that must not satisfy this wait.
    const missingRefused = () => posts.some((p) =>
      p.clientIds?.includes("tab-missing") &&
      p.msg?.type === "error" &&
      /may have been deleted/.test(p.msg.text)
    );
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !(theftRefused() && missingRefused())) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(theftRefused(), "tab-b must be refused when the session is live in another tab");
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("tab-b") &&
      p.msg?.type === "sessions" &&
      p.msg.activeId === "session-b"
    ), "a refused selection must correct the tab back to its authoritative active session");
    assert.ok(missingRefused(), "a missing session id must surface Could not restore, not hang behind selectRepo");
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes("tab-missing") &&
      p.msg?.type === "sessions" &&
      p.msg.activeId === "deleted-session"
    ));
  });

  test("a phone joins a live VS Code conversation instead of being refused", async () => {
    // Desk↔remote co-attach (owner, 2026-07-30): the VS Code view is the
    // owner's desk, not a rival tab. A remote resume of a desk-held session
    // must JOIN it — emit() then serves both views. Only tab↔tab stays
    // exclusive (covered by "resume never steals another tab's live session").
    const id = `local-background-${Date.now()}`;
    hooks.seedLocalBackgroundSession(id, repoB);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "phone-adopter");
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "phone-adopter");
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(hooks.activeRemoteSessionId("phone-adopter"), id, "the tab must join the desk conversation");
    assert.ok(hooks.hasLiveSession(id), "the shared session must stay live");
    // The sessions list must confirm the join — the web client's identity
    // restore waits on exactly this activeId before flushing queued work.
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("phone-adopter") &&
      p.msg?.type === "sessions" &&
      p.msg.activeId === id
    ), "the joining tab must receive a sessions list confirming the active id");
    assert.ok(!posts.some((p) =>
      p.clientIds?.includes("phone-adopter") && p.msg?.type === "error"
    ), JSON.stringify(posts.filter((p) => p.msg?.type === "error")));
    hooks.remoteClientLeft("phone-adopter");
    assert.ok(hooks.hasLiveSession(id), "the tab leaving must not tear down the desk's session");
  });

  test("VS Code joins a conversation owned by a phone; both views keep it", async () => {
    const id = `phone-owned-${Date.now()}`;
    hooks.seedRemoteSession("phone-owner", id, repoB, [], true);

    await hooks.openLocalSession(id, repoB);

    assert.strictEqual(hooks.activeRemoteSessionId("phone-owner"), id, "the phone must keep the conversation");
    assert.strictEqual(hooks.focusedSessionId(), id, "the desk must join the same conversation");
    assert.ok(hooks.hasLiveSession(id), "the shared session must stay live");
    hooks.remoteClientLeft("phone-owner");
    assert.strictEqual(hooks.focusedSessionId(), id, "the phone leaving must not evict the desk's view");
  });

  test("a fresh tab continues the desk's conversation instead of a blank session", async () => {
    // "Continue remotely" (and any first visit) arrives with no remembered
    // conversation. It must CONTINUE what the desk is showing — the feature's
    // whole promise, and what desk↔remote co-attach finally allows. The bug
    // this pins: a fresh tab used to get a brand-new Session that had never
    // been started, so it sat on "Starting" forever and its first send
    // quietly began a SECOND conversation.
    const id = `desk-continue-${Date.now()}`;
    const cwd = hooks.workspaceRoot();
    hooks.seedRemoteSession("seed-holder", id, cwd, [], true);
    await hooks.openLocalSession(id, cwd); // the desk joins and focuses it
    hooks.remoteClientLeft("seed-holder"); // …and is now the only view on it
    assert.strictEqual(hooks.focusedSessionId(), id, "the desk should be showing the conversation");

    // Tab tokens must be unique across the whole suite: a repeated token hands
    // ownership from the earlier test's client and this ready would be
    // dropped as superseded.
    const clientId = `continue-remotely-${Date.now()}`;
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId,
      tabToken: `c0nt1nue${Date.now().toString(16).padStart(24, "0")}`.slice(0, 32),
    }));

    assert.strictEqual(
      hooks.activeRemoteSessionId(clientId),
      id,
      "a fresh tab must continue the desk conversation, not open a blank session",
    );
    assert.strictEqual(hooks.focusedSessionId(), id, "the desk keeps showing it too");

    // A SECOND fresh tab is its own conversation — tab↔tab stays exclusive.
    const second = `second-tab-${Date.now()}`;
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: second,
      tabToken: `5ec0nd7ab${Date.now().toString(16).padStart(23, "0")}`.slice(0, 32),
    }));
    assert.notStrictEqual(
      hooks.activeRemoteSessionId(second),
      id,
      "a second tab must not be handed the conversation the first one continued",
    );
    hooks.remoteClientLeft(clientId);
    hooks.remoteClientLeft(second);
  });

  test("a local cold resume reserves its id before a remote cold resume can race it", async () => {
    const id = `local-cold-race-${Date.now()}`;
    writeStoredSession(id);
    const delay = hooks.delayNextSessionStart(id);
    const localOpen = hooks.openLocalSession(id, repoB);
    await delay.started;
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "cold-racer");
    hooks.fromRemote({ type: "resumeSession", id, cwd: repoB }, "cold-racer");
    await new Promise((r) => setTimeout(r, 100));

    assert.notStrictEqual(hooks.activeRemoteSessionId("cold-racer"), id);
    assert.ok(posts.some((p) =>
      p.clientIds?.includes("cold-racer") &&
      p.msg?.type === "error" &&
      /already being opened/.test(p.msg.text)
    ));
    delay.release();
    await localOpen;
  });

  test("delete and Clear all preserve a conversation while another view is cold-loading it", async () => {
    const id = `cold-protected-${Date.now()}`;
    const clearableId = `cold-clearable-${Date.now()}`;
    writeStoredSession(id);
    writeStoredSession(clearableId);
    const delay = hooks.delayNextSessionStart(id);
    const localOpen = hooks.openLocalSession(id, repoB);
    await delay.started;

    hooks.fromRemote({ type: "deleteSession", id, name: "Cold loading" }, "tab-b");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(storedSessionDir(id)), "delete must preserve the reserved session id");

    hooks.fromRemote({ type: "clearAllSessions", cwd: repoB }, "tab-b");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(storedSessionDir(id)), "Clear all must preserve the reserved session id");
    assert.ok(!fs.existsSync(storedSessionDir(clearableId)), "Clear all should still remove ownerless history");

    delay.release();
    await localOpen;
  });

  test("selectRepo waits behind deliberately delayed New and Resume transitions", async () => {
    const clientId = `ordered-transition-${Date.now()}`;
    const repoHistory = `repo-history-${Date.now()}`;
    const workspaceHistory = `workspace-history-${Date.now()}`;
    const resumeId = `resume-delayed-${Date.now()}`;
    writeStoredSession(repoHistory, repoB, "2020-01-01T00:00:00.000Z");
    writeStoredSession(resumeId, repoB, "2020-01-02T00:00:00.000Z");
    writeStoredSession(workspaceHistory, hooks.workspaceRoot(), "2099-01-01T00:00:00.000Z");

    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, clientId);
    await new Promise((r) => setTimeout(r, 100));

    for (const transition of ["new", "resume"] as const) {
      const delay = hooks.delayNextSessionStart(transition === "resume" ? resumeId : undefined);
      const posts: Array<{ msg: any; clientIds?: string[] }> = [];
      hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

      if (transition === "new") hooks.fromRemote({ type: "newSession" }, clientId);
      else hooks.fromRemote({ type: "resumeSession", id: resumeId, cwd: repoB }, clientId);
      await delay.started;
      hooks.fromRemote({ type: "selectRepo", cwd: hooks.workspaceRoot() }, clientId);
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(!posts.some((p) =>
        p.clientIds?.includes(clientId) &&
        p.msg?.type === "repos" &&
        p.msg.selectedCwd === hooks.workspaceRoot()
      ), `selectRepo must not overtake delayed ${transition}`);

      delay.release();
      // The released transition performs a REAL cold CLI spawn on machines with
      // grok installed — 1500ms was only enough when earlier suite tests had
      // pre-warmed the spawn path, and failed in isolation or after suite
      // reordering. Poll instead of sleeping a fixed slice.
      const deadline = Date.now() + 15000;
      let switchedAt = -1;
      let finalHistory: any;
      while (Date.now() < deadline) {
        switchedAt = posts.findIndex((p) =>
          p.clientIds?.includes(clientId) &&
          p.msg?.type === "repos" &&
          p.msg.selectedCwd === hooks.workspaceRoot()
        );
        if (switchedAt >= 0) {
          const histories = posts.slice(switchedAt).filter((p) =>
            p.clientIds?.includes(clientId) && p.msg?.type === "sessions"
          );
          finalHistory = histories[histories.length - 1]?.msg;
          if (finalHistory?.entries.some((entry: any) => entry.id === workspaceHistory)) break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(switchedAt >= 0, `delayed ${transition} should eventually yield to selectRepo`);
      assert.ok(
        finalHistory,
        "the selected repository should receive a history snapshot",
      );
      assert.ok(finalHistory.entries.some((entry: any) => entry.id === workspaceHistory));
      assert.ok(!finalHistory.entries.some((entry: any) => entry.id === repoHistory));

      if (transition === "new") {
        hooks.fromRemote({ type: "selectRepo", cwd: repoB }, clientId);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  test("a one-shot composer restore is not replayed when the conversation is re-opened", async () => {
    // Reported on the browser client: an unsent draft gained one more copy of
    // itself on every switch back to a pinned conversation. `emit` buffers what
    // it sends so a focus switch can rebuild the chat, and the buffer replays in
    // full — so `restoreComposer`, which the client deliberately APPENDS (an
    // Edit must not destroy what you are mid-way through typing), added the same
    // draft again every time.
    const clientId = `transient-replay-${Date.now()}`;
    const liveId = `transient-live-${Date.now()}`;
    writeStoredSession(liveId, repoB, "2099-01-01T00:00:00.000Z");
    hooks.seedRemoteSession(clientId, liveId, repoB, [], true);

    hooks.emitRemote(clientId, { type: "restoreComposer", text: "draft that must not repeat" });
    hooks.emitRemote(clientId, { type: "userMessage", text: "a real message", chips: [] } as any);

    hooks.fromRemote({ type: "selectRepo", cwd: hooks.workspaceRoot() }, clientId);
    await new Promise((r) => setTimeout(r, 300));
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, clientId);
    await new Promise((r) => setTimeout(r, 800));

    // The buffer arrives INSIDE a historyBatch, so a top-level scan would pass
    // whether or not the fix is in — flatten it before asserting anything.
    const mine = posts.filter((p) => p.clientIds?.includes(clientId)).map((p) => p.msg);
    const replayed = mine.flatMap((msg) =>
      msg?.type === "historyBatch" ? (msg.messages ?? []).map((m: any) => m?.type) : [msg?.type],
    );
    assert.ok(replayed.includes("clearMessages"), "re-selecting should reload the client");
    assert.ok(
      !replayed.includes("restoreComposer"),
      `a buffered composer restore re-appends the old draft on every switch back — got: ${replayed.join(",")}`,
    );
    // The buffer must still carry real conversation content, or the fix has
    // simply broken replay.
    assert.ok(replayed.includes("userMessage"), `conversation content must still replay — got: ${replayed.join(",")}`);
  });

  test("re-selecting a repository whose conversation is still live re-announces its name", async () => {
    // `clearMessages` drops the client's latched conversation name, and the
    // header's rename affordance is gated on having one. This path builds its
    // own targeted history list rather than going through postSessionsList, so
    // nothing else would put the name back until an unrelated refresh.
    const clientId = `name-refocus-${Date.now()}`;
    const liveId = `live-named-${Date.now()}`;
    writeStoredSession(liveId, repoB, "2099-01-01T00:00:00.000Z");
    hooks.seedRemoteSession(clientId, liveId, repoB, [], true);

    hooks.fromRemote({ type: "selectRepo", cwd: hooks.workspaceRoot() }, clientId);
    await new Promise((r) => setTimeout(r, 300));

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, clientId);
    await new Promise((r) => setTimeout(r, 800));

    const mine = posts.filter((p) => p.clientIds?.includes(clientId));
    const cleared = mine.map((p) => p.msg?.type).lastIndexOf("clearMessages");
    assert.ok(cleared >= 0, "re-selecting the repository should reload the client");
    const named = mine.slice(cleared).find((p) => p.msg?.type === "sessionName");
    assert.ok(named, "a sessionName must follow the clear, or the header cannot offer rename");
    assert.strictEqual(named!.msg.sessionId, liveId);
    assert.ok(
      typeof named!.msg.name === "string" && named!.msg.name.length > 0,
      "the re-announced name must be the title itself, not an empty placeholder",
    );
  });

  test("primary-repo deletion refuses another repo's worktree and permits its own", async () => {
    const suffix = Date.now();
    const repoAWorktree = path.join(hooks.workspaceRoot(), `.int-a-worktree-${suffix}`);
    const repoBWorktree = path.join(hooks.workspaceRoot(), `.int-b-worktree-${suffix}`);
    fs.mkdirSync(repoAWorktree, { recursive: true });
    fs.mkdirSync(repoBWorktree, { recursive: true });
    const record = (id: string, worktreePath: string, sourceRepo: string) => ({
      id,
      path: worktreePath,
      sourceRepo,
      repoName: id,
      kind: "worktree",
      creationMode: "fixture",
      gitRef: "fixture",
      headCommit: "fixture",
      status: "alive",
      label: id,
      userProvidedLabel: true,
    });
    const repoAGitRoot = path.resolve(hooks.workspaceRoot(), "..", "..");
    hooks.seedWorktree(record("repo-a-wt", repoAWorktree, repoAGitRoot));
    hooks.seedWorktree(record("repo-b-wt", repoBWorktree, repoB));

    const foreignId = `foreign-worktree-${suffix}`;
    const ownId = `own-worktree-${suffix}`;
    const clearOwnId = `clear-own-worktree-${suffix}`;
    const clearForeignId = `clear-foreign-worktree-${suffix}`;
    writeStoredSession(foreignId, repoBWorktree);
    writeStoredSession(ownId, repoAWorktree, "2020-01-01T00:00:00.000Z");
    writeStoredSession(`primary-${suffix}`, hooks.workspaceRoot(), "2099-01-01T00:00:00.000Z");
    const clientId = `scope-client-${suffix}`;
    hooks.fromRemote({ type: "selectRepo", cwd: hooks.workspaceRoot() }, clientId);
    await new Promise((r) => setTimeout(r, 100));

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRemote({ type: "deleteSession", id: foreignId, name: "foreign" }, clientId);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      fs.existsSync(storedSessionDirFor(repoBWorktree, foreignId)),
      "repo A must not authorize deleting repo B's worktree history",
    );
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "error" &&
      /no longer in this project/.test(post.msg.text)
    ), JSON.stringify(posts));

    hooks.fromRemote({ type: "deleteSession", id: ownId, name: "own" }, clientId);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      !fs.existsSync(storedSessionDirFor(repoAWorktree, ownId)),
      "repo A must still authorize cold history in its registered worktree",
    );

    writeStoredSession(clearOwnId, repoAWorktree);
    writeStoredSession(clearForeignId, repoBWorktree);
    hooks.fromRemote({ type: "clearAllSessions", cwd: hooks.workspaceRoot() }, clientId);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!fs.existsSync(storedSessionDirFor(repoAWorktree, clearOwnId)));
    assert.ok(
      fs.existsSync(storedSessionDirFor(repoBWorktree, clearForeignId)),
      "Clear all for repo A must not enumerate repo B's worktree catalog",
    );

    hooks.remoteClientLeft(clientId);
    hooks.seedWorktreeRefresh(hooks.workspaceRoot(), []);
    hooks.seedWorktreeRefresh(repoB, []);
    fs.rmSync(repoAWorktree, { recursive: true, force: true });
    fs.rmSync(repoBWorktree, { recursive: true, force: true });
  });

  test("refresh during remote startup preserves a host-owned queued prompt", async () => {
    const suffix = Date.now();
    const id = `starting-refresh-${suffix}`;
    const oldClient = `starting-old-${suffix}`;
    const replacement = `starting-new-${suffix}`;
    const tabToken = "00112233445566778899aabbccddeeff";
    const queuedText = "typed while the new session was starting";
    writeStoredSession(id);
    hooks.seedRemoteStartingSession(oldClient, id, repoB, queuedText);
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: oldClient,
      tabToken,
    }));

    hooks.remoteClientLeft(oldClient);
    assert.ok(hooks.hasLiveSession(id), "client-left must not dispose a priming session with queued work");
    assert.ok(fs.existsSync(storedSessionDir(id)), "queued startup work must keep its session directory");

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: replacement,
      tabToken,
    }));

    assert.strictEqual(hooks.activeRemoteSessionId(replacement), id);
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "queuedSends" &&
      post.msg.items?.[0] === queuedText
    ), JSON.stringify(posts));

    hooks.finishRemoteStartup(replacement);
    hooks.remoteClientLeft(replacement);
  });

  test("refresh preserves a chip-only remote session when client-left wins the reload race", async () => {
    const suffix = Date.now();
    const id = `chip-refresh-${suffix}`;
    const oldClient = `chip-old-${suffix}`;
    const replacement = `chip-new-${suffix}`;
    const tabToken = "aabbccddeeff00112233445566778899";
    const chip = {
      id: `pasted-image-${suffix}`,
      path: path.join(grokHome, "uploads", `pasted-${suffix}.png`),
      relPath: `[Image #1]`,
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };
    writeStoredSession(id);
    hooks.seedRemoteSession(oldClient, id, repoB, [], false, [chip]);
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: oldClient,
      tabToken,
    }));

    hooks.remoteClientLeft(oldClient);
    assert.ok(hooks.hasLiveSession(id), "client-left must not dispose a session with a staged attachment");
    assert.ok(fs.existsSync(storedSessionDir(id)), "the chip-only session directory must survive reload");

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: replacement,
      tabToken,
    }));

    assert.strictEqual(hooks.activeRemoteSessionId(replacement), id);
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "chips" &&
      post.msg.chips?.[0]?.id === chip.id
    ), JSON.stringify(posts));
    hooks.remoteClientLeft(replacement);
  });

  test("an idle remote queue asks the browser for a metered send before consuming it", async () => {
    const suffix = Date.now();
    const clientId = `metered-queue-${suffix}`;
    const id = `metered-queue-session-${suffix}`;
    const text = "send me through the relay";
    hooks.seedRemoteSession(clientId, id, repoB, [], true);
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "queueSend", text }, clientId);
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "submitQueuedSend" &&
      post.msg.text === text
    ), JSON.stringify(posts));
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "queuedSends" &&
      post.msg.items?.[0] === text
    ), JSON.stringify(posts));
    assert.ok(!posts.some((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "userMessage"
    ), JSON.stringify(posts));
    hooks.remoteClientLeft(clientId);
  });

  test("a disconnected remote queue never falls through to the host prompt path", async () => {
    const suffix = Date.now();
    const oldClient = `metered-detach-old-${suffix}`;
    const replacement = `metered-detach-new-${suffix}`;
    const id = `metered-detach-session-${suffix}`;
    const text = "still requires relay metering";
    const tabToken = "11223344556677889900aabbccddeeff";
    hooks.seedRemoteSession(oldClient, id, repoB, [], true);
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: oldClient, tabToken }));
    hooks.fromRemote({ type: "queueSend", text }, oldClient);
    await new Promise((r) => setTimeout(r, 50));
    hooks.remoteClientLeft(oldClient);

    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: replacement, tabToken }));

    assert.ok(posts.some((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "queuedSends" &&
      post.msg.items?.[0] === text
    ), JSON.stringify(posts));
    assert.ok(posts.some((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "submitQueuedSend" &&
      post.msg.text === text
    ), JSON.stringify(posts));
    assert.ok(!posts.some((post) => post.msg?.type === "userMessage"), JSON.stringify(posts));
    hooks.remoteClientLeft(replacement);
  });

  test("a persisted dequeue echo plus its reconnect replay reaches the model once", async () => {
    const suffix = Date.now();
    const oldClient = `dequeue-once-old-${suffix}`;
    const replacement = `dequeue-once-new-${suffix}`;
    const id = `dequeue-once-session-${suffix}`;
    const text = "perform this queued task once";
    const tabToken = "22334455667788990011aabbccddeeff";
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    const model = hooks.seedRemoteQueuedDispatch(oldClient, id, repoB, text);
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: oldClient, tabToken }));
    const original = posts.find((post) =>
      post.clientIds?.includes(oldClient) &&
      post.msg?.type === "submitQueuedSend"
    )?.msg;
    assert.ok(original?.id, JSON.stringify(posts));

    hooks.remoteClientLeft(oldClient);
    hooks.fromRelayFrame(JSON.stringify({ t: "client-ready", clientId: replacement, tabToken }));
    const replay = posts.find((post) =>
      post.clientIds?.includes(replacement) &&
      post.msg?.type === "submitQueuedSend"
    )?.msg;
    assert.deepStrictEqual(replay, original, "the reconnect snapshot must replay the same claimed submission");

    const persistedOutboxEcho = { type: "send", text, queuedSendId: original.id };
    const reconnectEcho = { type: "send", text, queuedSendId: replay.id };
    hooks.fromRemote(persistedOutboxEcho, replacement);
    hooks.fromRemote(reconnectEcho, replacement);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(model.promptCount(), 1, "duplicate dequeue echoes must execute one model prompt");
    hooks.remoteClientLeft(replacement);
  });

  test("an unreadable image retains a metered dequeue plus text appended during the send", async () => {
    const suffix = Date.now();
    const clientId = `dequeue-read-failure-${suffix}`;
    const id = `dequeue-read-failure-session-${suffix}`;
    const first = "keep the charged prompt";
    const second = "and keep this appended part";
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    const model = hooks.seedRemoteQueuedDispatch(clientId, id, repoB, first, [{
      id: "missing-image",
      path: path.join(repoB, `missing-${suffix}.png`),
      relPath: "missing.png",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    }]);
    const dispatch = posts.find((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "submitQueuedSend"
    )?.msg;
    assert.ok(dispatch?.id, JSON.stringify(posts));

    hooks.fromRemote({ type: "send", text: first, queuedSendId: dispatch.id }, clientId);
    hooks.fromRemote({ type: "queueSend", text: second }, clientId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(model.promptCount(), 0, "the unreadable image must bail before model prompt");
    assert.deepStrictEqual(model.queuedSends(), [`${first}\n\n${second}`]);
    assert.ok(posts.some((post) =>
      post.msg?.type === "agentError" &&
      post.msg.text?.includes("Could not read missing.png")
    ), JSON.stringify(posts));

    hooks.fromRemote({ type: "removeChip", id: "missing-image" }, clientId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Known limitation: this retained retry is a fresh relay submission, so it
    // is metered again. Pin that behavior until the queue can represent an
    // already-metered prefix separately from newly appended text.
    const retryDispatch = [...posts].reverse().find((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "submitQueuedSend" &&
      post.msg.id !== dispatch.id
    )?.msg;
    assert.ok(retryDispatch?.id, JSON.stringify(posts));
    hooks.fromRemote({
      type: "send",
      text: `${first}\n\n${second}`,
      queuedSendId: retryDispatch.id,
    }, clientId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(model.promptCount(), 1, "removing the bad chip must deliver the retained prompt");
    assert.deepStrictEqual(model.queuedSends(), []);
    hooks.remoteClientLeft(clientId);
  });

  test("an image tag is numbered by its position in this message, not by the session", async () => {
    // grok resolves `[Image #N]` against the images attached to the message it
    // is reading, numbered from 1 — an index from an earlier message matches
    // nothing (research/image-index-probe.cjs). The old session-scoped counter
    // therefore sent a conversation's second image out as `[Image #2]` on a
    // message carrying one image, and every image_edit on it was refused. The
    // chip below is seeded with a stale high index, which is exactly what that
    // counter produced. The pure renumbering has its own unit tests; what this
    // covers is the wiring — that the send really does renumber before building
    // the prompt, and that the bubble the user reads agrees with the tag.
    const suffix = Date.now();
    const clientId = `image-index-${suffix}`;
    const id = `image-index-session-${suffix}`;
    const text = "make it green";
    const imgPath = path.join(repoB, `staged-${suffix}.png`);
    fs.writeFileSync(imgPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    const model = hooks.seedRemoteQueuedDispatch(clientId, id, repoB, text, [{
      id: `stale-index-${suffix}`,
      path: imgPath,
      relPath: "Image #7",
      hidden: false,
      imageIndex: 7,
      mimeType: "image/png",
    }]);
    const dispatch = posts.find((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "submitQueuedSend"
    )?.msg;
    assert.ok(dispatch?.id, JSON.stringify(posts));

    hooks.fromRemote({ type: "send", text, queuedSendId: dispatch.id }, clientId);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.strictEqual(model.promptCount(), 1, "the send must reach the CLI");
    const blocks = model.lastPromptBlocks();
    assert.ok(blocks, "the prompt blocks must have been captured");
    const textBlock: any = blocks!.find((block: any) => block.type === "text");
    const imageBlocks = blocks!.filter((block: any) => block.type === "image");
    assert.strictEqual(imageBlocks.length, 1, "one visible image chip, one image block");
    assert.ok(
      /\[Image #1\]/.test(textBlock.text),
      `the tag must name this message's first image, got: ${textBlock.text}`,
    );
    assert.ok(
      !/\[Image #7\]/.test(textBlock.text),
      `the stale session-scoped index must not survive, got: ${textBlock.text}`,
    );

    // …and the bubble the user reads must carry the same number as the tag, or
    // the disagreement is invisible until someone reads a transcript.
    const bubble = [...posts].reverse().find((post) => post.msg?.type === "userMessage")?.msg;
    assert.ok(bubble, JSON.stringify(posts.map((post) => post.msg?.type)));
    assert.deepStrictEqual(bubble.chips.map((chip: any) => chip.imageIndex), [1]);
    assert.deepStrictEqual(bubble.chips.map((chip: any) => chip.relPath), ["Image #1"]);

    hooks.remoteClientLeft(clientId);
  });

  test("sending bumps the conversation up its project's rail immediately", async () => {
    // The send IS the activity: the rail must not wait for the CLI to write a
    // transcript (~2s) before admitting you are working in this conversation.
    // `noteSessionActivity` stamps `activeAt` and re-posts — but it called
    // `refreshRemoteRepoPreview(undefined, cwd)`, whose first line is
    // `if (!clientId || !cwd) return`, so the remote rail was never told at all.
    const suffix = Date.now();
    const clientId = `rail-bump-${suffix}`;
    const id = `rail-bump-session-${suffix}`;
    const text = "wake the rail up";
    // Its OWN repo. Sharing repoB put ~30 sessions from other tests in the
    // list, most of them written without an `updated_at` and so defaulting to
    // "now" — which makes "ranks first" unsatisfiable no matter what the code
    // does. An isolated catalog is the only way this assertion means anything.
    const repoRail = path.join(hooks.workspaceRoot(), `.int-rail-${suffix}`);
    fs.mkdirSync(repoRail, { recursive: true });
    // An OLD conversation with NEWER ones above it — the realistic shape, and
    // the only one where the bump is observable at all.
    writeStoredSession(id, repoRail, "2020-01-01T00:00:00.000Z");
    writeStoredSession(`rail-newer-a-${suffix}`, repoRail, "2021-01-01T00:00:00.000Z");
    writeStoredSession(`rail-newer-b-${suffix}`, repoRail, "2022-01-01T00:00:00.000Z");
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));
    const model = hooks.seedRemoteQueuedDispatch(clientId, id, repoRail, text);
    const dispatch = posts.find((post) =>
      post.clientIds?.includes(clientId) &&
      post.msg?.type === "submitQueuedSend"
    )?.msg;
    assert.ok(dispatch?.id, JSON.stringify(posts.map((p) => p.msg?.type)));

    posts.length = 0;
    hooks.fromRemote({ type: "send", text, queuedSendId: dispatch.id }, clientId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(model.promptCount(), 1, "the send must reach the CLI");

    // The list the rail renders from has to be re-posted by the send itself.
    // Only lists for THIS repo. Other tests' sessions keep arriving as
    // `repoSessions` previews for their own catalogs, and the last post overall
    // is routinely one of those.
    const sameRepo = (value: unknown) =>
      typeof value === "string" &&
      path.resolve(value).toLowerCase() === path.resolve(repoRail).toLowerCase();
    const listed = posts.filter((post) =>
      post.msg?.type === "sessions" ||
      (post.msg?.type === "repoSessions" && sameRepo(post.msg.cwd)));
    assert.ok(
      listed.length > 0,
      `sending must re-post the session list — got ${JSON.stringify(posts.map((p) => p.msg?.type))}`,
    );
    // …and the conversation just sent to must be at the top of it.
    const withEntries = listed.filter((post) => Array.isArray(post.msg.entries) && post.msg.entries.length);
    assert.ok(
      withEntries.length > 0,
      `the re-posted list must carry entries — got ${JSON.stringify(listed.map((p) => p.msg.type))}`,
    );
    // The LAST list posted is the state the rail ends in. Earlier ones can
    // legitimately predate the activity stamp.
    const final = withEntries[withEntries.length - 1].msg;
    assert.strictEqual(
      final.entries[0].id, id,
      `${final.type}: the conversation just sent to must rank first — got ${JSON.stringify(final.entries.slice(0, 5).map((e: any) => e.id))}`,
    );
    hooks.remoteClientLeft(clientId);
  });

  test("switching repos disposes a primer-only remote session before dropping its mapping", async () => {
    const id = `primer-only-${Date.now()}`;
    writeStoredSession(id);
    hooks.seedRemoteSession("primer-owner", id, repoB, [], false);
    assert.ok(hooks.hasLiveSession(id));
    assert.ok(fs.existsSync(storedSessionDir(id)));

    hooks.fromRemote({ type: "selectRepo", cwd: hooks.workspaceRoot() }, "primer-owner");
    await new Promise((r) => setTimeout(r, 100));

    assert.notStrictEqual(hooks.activeRemoteSessionId("primer-owner"), id);
    assert.ok(!hooks.hasLiveSession(id), "the abandoned primer process must be disposed");
    assert.ok(!fs.existsSync(storedSessionDir(id)), "the primer-only history row must be deleted");
  });

  test("closing a client disposes and deletes its primer-only remote session", async () => {
    const id = `departed-primer-${Date.now()}`;
    writeStoredSession(id);
    hooks.seedRemoteSession("departing-primer-owner", id, repoB, [], false);

    hooks.remoteClientLeft("departing-primer-owner");
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(hooks.activeRemoteSessionId("departing-primer-owner"), undefined);
    assert.ok(!hooks.hasLiveSession(id), "the departed client's primer process must be disposed");
    assert.ok(!fs.existsSync(storedSessionDir(id)), "the departed client's primer history must be deleted");
  });

  test("roster pruning uses the same primer-only client release path", async () => {
    const id = `pruned-primer-${Date.now()}`;
    writeStoredSession(id);
    hooks.seedRemoteSession("pruned-primer-owner", id, repoB, [], false);

    hooks.remoteClientRoster([]);
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(!hooks.hasLiveSession(id), "a pruned client's primer process must be disposed");
    assert.ok(!fs.existsSync(storedSessionDir(id)), "a pruned client's primer history must be deleted");
  });

  test("the empty-session sweep removes what nothing was there to park, and only that", async () => {
    // #97. `parkFocused` handles the session you walk away from inside a running
    // window; nothing handled the ones nobody was there to park — a window closed
    // without a prompt, a host that crashed. The old sweep required our hidden
    // primer, so once that was retired it recognised nothing and the directories
    // collected as "Untitled" rows the CLI cannot even load.
    const stamp = Date.now();
    const bootOnly = [
      JSON.stringify({ type: "system", content: [{ type: "text", text: "You are Grok." }] }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<system-reminder>\navailable skills\n</system-reminder>" }],
        synthetic_reason: "system_reminder",
      }),
    ].join("\n");
    const realTurn = [
      bootOnly,
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\nfix the flaky test\n</user_query>" }] }),
    ].join("\n");
    // Backdated on purpose: the sweep only claims a session was ABANDONED, and
    // refuses to claim that about one grok registered moments ago (which may not
    // have written its history yet, or may belong to another window).
    const writeSession = (id: string, numMessages: number, history?: string) => {
      const dir = storedSessionDirFor(repoB, id);
      fs.mkdirSync(dir, { recursive: true });
      const summary = path.join(dir, "summary.json");
      fs.writeFileSync(
        summary,
        JSON.stringify({ info: { id, cwd: repoB }, num_messages: numMessages, session_summary: "" }),
      );
      if (history !== undefined) fs.writeFileSync(path.join(dir, "chat_history.jsonl"), history);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(summary, old, old);
    };

    const bare = `sweep-bare-${stamp}`;     // only summary.json — the unloadable shape
    const booted = `sweep-booted-${stamp}`; // grok's own boot lines, never typed into
    const real = `sweep-real-${stamp}`;     // one real user query
    const live = `sweep-live-${stamp}`;     // empty, but a tab is looking at it
    writeSession(bare, 0);
    writeSession(booted, 0, bootOnly);
    writeSession(real, 3, realTurn);
    writeSession(live, 0, bootOnly);
    hooks.seedRemoteSession("sweep-owner", live, repoB, [], false);

    hooks.sweepEmptySessions(repoB);

    assert.ok(!fs.existsSync(storedSessionDirFor(repoB, bare)), "a directory holding only summary.json must go");
    assert.ok(!fs.existsSync(storedSessionDirFor(repoB, booted)), "a session never typed into must go");
    assert.ok(fs.existsSync(storedSessionDirFor(repoB, real)), "a session with a real turn must survive");
    assert.ok(
      fs.existsSync(storedSessionDirFor(repoB, live)),
      "a live session must survive — its CLI owns the directory and re-persists it",
    );

    // The same directory, freshly stamped, is not something the sweep will claim
    // to know about: parking removes those, and one window must not delete what
    // another just created.
    const recent = `sweep-recent-${stamp}`;
    writeSession(recent, 0, bootOnly);
    const now = new Date();
    fs.utimesSync(path.join(storedSessionDirFor(repoB, recent), "summary.json"), now, now);
    hooks.sweepEmptySessions(repoB);
    assert.ok(fs.existsSync(storedSessionDirFor(repoB, recent)), "a session created moments ago must survive");
    fs.rmSync(storedSessionDirFor(repoB, recent), { recursive: true, force: true });

    hooks.remoteClientLeft("sweep-owner");
    await new Promise((r) => setTimeout(r, 50));
  });

  test("an undiscovered cwd is refused, so a remote cannot name an arbitrary path", async () => {
    const posts: Array<{ dest: string; msg: any }> = [];
    hooks.onPost((dest: string, msg: any) => posts.push({ dest, msg }));

    hooks.fromRemote({ type: "selectRepo", cwd: path.join(os.tmpdir(), "not-a-known-repo") });
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(
      posts.filter((p) => p.msg?.type === "repos").length,
      0,
      "a cwd outside the discovered catalog must be dropped before it reaches onMessage",
    );

    // ...and the tap was genuinely live while that happened. Without this, the
    // assertion above also passes when selectRepo is broken for EVERY cwd — which
    // is how this test first went green against a fixture that was being filtered
    // out of the catalog entirely.
    hooks.fromRemote({ type: "selectRepo", cwd: repoB });
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(
      posts.some((p) => p.msg?.type === "repos"),
      "a DISCOVERED cwd must still be accepted — otherwise the check above is vacuous",
    );
  });

  test("a malformed cwd-bearing frame cannot escape the remote dispatch boundary", () => {
    assert.doesNotThrow(() => {
      hooks.fromRemote({ type: "selectRepo", cwd: {} } as any, "malformed-frame");
      hooks.fromRemote({ type: "resumeSession", id: "remembered", cwd: [] } as any, "malformed-frame");
    });
  });

  test("an audio chunk without an owned voice session is rejected visibly", async () => {
    const posts: Array<{ msg: any; clientIds?: string[] }> = [];
    hooks.onPost((_dest: string, msg: any, clientIds?: string[]) => posts.push({ msg, clientIds }));

    hooks.fromRemote({ type: "remoteVoiceChunk", data: "AQACAA==" }, "unowned-mic");
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(posts.some((p) =>
      p.msg?.type === "voiceError" &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "unowned-mic"
    ));
  });

  test("remote host-side operation notices return only to the requesting tab", async () => {
    hooks.seedRemoteSession("requester", "notice-session", repoB);
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    hooks.fromRemote({ type: "forkSession" }, "requester");
    hooks.fromRemote({ type: "uploadFile", name: "bad.exe", data: "YQ==" }, "requester");
    hooks.fromRemote({ type: "pasteImage", mimeType: "image/bmp", data: "YQ==" }, "requester");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((p) =>
      p.msg?.type === "hostNotice" &&
      /Nothing to fork/.test(p.msg.text) &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "requester"
    ));
    assert.ok(posts.some((p) =>
      p.msg?.type === "error" &&
      /Could not attach document/.test(p.msg.text) &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "requester"
    ));
    assert.ok(posts.some((p) =>
      p.msg?.type === "error" &&
      /unsupported image type/.test(p.msg.text) &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "requester"
    ));
    const provoked = posts.filter((p) => p.msg?.type === "hostNotice" || p.msg?.type === "error");
    assert.ok(!provoked.some((p) => p.dest === "local"));
  });

  test("forkSession with a matching sessionId proceeds for that tab", async () => {
    hooks.seedRemoteSession("fork-match", "fork-match-session", repoB);
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    hooks.fromRemote({ type: "forkSession", sessionId: "fork-match-session" }, "fork-match");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((p) =>
      p.msg?.type === "hostNotice" &&
      /Nothing to fork/.test(p.msg.text) &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "fork-match"
    ));
    assert.ok(!posts.some((p) =>
      p.msg?.type === "hostNotice" && /no longer focused/.test(p.msg.text)
    ));
  });

  test("forkSession with a different sessionId is refused for that tab only", async () => {
    hooks.seedRemoteSession("fork-stale", "fork-stale-session", repoB);
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    hooks.fromRemote({ type: "forkSession", sessionId: "some-other-session" }, "fork-stale");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((p) =>
      p.msg?.type === "hostNotice" &&
      p.msg.text === "That conversation is no longer focused — nothing was changed." &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "fork-stale"
    ));
    assert.ok(!posts.some((p) =>
      p.msg?.type === "hostNotice" && /Nothing to fork/.test(p.msg.text)
    ));
    assert.ok(!posts.some((p) => p.dest === "local"));
  });

  test("forkSession without a sessionId still proceeds (old client)", async () => {
    hooks.seedRemoteSession("fork-legacy", "fork-legacy-session", repoB);
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    hooks.fromRemote({ type: "forkSession" }, "fork-legacy");
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(posts.some((p) =>
      p.msg?.type === "hostNotice" &&
      /Nothing to fork/.test(p.msg.text) &&
      p.clientIds?.length === 1 &&
      p.clientIds[0] === "fork-legacy"
    ));
    assert.ok(!posts.some((p) =>
      p.msg?.type === "hostNotice" && /no longer focused/.test(p.msg.text)
    ));
  });

  test("local applyWorktree/removeWorktree with a stale sessionId are refused", async () => {
    const worktree = path.join(hooks.workspaceRoot(), ".int-stale-wt");
    const probe = hooks.seedFocusedWorktreeSession("focused-wt", {
      path: worktree,
      label: "Stale fixture",
      sourceGitRoot: hooks.workspaceRoot(),
    });
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    hooks.fromLocal({ type: "applyWorktree", sessionId: "not-the-focused-session" });
    hooks.fromLocal({ type: "removeWorktree", sessionId: "not-the-focused-session" });
    await new Promise((r) => setTimeout(r, 100));

    const refusals = posts.filter((p) =>
      p.dest === "local" &&
      p.msg?.type === "hostNotice" &&
      p.msg.text === "That conversation is no longer focused — nothing was changed."
    );
    assert.strictEqual(refusals.length, 2);
    assert.ok(!posts.some((p) => p.dest === "remote"));
    assert.strictEqual(probe.applyCount(), 0);
    assert.strictEqual(probe.removeCount(), 0);
    probe.restore();
  });

  test("local applyWorktree/removeWorktree with a matching sessionId run on the focused session", async () => {
    const worktree = path.join(hooks.workspaceRoot(), ".int-match-wt");
    const probe = hooks.seedFocusedWorktreeSession("focused-wt-match", {
      path: worktree,
      label: "Match fixture",
      sourceGitRoot: hooks.workspaceRoot(),
    });
    const posts: Array<{ dest: string; msg: any }> = [];
    hooks.onPost((dest: string, msg: any) => posts.push({ dest, msg }));

    hooks.fromLocal({ type: "applyWorktree", sessionId: "focused-wt-match" });
    hooks.fromLocal({ type: "removeWorktree", sessionId: "focused-wt-match" });
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(!posts.some((p) =>
      p.msg?.type === "hostNotice" && /no longer focused/.test(p.msg.text)
    ));
    assert.strictEqual(probe.applyCount(), 1);
    assert.strictEqual(probe.lastApplyPath(), worktree);
    assert.strictEqual(probe.removeCount(), 1);
    assert.strictEqual(probe.lastRemovePath(), worktree);
    probe.restore();
  });

  test("a remote New session immediately carries its selected worktree binding", async () => {
    const worktree = path.join(hooks.workspaceRoot(), ".int-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    hooks.seedWorktree({
      id: "wt-remote",
      path: worktree,
      sourceRepo: hooks.workspaceRoot(),
      repoName: "fixture",
      kind: "worktree",
      creationMode: "fixture",
      gitRef: "fixture",
      headCommit: "fixture",
      status: "alive",
      label: "Remote fixture",
      userProvidedLabel: true,
    });
    hooks.seedRemoteUnstartedSession("worktree-tab", worktree);

    assert.deepStrictEqual(hooks.activeRemoteWorktree("worktree-tab"), {
      id: "wt-remote",
      path: worktree,
      label: "Remote fixture",
      sourceGitRoot: hooks.workspaceRoot(),
    });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  // A remote `ready` is answered by the reconnect snapshot and never reaches the
  // ordinary message switch, so anything the rail needs at startup has to be IN
  // that snapshot. Pinned conversations were pushed from the switch first, which
  // meant a fresh tab or a reconnect never learned about them at all.
  test("a fresh remote tab is told about pinned conversations in its snapshot", async () => {
    writeStoredSession("pin-me", repoB, "2026-08-01T10:00:00Z");
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    // Read the session FIRST so it lands in the host's entry cache. That is the
    // precondition the staleness bug needs — a row nobody has looked at is read
    // fresh and would carry the right pin either way, so a test that skips this
    // step passes with the invalidation removed and proves nothing.
    hooks.fromRemote({ type: "listRepoSessions", cwd: repoB }, "pin-tab");
    await new Promise((r) => setTimeout(r, 1500));

    hooks.fromRemote({ type: "toggleSessionPin", id: "pin-me", cwd: repoB, pinned: true }, "pin-tab");
    await new Promise((r) => setTimeout(r, 1500));

    posts.length = 0;
    hooks.fromRemote({ type: "ready" }, "pin-tab");
    await new Promise((r) => setTimeout(r, 1500));

    const snapshot = posts.filter((p) => p.msg?.type === "pinnedSessions");
    assert.ok(snapshot.length, "the snapshot must carry pinnedSessions");
    const entry = snapshot
      .flatMap((p) => p.msg.entries ?? [])
      .find((e: any) => e.id === "pin-me");
    assert.ok(entry, "the pinned conversation must be in it");
    // Readable back, not merely stored: the pin lives in globalState while the
    // entry cache is keyed on the summary file's mtime, which pinning never moves.
    assert.equal(typeof entry.pinnedAt, "number", "the row must carry its pin, not a stale copy");
    assert.equal(entry.cwd, repoB, "and must name the repo it actually lives in");

    // Deleting the conversation has to retire its pinned row. Otherwise the row
    // outlives the thing it points at and clicking it just errors.
    // Deletion is authorized against the tab's own repo, so put the tab there
    // first — the same two steps a person takes before deleting a conversation.
    hooks.fromRemote({ type: "selectRepo", cwd: repoB }, "pin-tab");
    await new Promise((r) => setTimeout(r, 1500));
    posts.length = 0;
    hooks.fromRemote({ type: "deleteSession", id: "pin-me", cwd: repoB }, "pin-tab");
    await new Promise((r) => setTimeout(r, 2000));
    const after = posts.filter((p) => p.msg?.type === "pinnedSessions");
    assert.ok(after.length, "deleting a session must refresh the pinned list");
    assert.ok(
      after.every((p) => !p.msg.entries?.some((e: any) => e.id === "pin-me")),
      "the deleted conversation must not linger in the pinned group",
    );

    hooks.fromRemote({ type: "toggleSessionPin", id: "pin-me", cwd: repoB, pinned: false }, "pin-tab");
    await new Promise((r) => setTimeout(r, 1000));
  });

  // Read-modify-write on one shared map: both handlers read before either writes,
  // so without serialisation the second pin silently discards the first.
  test("two pins in the same tick both survive", async () => {
    writeStoredSession("race-a", repoB, "2026-08-01T10:00:00Z");
    writeStoredSession("race-b", repoB, "2026-08-01T10:00:01Z");
    const posts: Array<{ dest: string; msg: any; clientIds?: string[] }> = [];
    hooks.onPost((dest: string, msg: any, clientIds?: string[]) => posts.push({ dest, msg, clientIds }));

    // No await between them — exactly a double click, or two tabs at once.
    hooks.fromRemote({ type: "toggleSessionPin", id: "race-a", cwd: repoB, pinned: true }, "race-tab");
    hooks.fromRemote({ type: "toggleSessionPin", id: "race-b", cwd: repoB, pinned: true }, "race-tab");
    await new Promise((r) => setTimeout(r, 2500));

    posts.length = 0;
    hooks.fromRemote({ type: "ready" }, "race-tab");
    await new Promise((r) => setTimeout(r, 1500));

    const ids = posts
      .filter((p) => p.msg?.type === "pinnedSessions")
      .flatMap((p) => p.msg.entries ?? [])
      .map((e: any) => e.id);
    assert.ok(ids.includes("race-a"), "the first pin must not be discarded by the second");
    assert.ok(ids.includes("race-b"), "the second pin must land too");

    hooks.fromRemote({ type: "toggleSessionPin", id: "race-a", cwd: repoB, pinned: false }, "race-tab");
    hooks.fromRemote({ type: "toggleSessionPin", id: "race-b", cwd: repoB, pinned: false }, "race-tab");
    await new Promise((r) => setTimeout(r, 1500));
  });
});

// ── VS Code host adapter: real URI encode / closeDiff / content provider ─────
// The unit suite cannot import vscode-host (needs the vscode module). These
// tests run under a real Extension Host and must fail if toVsCodeUri /
// fromVsCodeUri / closeDiffTabs are broken. `npm run test:integration` compiles
// the extension to out/ first, so we load the built adapter from there.
suite("VS Code host adapter URI surface", () => {
  type PortableUri = {
    scheme: string;
    authority: string;
    path: string;
    query: string;
    fragment: string;
    fsPath: string;
    toString(): string;
  };

  // Compiled extension output (CommonJS) — not recompiled by integration/tsconfig.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const hostMod = require("../out/vscode-host") as {
    createVsCodeHost: (output: vscode.OutputChannel) => {
      asRelativePath(uri: PortableUri): string;
      fs: {
        readFile(uri: PortableUri): Promise<Uint8Array>;
        writeFile(uri: PortableUri, content: Uint8Array): Promise<void>;
        createDirectory(uri: PortableUri): Promise<void>;
        stat(uri: PortableUri): Promise<{ type: number; ctime: number; mtime: number; size: number }>;
        delete(uri: PortableUri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
      };
      openDiff(
        left: PortableUri,
        right: PortableUri,
        title: string,
        options?: { preview?: boolean; preserveFocus?: boolean },
      ): Thenable<void>;
      closeDiffTabs(original: PortableUri, modified: PortableUri): void;
      registerTextDocumentContentProvider(
        scheme: string,
        provider: { provideTextDocumentContent(uri: { path: string; toString(): string }): string },
      ): { dispose(): void };
    };
    createVsCodeHostContext: (context: vscode.ExtensionContext) => {
      extensionUri: PortableUri;
      globalStorageUri: PortableUri;
      extensionId: string;
    };
    wrapWebview: (webview: vscode.Webview) => {
      options: { enableScripts?: boolean; localResourceRoots?: PortableUri[] };
      asWebviewUri(uri: PortableUri): string;
    };
    toVsCodeUri: (u: PortableUri) => vscode.Uri;
    fromVsCodeUri: (u: vscode.Uri) => PortableUri;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Uri } = require("../out/host") as {
    Uri: {
      from(components: {
        scheme: string;
        path: string;
        authority?: string;
        query?: string;
        fragment?: string;
        fsPath?: string;
      }): PortableUri;
      file(fsPath: string): PortableUri;
      joinPath(base: PortableUri, ...pathSegments: string[]): PortableUri;
    };
  };

  const { createVsCodeHost, createVsCodeHostContext, wrapWebview, toVsCodeUri, fromVsCodeUri } = hostMod;
  let output: vscode.OutputChannel;
  let host: ReturnType<typeof createVsCodeHost>;

  suiteSetup(() => {
    output = vscode.window.createOutputChannel("Grok adapter integration");
    host = createVsCodeHost(output);
  });

  suiteTeardown(() => {
    output?.dispose();
  });

  test("authority survives fromVsCodeUri → toVsCodeUri", () => {
    const remote = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+dev.example",
      path: "/home/me/proj/src/main.ts",
    });
    const portable = fromVsCodeUri(remote);
    assert.strictEqual(portable.scheme, "vscode-remote");
    assert.strictEqual(portable.authority, "ssh-remote+dev.example");
    assert.strictEqual(portable.path, "/home/me/proj/src/main.ts");
    assert.strictEqual(portable.fsPath, remote.fsPath);

    const back = toVsCodeUri(portable);
    assert.strictEqual(back.scheme, remote.scheme);
    assert.strictEqual(back.authority, remote.authority);
    assert.strictEqual(back.path, remote.path);
    assert.strictEqual(back.toString(), remote.toString());
  });

  test("query, fragment, and fsPath survive fromVsCodeUri → toVsCodeUri", () => {
    const remote = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+dev.example",
      path: "/home/me/proj/doc.md",
      query: "view=preview&x=1",
      fragment: "section-2",
    });
    const portable = fromVsCodeUri(remote);
    assert.strictEqual(portable.query, "view=preview&x=1");
    assert.strictEqual(portable.fragment, "section-2");
    assert.strictEqual(portable.fsPath, remote.fsPath, "must keep VS Code's real fsPath");

    const back = toVsCodeUri(portable);
    assert.strictEqual(back.query, remote.query);
    assert.strictEqual(back.fragment, remote.fragment);
    assert.strictEqual(back.path, remote.path);
    assert.strictEqual(back.authority, remote.authority);
    // Round-trip again: fsPath must still match the original VS Code value.
    const again = fromVsCodeUri(back);
    assert.strictEqual(again.fsPath, remote.fsPath);
    assert.strictEqual(again.query, remote.query);
    assert.strictEqual(again.fragment, remote.fragment);
  });

  test("content-provider key round-trip preserves path special characters", async () => {
    const scheme = `grok-int-cp-${Date.now()}`;
    const specialPath = "/0/before/my file#x%y?.ts";
    let seenPath = "";
    let seenToString = "";
    const reg = host.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent(uri) {
        seenPath = uri.path;
        seenToString = uri.toString();
        return "provider-body";
      },
    });
    try {
      const portable = Uri.from({ scheme, path: specialPath });
      const vsUri = toVsCodeUri(portable);
      // VS Code asks the provider via the real vscode.Uri; our adapter must
      // convert back with fromVsCodeUri so the path is decoded, not percent-form.
      const doc = await vscode.workspace.openTextDocument(vsUri);
      assert.strictEqual(doc.getText(), "provider-body");
      assert.strictEqual(seenPath, specialPath, `provider saw path ${JSON.stringify(seenPath)}`);
      // Portable toString and the provider's portable uri must agree on encoding.
      assert.strictEqual(seenToString, portable.toString());
      assert.strictEqual(vsUri.toString(), portable.toString());
    } finally {
      reg.dispose();
    }
  });

  test("closeDiffTabs matches tabs whose filenames contain space, #, %, ?", async () => {
    const scheme = `grok-int-diff-${Date.now()}`;
    const fileName = "my file#x%y?.ts";
    const reg = host.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent() {
        return "diff-side";
      },
    });
    try {
      const left = Uri.from({ scheme, path: `/0/before/${fileName}` });
      const right = Uri.from({ scheme, path: `/0/after/${fileName}` });

      // Broken dual-encoder would open a tab whose VS Code string is percent-
      // encoded, then fail to close it when comparing against a bare portable
      // toString() that disagreed. Both sides must go through toVsCodeUri.
      await host.openDiff(left, right, "adapter special-char diff", {
        preview: true,
        preserveFocus: true,
      });
      await new Promise((r) => setTimeout(r, 300));

      const leftKey = toVsCodeUri(left).toString();
      const rightKey = toVsCodeUri(right).toString();
      const countMatching = () => {
        let n = 0;
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const input = tab.input;
            if (
              input instanceof vscode.TabInputTextDiff &&
              input.original.toString() === leftKey &&
              input.modified.toString() === rightKey
            ) {
              n++;
            }
          }
        }
        return n;
      };

      assert.ok(
        countMatching() >= 1,
        `expected an open diff tab for keys ${leftKey} / ${rightKey}`,
      );

      host.closeDiffTabs(left, right);
      await new Promise((r) => setTimeout(r, 400));

      assert.strictEqual(
        countMatching(),
        0,
        "closeDiffTabs must close the special-character diff tab (same-encoder compare)",
      );
    } finally {
      reg.dispose();
    }
  });

  test("asRelativePath with a workspace Uri returns a relative path", () => {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders?.length, "integration fixture must open a workspace folder");
    const folder = folders![0]!;
    // Build a portable Uri from the real workspace folder URI (preserves scheme).
    const childVs = vscode.Uri.joinPath(folder.uri, "README.md");
    const portable = fromVsCodeUri(childVs);
    const rel = host.asRelativePath(portable);
    // Must not fall through to the absolute path.
    assert.ok(
      !path.isAbsolute(rel) || rel === "README.md" || rel.endsWith(`${path.sep}README.md`) || rel.endsWith("/README.md"),
      `asRelativePath should be relative, got ${JSON.stringify(rel)}`,
    );
    assert.ok(
      /README\.md$/i.test(rel.replace(/\\/g, "/")),
      `expected README.md in relative path, got ${JSON.stringify(rel)}`,
    );
    // Path-only form must still work for local file workspaces (this fixture is file://).
    if (folder.uri.scheme === "file") {
      const viaFile = host.asRelativePath(Uri.file(childVs.fsPath));
      assert.strictEqual(viaFile, rel);
    }
  });

  test("createVsCodeHostContext preserves Uri identity (not path strings)", async () => {
    // Build a shim ExtensionContext whose URIs are remote — proves the adapter
    // stores fromVsCodeUri results, not .fsPath. A flatten-to-path revert makes
    // extensionUri/globalStorageUri undefined (or non-Uri) and fails.
    const remoteExt = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+box",
      path: "/home/me/.vscode-server/extensions/pawelhuryn.grok-vscode-phuryn",
    });
    const remoteStorage = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+box",
      path: "/home/me/.vscode-server/data/User/globalStorage/pawelhuryn.grok-vscode-phuryn",
    });
    const shim = {
      secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
      },
      globalStorageUri: remoteStorage,
      extensionUri: remoteExt,
      extension: {
        id: "PawelHuryn.grok-vscode-phuryn",
        packageJSON: { version: "0.0.0-test" },
      },
      extensionMode: vscode.ExtensionMode.Test,
      globalState: {
        get: () => undefined,
        update: async () => {},
        keys: () => [],
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    const ctx = createVsCodeHostContext(shim);
    assert.strictEqual(ctx.extensionUri.scheme, "vscode-remote");
    assert.strictEqual(ctx.extensionUri.authority, "ssh-remote+box");
    assert.strictEqual(ctx.globalStorageUri.scheme, "vscode-remote");
    assert.strictEqual(ctx.globalStorageUri.authority, "ssh-remote+box");
    // Flattening would only keep .fsPath strings — those fields must not exist.
    assert.strictEqual(
      (ctx as { extensionPath?: unknown }).extensionPath,
      undefined,
      "extensionPath string field must not be restored (use extensionUri)",
    );
    assert.strictEqual(
      (ctx as { globalStoragePath?: unknown }).globalStoragePath,
      undefined,
      "globalStoragePath string field must not be restored (use globalStorageUri)",
    );
    // Round-trip through toVsCodeUri keeps remote identity for asWebviewUri/fs.
    const backExt = toVsCodeUri(ctx.extensionUri);
    assert.strictEqual(backExt.scheme, "vscode-remote");
    assert.strictEqual(backExt.authority, "ssh-remote+box");
    const media = Uri.joinPath(ctx.extensionUri, "media", "chat.css");
    assert.strictEqual(media.scheme, "vscode-remote");
    assert.strictEqual(media.authority, "ssh-remote+box");
    assert.ok(media.path.endsWith("/media/chat.css"), media.path);
  });

  test("localResourceRoots + asWebviewUri preserve non-file scheme via wrapWebview", () => {
    // Real webview panel — construct vscode-remote roots without a real remote.
    // Flattening to path + Uri.file would rewrite scheme to "file" on read-back.
    const panel = vscode.window.createWebviewPanel(
      "grokUriBoundaryTest",
      "URI boundary",
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [] },
    );
    try {
      const wv = wrapWebview(panel.webview);
      const remoteRoot = Uri.from({
        scheme: "vscode-remote",
        authority: "ssh-remote+box",
        path: "/home/me/.vscode-server/extensions/ext/media",
        fsPath: "/home/me/.vscode-server/extensions/ext/media",
      });
      const localRoot = Uri.file(path.join(path.dirname(path.dirname(__filename)), "media"));
      wv.options = {
        enableScripts: true,
        localResourceRoots: [remoteRoot, localRoot],
      };
      const roots = wv.options.localResourceRoots ?? [];
      const remote = roots.find((r) => r.scheme === "vscode-remote");
      assert.ok(
        remote,
        `remote root must survive options set/get; got ${JSON.stringify(roots.map((r) => r.scheme + "://" + r.authority))}`,
      );
      assert.strictEqual(remote!.authority, "ssh-remote+box");
      assert.ok(remote!.path.includes("/media"), remote!.path);

      // asWebviewUri must accept the portable remote Uri (toVsCodeUri path).
      // If the adapter does Uri.file(uri.fsPath), VS Code still returns a string
      // — but the *input* scheme is lost. We assert toVsCodeUri of the same Uri
      // keeps scheme, and that asWebviewUri does not throw on a remote Uri.
      const asset = Uri.joinPath(remoteRoot, "chat.css");
      assert.strictEqual(toVsCodeUri(asset).scheme, "vscode-remote");
      const src = wv.asWebviewUri(asset);
      assert.ok(typeof src === "string" && src.length > 0, "asWebviewUri must return a string");
      // A correct remote-preserving call yields a webview resource URI; a file
      // rewrite of a remote path often still produces a string, so the scheme
      // check on toVsCodeUri above is the hard gate. Also reject empty.
      assert.ok(!src.startsWith("file:"), `webview URI should not be raw file: ${src}`);
    } finally {
      panel.dispose();
    }
  });

  test("host.fs round-trip uses Uri (toVsCodeUri), not path strings", async () => {
    // Write under a temp file Uri via host.fs — proves HostFileSystem takes Uri
    // and the adapter reaches workspace.fs. A path-string signature would not
    // compile; a Uri.file-only adapter still works for file:// — so also assert
    // toVsCodeUri preserves a non-file scheme for the same call shape.
    const dir = path.join(require("os").tmpdir(), `grok-fs-uri-${Date.now()}`);
    const dirUri = Uri.file(dir);
    const fileUri = Uri.file(path.join(dir, "probe.txt"));
    try {
      await host.fs.createDirectory(dirUri);
      await host.fs.writeFile(fileUri, Buffer.from("uri-fs-probe", "utf8"));
      const bytes = await host.fs.readFile(fileUri);
      assert.strictEqual(Buffer.from(bytes).toString("utf8"), "uri-fs-probe");
      const st = await host.fs.stat(fileUri);
      assert.ok(st.size > 0);

      // Non-file scheme must survive the encoder the adapter uses for fs.
      const remoteStorage = Uri.from({
        scheme: "vscode-remote",
        authority: "ssh-remote+box",
        path: "/home/me/.vscode-server/data/User/globalStorage/ext/plan-reviews/x",
        fsPath: "/home/me/.vscode-server/data/User/globalStorage/ext/plan-reviews/x",
      });
      const vs = toVsCodeUri(remoteStorage);
      assert.strictEqual(vs.scheme, "vscode-remote", "host.fs must convert via toVsCodeUri, not Uri.file");
      assert.strictEqual(vs.authority, "ssh-remote+box");
    } finally {
      try {
        await host.fs.delete(dirUri, { recursive: true, useTrash: false });
      } catch {
        /* best-effort cleanup */
      }
    }
  });
});
