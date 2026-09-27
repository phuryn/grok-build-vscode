// Shared by the live desktop instrument and offline tests. No provider is spawned here.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createRequire } from "node:module";
const { isSubagentToolCall } = createRequire(import.meta.url)("../media/webview-helpers.js");

/** Read executable comparisons, switch cases and literal .includes menus, not comments/types. */
export function extractKnownKinds(source, field, { roots, functions } = {}) {
  const tree = ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const values = new Set(), prefixes = new Set();
  const prop = n => ts.isPropertyAccessExpression(n) ? n.name.text
    : ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : undefined;
  const root = n => ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) ? root(n.expression) : n.getText(tree);
  const match = (n, aliases) => n && ((prop(n) === field && (!roots || roots.includes(root(n))))
    || (ts.isIdentifier(n) && aliases.has(n.text)));
  const literal = n => n && ts.isStringLiteralLike(n) ? n.text : undefined;
  const walk = (n, enabled = !functions, aliases = new Set(field === "method" ? ["method"] : [])) => {
    if (ts.isFunctionLike(n) || ts.isBlock(n)) aliases = new Set(aliases);
    if (ts.isFunctionLike(n)) for (const param of n.parameters) {
      if (ts.isIdentifier(param.name) && param.name.text !== field) aliases.delete(param.name.text);
    }
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) enabled = !functions || functions.includes(n.name.getText(tree));
    if (enabled) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        if (n.initializer && match(n.initializer, aliases)) aliases.add(n.name.text);
        else aliases.delete(n.name.text);
      }
      if (ts.isSwitchStatement(n) && match(n.expression, aliases)) for (const c of n.caseBlock.clauses) {
        if (ts.isCaseClause(c) && literal(c.expression) !== undefined) values.add(literal(c.expression));
      }
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
        if (match(n.left, aliases) && literal(n.right) !== undefined) values.add(literal(n.right));
        if (match(n.right, aliases) && literal(n.left) !== undefined) values.add(literal(n.left));
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const call = n.expression;
        if (call.name.text === "includes" && ts.isArrayLiteralExpression(call.expression) && match(n.arguments[0], aliases)) {
          for (const element of call.expression.elements) if (literal(element) !== undefined) values.add(literal(element));
        }
        if (call.name.text === "startsWith" && match(call.expression, aliases) && literal(n.arguments[0]) !== undefined) prefixes.add(literal(n.arguments[0]));
      }
    }
    ts.forEachChild(n, child => walk(child, enabled, aliases));
  };
  walk(tree);
  return { values: [...values].sort(), prefixes: [...prefixes].sort() };
}

/** A deliberately excluded notification has no executable case to extract. */
export function extractDocumentedIgnored(source) {
  const tree = ts.createSourceFile("ignored.ts", source, ts.ScriptTarget.Latest, true);
  const values = new Set();
  const visit = n => {
    for (const comment of ts.getLeadingCommentRanges(source, n.pos) ?? []) {
      const text = source.slice(comment.pos, comment.end);
      for (const match of text.matchAll(/`([\w/.-]+)` is deliberately[\s*]*EXCLUDED/g)) values.add(match[1]);
    }
    ts.forEachChild(n, visit);
  };
  visit(tree);
  return [...values].sort();
}

export function extractMetaNamespaces(source) {
  const tree = ts.createSourceFile("meta.ts", source, ts.ScriptTarget.Latest, true);
  const keys = new Set();
  const chain = n => ts.isPropertyAccessExpression(n) ? [...chain(n.expression), n.name.text]
    : ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) ? [...chain(n.expression), n.argumentExpression.text]
      : ts.isIdentifier(n) ? [n.text] : [];
  const visit = n => {
    const parts = chain(n), at = parts.indexOf("_meta");
    if (at >= 0 && parts[at + 1]) keys.add(parts[at + 1]);
    // Host helpers take the already-extracted envelope as a parameter named meta.
    if (parts[0] === "meta" && parts[1]) keys.add(parts[1]);
    ts.forEachChild(n, visit);
  };
  visit(tree);
  return [...keys].sort();
}

export function knownBoundaries(root, provider) {
  const shared = ["src/acp.ts", "src/acp-dispatch.ts", "src/sidebar.ts", "src/run-progress.ts", "src/subscription-usage.ts"];
  const files = [...shared, `src/${provider}-backend.ts`, ...(provider === "claude" ? ["src/claude-workflows.ts"] : []), "media/webview-helpers.js", "media/chat.js"];
  const texts = files.map(file => fs.readFileSync(path.join(root, file), "utf8"));
  const merge = sets => ({ values: [...new Set(sets.flatMap(s => s.values))].sort(), prefixes: [...new Set(sets.flatMap(s => s.prefixes))].sort() });
  const chat = fs.readFileSync(path.join(root, "media/chat.js"), "utf8");
  const ignoredUpdates = [...new Set(texts.flatMap(extractDocumentedIgnored))].sort();
  // Mirrors of intentional product omissions. Keep the owner and reason here:
  // these are audit decisions, not extra product handlers or blanket allowlists.
  const ignored = ["codex", "claude"].includes(provider) ? {
    "ACP metadata": {
      goal: "src/sidebar.ts send / src/run-progress.ts: CLI slash prompts own goals; the optional _session/goal control API is not a host control surface.",
      jetbrains: "src/acp.ts acpClientCapabilities: host advertises its fixed AIR subset; provider backend routes supported AIR events without consuming the server's AIR menu.",
      commandAction: "src/slash-filter.ts matchProviderSlashCommand / src/sidebar.ts send: commands are sent as slash text (adapter handles /plan and /goal); optional picker state/actions are not used.",
      permission: "src/acp.ts handleServerRequest preserves this envelope, but media/chat.js permission cards read standard toolCall/options. Optional AIR title/description are not rendered; the captured toolCall supplies the command/write title.",
      ...(provider === "claude" ? {
        "_claude/origin": "src/claude-backend.ts normalizeClaudeUpdate consumes usage_update regardless of the human-origin annotation; host accounting does not split usage by origin.",
        quota: "src/claude-backend.ts normalizeClaudePromptResult reads standard result.usage; duplicate _meta.quota.token_count/model_usage accounting is not a separate host quota surface.",
      } : {}),
      ...(provider === "claude" ? { steering: "src/claude-backend.ts steeringCapabilities explicitly returns unsupported; Claude uses queued prompts, not the advertised optional steering RPC." } : {}),
      ...(provider === "codex" ? {
        codex: "src/codex-backend.ts normalizeCodexUpdate uses native subagent_spawned/subagent_state_update, standard tool status and message chunks; captured threadStatus/collaboration/phase annotations are not UI inputs. No _meta.codex.subagent reader exists in this checkout.",
        quota: "src/codex-backend.ts normalizeCodexPromptResult reads standard result.usage; duplicate _meta.quota.token_count/model_usage accounting is not a separate host quota surface.",
      } : {}),
    },
    "ACP method": {
      "_auth/status_update": "src/acp.ts handleServerRequest ignores this notification; src/sidebar.ts provider connection checks use explicit credential probes, not unsolicited account labels as authentication proof.",
    },
  } : {};
  return {
    ignored,
    findings: provider === "codex" ? { "ACP metadata": {
      terminal_info: "src/codex-backend.ts preserves this metadata and terminal content references, but src/acp.ts and media/chat.js have no reader for the provider-owned terminal ID/cwd. Host terminal/* RPC handling is a different path.",
      terminal_output_delta: "No reader in src/ or media/: Codex's streamed exec output is not consumed. normalizeCodexUpdate only maps the final rawOutput.formatted_output; this is a missing live-output path.",
      terminal_exit: "No reader in src/ or media/: Codex's terminal exit metadata is not consumed. Standard tool status/final rawOutput can still render, but the provider terminal lifecycle is not handled.",
    } } : {},
    sources: files,
    updates: merge([...texts.map(s => extractKnownKinds(s, "sessionUpdate")), { values: ignoredUpdates, prefixes: [] }]),
    ignoredUpdates,
    methods: merge(texts.map(s => extractKnownKinds(s, "method", { functions: ["handleServerRequest", "parseAcpLine"] }))),
    namespaces: [...new Set(texts.flatMap(extractMetaNamespaces))].sort(),
    webview: extractKnownKinds(chat, "type", { roots: ["msg"] }),
    limitation: "Static extraction recognizes literal comparisons, switch cases, includes menus and startsWith prefixes. Unknowns stay flagged for review; a dynamic handler is never silently assumed. Metadata inventory is at namespace (first key under _meta) granularity, not arbitrary payload keys.",
  };
}

export function classifyBoundaries(events, known) {
  const inventory = new Map();
  const add = (boundary, kind, ignored = false, notification = true) => {
    if (typeof kind !== "string" || !kind) return;
    const menu = boundary === "ACP update" ? known.updates : boundary === "ACP method" ? known.methods : boundary === "webview" ? known.webview : { values: known.namespaces, prefixes: [] };
    const finding = known.findings?.[boundary]?.[kind];
    const reason = finding || ((boundary !== "ACP method" || notification) && known.ignored?.[boundary]?.[kind]);
    const recognized = !!reason || menu.values.includes(kind) || menu.prefixes.some(p => kind.startsWith(p));
    const status = finding ? "FINDING" : !recognized ? "UNKNOWN" : ignored || reason ? "KNOWN-IGNORED" : "KNOWN";
    const key = JSON.stringify([boundary, kind, status]);
    const row = inventory.get(key) ?? { boundary, kind, status, count: 0, ...(reason ? { reason } : {}) };
    row.count++;
    inventory.set(key, row);
  };
  const meta = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(meta); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === "_meta" && child && typeof child === "object") for (const namespace of Object.keys(child)) add("ACP metadata", namespace);
      // Inspect protocol envelopes, not arbitrary tool input/output or model text.
      if (["params", "result", "update", "toolCall", "models", "availableModels", "configOptions", "availableCommands", "content"].includes(key)) meta(child);
    }
  };
  for (const event of events) {
    const message = event.message;
    if (["receive", "acp-receive"].includes(event.direction)) {
      add("ACP method", message?.method, false, message?.id == null);
      const kind = message?.params?.update?.sessionUpdate;
      add("ACP update", kind, known.ignoredUpdates?.includes(kind));
      meta(message);
    } else if (["normalized", "routed"].includes(event.direction) && (event.ignored || event.message?.ignored)) {
      add("ACP update", message?.raw?.sessionUpdate, true);
    } else if (event.direction === "host-to-webview") add("webview", message?.type);
    else if (["protocol-error", "wire-error"].includes(event.direction)) add("ACP protocol", "invalid JSON-RPC");
  }
  const all = [...inventory.values()].sort((a, b) => a.boundary.localeCompare(b.boundary) || a.kind.localeCompare(b.kind));
  // An observed drop is a separate fact, not proof every instance was dropped.
  return { seen: all, unhandled: all.filter(r => ["UNKNOWN", "FINDING"].includes(r.status)), ignored: all.filter(r => r.status === "KNOWN-IGNORED") };
}

/** 0 = passed/selected subset, 1 = failure, 2 = only inconclusive checks. */
export function smokeOutcome(rows, failed = false) {
  if (failed || rows.some(r => r.result === "FAIL")) return { status: "FAIL", exitCode: 1 };
  if (rows.some(r => r.result === "INCONCLUSIVE")) return { status: "INCONCLUSIVE", exitCode: 2 };
  return { status: rows.some(r => r.result === "NOT RUN") ? "PARTIAL" : "PASS", exitCode: 0 };
}

/** Correlate provider results to cards; outputFilePath and launch summaries are not results. */
export function cardResultEvidence(cards, events) {
  const nonempty = value => typeof value === "string" && !!value.trim();
  const text = value => typeof value === "string" ? value : Array.isArray(value)
    ? value.map(v => text(v?.content ?? v?.text)).join("\n") : "";
  const results = new Set(), workflows = new Map(), subagents = new Map(), children = new Map();
  const updates = events.filter(e => ["receive", "acp-receive"].includes(e.direction))
    .map(e => e.message?.params?.update).filter(Boolean);
  // Link Claude's task and tool IDs to its rendered run ID, including late receipts.
  for (const u of updates) {
    const receipt = u._meta?.claudeCode?.toolResponse;
    if (receipt?.runId) for (const id of [receipt.taskId, u.toolCallId]) if (id) workflows.set(id, receipt.runId);
  }
  for (const u of updates) {
    const w = u._meta?.["muse/workflow"] ?? u;
    if (nonempty(w.resultSummary) || nonempty(w.result_summary)) results.add(`workflow:${w.run_id ?? w.runId ?? w.id}`);
    if (u.sessionUpdate === "async_task_state_update" && ["completed", "failed", "stopped"].includes(u.state) && nonempty(u.summary)) {
      const id = workflows.get(u.asyncTaskId) ?? workflows.get(u.toolCallId);
      if (id) results.add(`workflow:${id}`);
    }
    if (u.toolCallId && (u.rawOutput !== undefined || ["completed", "failed", "cancelled"].includes(u.status))) {
      const out = u.rawOutput;
      const output = text(out?.output ?? out?.text ?? out) || text(u.content);
      if (nonempty(output) && !/^subagent started in background\b/i.test(output.trim())) results.add(`tool:${u.toolCallId}`);
    }
    if (u.subagent_id && nonempty(u.output)) results.add(`child:${u.subagent_id}`);
  }
  for (const e of events) {
    const p = e.message?.params;
    if (["receive", "acp-receive"].includes(e.direction) && p?.update?.sessionUpdate === "agent_message_chunk"
        && nonempty(p.update.content?.text)) results.add(`child:${p.sessionId}`);
  }
  // Subagent cards lack a toolCallId DOM attribute. The real host's creation
  // order supplies that identity; never let one card's output bless another.
  for (const e of events) {
    if (e.direction !== "host-to-webview") continue;
    const m = e.message, call = m?.call;
    if (["toolCall", "toolCallUpdate"].includes(m?.type) && call?.toolCallId) {
      if (isSubagentToolCall(call) && !subagents.has(call.toolCallId)) subagents.set(call.toolCallId, false);
      if (call.child_session_id || call.subagent_id) children.set(call.toolCallId, call.child_session_id || call.subagent_id);
      if (subagents.has(call.toolCallId) && (call.rawOutput !== undefined || ["completed", "failed", "cancelled"].includes(call.status))) {
        const out = call.rawOutput;
        const output = text(out?.output ?? out?.text ?? out) || text(call.content);
        if (nonempty(output) && !/^subagent started in background\b/i.test(output.trim())) subagents.set(call.toolCallId, true);
      }
    }
    if (m?.type === "childStream" && m.event === "messageChunk" && nonempty(m.text)) {
      results.add(`child:${m.childSessionId}`);
    }
  }
  let index = 0;
  return cards.map(card => {
    const entry = card.kind === "subagent" ? [...subagents][index++] : undefined;
    const reported = card.kind === "workflow" ? results.has(`workflow:${card.id}`)
      : !!entry?.[1] || results.has(`tool:${entry?.[0]}`) || results.has(`child:${card.childSessionId ?? children.get(entry?.[0])}`);
    return { id: card.id ?? entry?.[0] ?? null, kind: card.kind, reported,
      reason: reported ? "result reported by the provider" : "no result reported by the provider" };
  });
}

/** Runs in Chromium or bootWebview's DOM; read the drawn DOM, never source payloads. */
export function readRenderedChat(doc = document) {
  const visible = el => {
    if (!el) return false;
    for (let at = el; at && at.nodeType === 1; at = at.parentElement) {
      if (at.hidden || at.getAttribute("aria-hidden") === "true") return false;
      const style = doc.defaultView.getComputedStyle(at);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (at.tagName === "DETAILS" && !at.open && !at.querySelector("summary")?.contains(el)) return false;
    }
    return true;
  };
  const text = el => {
    if (!visible(el)) return "";
    // innerText respects layout in Chromium; happy-dom needs explicit hidden pruning.
    const walk = node => node.nodeType === 3 ? node.textContent : visible(node)
      ? [...node.childNodes].map(walk).join(node.tagName === "OL" || node.tagName === "UL" ? "\n" : "") : "";
    return (typeof el.innerText === "string" ? el.innerText : walk(el)).trim();
  };
  const field = (el, selector) => text(el?.querySelector(selector));
  const cards = [...doc.querySelectorAll("#messages .subagent-card, #messages .workflow-card")].map(el => {
    const header = el.querySelector(".delegation-header");
    return {
      id: el.getAttribute("data-run-id") || el.getAttribute("data-tool-call-id") || el.id || null,
      childSessionId: el.getAttribute("data-child-session-id"),
      kind: el.classList.contains("subagent-card") ? "subagent" : "workflow",
      terminal: el.classList.contains("subagent-done") || el.classList.contains("run-progress-done"),
      header: { text: text(header), iconKind: field(header, ".delegation-kind"), iconPresent: !!header?.querySelector(".delegation-icon svg"),
        name: field(header, ".delegation-name"), status: field(header, ".delegation-status"), time: field(header, ".delegation-time"),
        dots: [...(header?.querySelectorAll(".workflow-dot, .blink-dots") ?? [])].map(dot => ({ text: text(dot), title: dot.getAttribute("title"), state: dot.getAttribute("data-state") || dot.className })),
        chevron: !!header?.querySelector(".delegation-chevron"), expanded: header?.getAttribute("aria-expanded") === "true" },
      activity: field(el, ".subagent-stream"), steps: field(el, ".workflow-phases"), agents: field(el, ".workflow-roster"),
      result: field(el, ".subagent-result-body, .workflow-output-body"),
      copy: [...el.querySelectorAll(".delegation-result .msg-copy-btn")].some(visible),
      meta: field(el, ".delegation-meta"), visibleText: text(el),
    };
  });
  const replies = [...doc.querySelectorAll("#messages .msg.agent .body")].map(text).filter(Boolean);
  return { cards, replies, finalReply: replies.at(-1) ?? "",
    errors: [...doc.querySelectorAll("#messages .msg.error, #messages .error-banner, #messages .tool-error")].map(text).filter(Boolean) };
}

export function assertRenderedScenario(scenario) {
  assert.equal(scenario.pageErrors.length, 0, `renderer threw: ${scenario.pageErrors.join("; ")}`);
  if (scenario.result === "N/A" || scenario.result === "INCONCLUSIVE") return;
  if (["subagent", "workflow"].includes(scenario.name)) {
    const cards = scenario.opened.cards.filter(c => c.kind === scenario.name);
    assert(cards.length, `no rendered ${scenario.name} card`);
    assert(cards.every(c => c.terminal), "rendered delegation card remains nonterminal");
    for (const card of cards) {
      const evidence = scenario.resultEvidence?.[scenario.opened.cards.indexOf(card)];
      assert(evidence, "missing provider result evidence for rendered card");
      if (evidence.reported) assert(card.result.trim(), "rendered delegation card has no non-empty result reported by the provider");
    }
  } else assert(scenario.opened.finalReply.trim(), "no rendered assistant reply");
}

export function completeRenderScenarios(scenarios, provider, reason = "not exercised: desktop run stopped", selectedScenario) {
  const result = [...scenarios];
  for (const name of ["plain reply", "subagent", "workflow", "delivery prompt"]) {
    if (result.some(s => s.name === name)) continue;
    const na = name === "subagent" && provider === "muse" ? "Muse delegation is a workflow"
      : name === "workflow" && provider === "codex" ? "Codex has no workflows"
        : name === "delivery prompt" && provider !== "muse" ? "Muse-specific admission regression" : undefined;
    const excluded = selectedScenario && name !== selectedScenario && !(selectedScenario === "workflow" && name === "delivery prompt");
    result.push({ name, result: na ? "N/A" : excluded ? "NOT RUN" : "FAIL", reason: na || (excluded ? "excluded by --scenario; not release validation" : reason), pageErrors: [] });
  }
  return result;
}

export function renderReportMarkdown(report) {
  const lines = [];
  const short = value => value.length > 700 ? `${value.slice(0, 700)}… [full text in JSON]` : value;
  if (report.boundaries.unhandled.length) lines.push("# UNHANDLED", ...report.boundaries.unhandled.map(r => `- ${r.status || "UNKNOWN"} ${r.boundary}: ${r.kind} (${r.count})${r.reason ? ` — ${r.reason}` : ""}`), "");
  lines.push(`# ${report.provider}: render smoke`, `Route: ${report.route}`, "");
  if (report.pageErrors?.length) lines.push("## Renderer errors", ...report.pageErrors.map(e => `PAGE ERROR: ${e}`), "");
  for (const s of report.scenarios) {
    lines.push(`## ${s.name}: ${s.result}`, s.reason || "", ...s.pageErrors.map(e => `PAGE ERROR: ${e}`));
    for (const [i, card] of (s.closed?.cards ?? []).entries()) {
      const opened = s.opened?.cards[i];
      lines.push(`Closed ${card.kind}: ${card.header.text}; icon=${card.header.iconKind}; dots=${JSON.stringify(card.header.dots)}; chevron=${card.header.chevron}`,
        `Opened: activity=${short(opened?.activity || "(none)")}; steps=${short(opened?.steps || "(none)")}; agents=${short(opened?.agents || "(none)")}`,
        `Result: ${short(opened?.result || "(empty)")}; ${s.resultEvidence?.[i]?.reason || "provider result evidence unavailable"}`, `Copy=${opened?.copy}; meta=${opened?.meta || "(none)"}`);
    }
    lines.push(`Assistant: ${short(s.opened?.finalReply || "(none)")}`, `Visible errors: ${(s.opened?.errors ?? []).join("; ") || "(none)"}`, "");
    if (s.postDeliveryTranscript) lines.push(`After delivery probe: ${short(s.postDeliveryTranscript.replies.join("\n\n") || "(none)")}`, "");
  }
  lines.push("## Known but ignored", ...report.boundaries.ignored.map(r => `- ${r.boundary}: ${r.kind} (${r.count})${r.reason ? ` — ${r.reason}` : ""}`));
  if (!report.boundaries.ignored.length) lines.push("None observed.");
  lines.push("", "Full boundary inventory and untruncated DOM text are in render-report.json. Content correctness is for the human/agent judge.");
  return lines.join("\n");
}
