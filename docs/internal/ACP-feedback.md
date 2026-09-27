# Grok CLI over ACP — current field feedback

Feedback for the xAI team from a thin ACP client (`grok agent stdio`, JSON-RPC over stdio). It
carries open behavior only, plus a short record of what has closed. The 0.2.3–0.2.112 record is
[archived separately](ACP-feedback-through-0.2.112.md); headings below cite the archive section
they continue.

**Current basis (2026-07-31):** grok CLI **0.2.117** (`f1c0609308`), re-probed against an
authenticated account on Windows 11. **Nine of the eleven sections below carry fresh 0.2.117
evidence.** Two do not — §10 (needs a 403) and §11 (needs a subagent run) — and two further
sub-claims keep an older build: the 429 retry delay in §5 and the cross-product settings merge in
§9. Everything unconfirmed on this build is labelled in place and summarized under *Coverage of
this pass*; nothing here is asserted as current on evidence we did not actually take.

**A 1.0.5 pass ran on 2026-08-18** (grok CLI **1.0.5** `5115b46bc9`, one Windows 11 host).
§14 and §15 are new and entirely 1.0.5. **§2, §3, §6 and §7 were re-run in full and all still hold**
— §7's fixed headline has not regressed, though its illustrative counts moved and are corrected.
**§5, §8, §10 (partly), §11, §12 and §13 were also re-run** — and three sub-claims turned out to be
fixed and have been withdrawn: `session/load` no longer replays internal turns as user content,
child sessions no longer appear as top-level rows in `_x.ai/session/list`, and auto-titles now
refresh after substantive work. §4 gained three findings and had its method sweep re-run in full;
§1's Plan passthrough was re-observed on a weaker sample; §9's reporting gap was re-confirmed. Permission behaviour is known to
vary by machine (§9), so §14's two enforcement claims are scoped to that host until a second one
confirms them. Everything not named here is still 0.2.117 evidence.

**A narrow 1.0.30 pass ran on 2026-09-13/14** (grok CLI **1.0.30**, one Windows 11 host), driving
`grok agent stdio` directly rather than through the extension. It added **§16** and **§17** and
touched nothing else. §16: two controlled runs of `ask_user_question`, one answered and one left to
expire, logging every frame stamped from the moment of the ask. §17: five prompts through a
throwaway project, granting `allow_always` once and watching which later commands re-asked, plus
the same directory driven under two path spellings. No other section was re-run, so everything else
keeps the build it is labelled with.

**§2's finding first changed shape on 1.0.4 (2026-08-15)**, after a user report: the image-aware
`read_file` had shipped, but delegating clients could not reach it. That remains true on 1.0.5,
where it was re-run in full.

## Evidence discipline

- **LIVE-VERIFIED** — observed on the named installed CLI build.
- **SOURCE-VERIFIED** — present in the named dated OSS snapshot.
- **SOURCE-ONLY** — changed upstream but never observed in a shipped binary.

Only LIVE-VERIFIED evidence retires an issue or a compatibility fallback. That distinction is
load-bearing in both directions. Truthful created-file rewind reporting exists in published source
and is still broken in the shipped binary (§3). Image-aware `read_file` was the same story until
1.0.4, where it shipped — and live probing then showed the section was not closed at all, only
relocated: the branch exists and is unreachable whenever the client delegates reads (§2). Source
evidence would have called that fixed; only live evidence found the real shape.

---

## 1. Plan mode still permits delegated mutation (archive §2.1)

**LIVE-VERIFIED 0.2.117.** Native exit verdicts now behave correctly: `{outcome:"cancelled"}` stays
in Plan, `"approved"` implements in the same turn, `"abandoned"` exits, and the model is told which
the user chose. That earlier issue is closed — thank you.

The safety boundary is not. In one 0.2.117 plan turn the CLI correctly refused the edit tool but
passed **five `terminal/create` requests** to the client. A normal ACP client executes those, so
Plan can mutate the workspace through the terminal while claiming edits are forbidden. This is the
**fourth consecutive build** we have measured it on. Published source explains the split:
`plan_mode_edit_gate` gates `AccessKind::Edit`, while bash, MCP and web fall through.

**Re-run on 1.0.5 (2026-08-18).** The passthrough itself is unchanged — a plan turn still delivered
`terminal/create` to the client, now on a **fifth consecutive build**. This sample was weaker than
0.2.117's: two requests, both read-only directory listings, so the *mutating* case was not
reproduced this time. We are not claiming the five-mutations measurement as current; we are claiming
the boundary still isn't server-side, which is what the ask below is about.

**Client cost/workaround:** we keep a plan-policy engine at `terminal/create` (load-bearing: Plan
still hands mutating shells to the client) and at `fs/write_text_file` (kept for 0.2.x delegated
writes and a later CLI that honours `writeTextFile` independently). On grok 1.x the write hook is
unreachable because withholding `readTextFile` also stops write delegation; native Plan already
refuses the edit tool. Terminal gating is the one safety workaround we cannot remove even though
native verdicts now work.

**Ask:** enforce one server-side Plan tool policy across edit, shell, MCP and web surfaces — allow
demonstrably read-only operations, reject potentially mutating ones before dispatch.

A smaller contract issue remains: after a cancelled verdict, same-turn re-planning is
nondeterministic. Identical prompts produced **1, 2 and 15** repeated `exit_plan_mode` asks within
one turn, so a client cannot treat a re-ask as a lifecycle guarantee.

## 2. Image `read_file` works only when the client does NOT delegate reads (archive §2.5)

**LIVE-VERIFIED 1.0.5** (2026-08-18) — re-run in full: the capability A/B, the write-delegation
column, all three content-level escape hatches, the inline-image size floor and the Plan-mode edit
refusal. First established on 1.0.4 (2026-08-15). Two things changed since
0.2.117: the image-aware `read_file` branch has **shipped**, and we have isolated why ACP clients
still cannot reach it. This section is no longer "the fix has not landed" — it is "the fix is
unreachable by delegation".

`initialize` still returns `promptCapabilities: {"image":false,"audio":false,"embeddedContext":true}`
while inline `{type:"image"}` prompt blocks work. Unchanged, and still a flag a client must ignore
to keep working vision.

The `read_file` half now depends entirely on one advertised capability. Same build, same 256×256
PNG, same prompt; the only variable is `clientCapabilities.fs`:

| `clientCapabilities.fs` | `read_file` on the PNG | `fs/write_text_file` delegated |
|---|---|---|
| `{readTextFile: true, writeTextFile: true}` | `FileReadError: "Cannot read binary file"` | yes |
| `{readTextFile: false, writeTextFile: true}` | `Read image file:` plus the image — model names the colour | **no** |
| capability omitted entirely | works, as above | no |

The shipped image branch lives on the CLI's own read path. When a client advertises
`fs.readTextFile`, `read_file` is routed to that text-only client method instead, and that path has
a binary guard but no image branch.

The second column is why this is a coin-flip, not a free lunch. `writeTextFile: true` is **not
honored independently**: with `readTextFile` withheld the CLI performs the write itself and issues
**no client fs requests at all**. A client cannot opt out of read delegation while keeping write
interception. We withhold `readTextFile` on a live-verified grok >= 1.0.4 (`acpClientCapabilities`) because the write
hook is already unreachable in Plan on this build (next table) and `exit_plan_mode` arrives with
`planContent` populated, so the plan-review card is fed by `req.plan` rather than the plan.md snoop.
0.2.x and Codex keep the delegated handshake — this workaround was not measured there, and 0.2.117
still sends `planContent: null`.

**Content-level escape hatches, all measured on 1.0.4, all closed** — no response a client returns
can make a delegated image read succeed:

| Attempt | Result |
|---|---|
| Answer `fs/read_text_file` with a JSON-RPC error, hoping the CLI falls back to its own reader | No fallback; our message is wrapped verbatim into `FileReadError` |
| Answer with structured `content: [{type:"image",…}]` | `Internal error: "failed to deserialize response"` — `content` is strictly a string |
| Answer with a `data:image/png;base64,…` string | Ignored; still `Cannot read binary file`, so the guard inspects the file itself rather than our response |

**What the delegation is actually worth, measured in Plan mode (1.0.4).** Our first reading — that
`fs.readTextFile` is load-bearing for the Plan write-gate, so the capability could not be dropped —
did not survive testing. Forcing the model to call both a write and a mutating shell command inside
Plan mode gives **identical results under both capability configurations**:

| Hook | `readTextFile: true` | `readTextFile: false` |
|---|---|---|
| `fs/write_text_file` | **never fires** | never fires |
| `terminal/create` | fires | fires |
| `session/request_permission` | fires (`kind: "execute"`) | fires (`kind: "execute"`) |

The `write` tool is refused by grok itself before any delegation — *"Rejected: file edits are not
allowed in plan mode - the only editable file is the plan file"* — so the client write-gate is
already unreachable in Plan mode on this build. And `terminal/create` plus `session/request_permission`
ride the **separate `terminal` capability**, so they are untouched by the `fs` flags. The hook that
covers the real §1 hole (bash still executes in Plan) does not depend on `fs.readTextFile` at all.

So the enforcement cost of dropping the capability is close to zero on this build. Plan review no
longer depends on the snoop: `exit_plan_mode` arrives with `planContent` fully populated, and the
host prefers `req.plan` over any snooped `lastPlanText`.

**Client cost/workaround:** `acpClientCapabilities` withholds `fs.readTextFile` for a live-verified grok >= 1.0.4,
pins that matrix in `test/acp.test.ts`, and pins the two live behaviours in
`research/image-read-capability-probe.cjs` (image read succeeds when the flag is withheld; Plan
still refuses file edits natively). 0.2.x, Codex, and an unknown version keep the delegated
handshake. User-attached images still go as inline pixel blocks. The "do not Read" hint stays on
that send path to cut transcript noise. Terminal plan-gating is untouched. This remains a
coin-flip between two documented capabilities, not a design — §1's shell hole is still open.

**New on 1.0.5, and it sharpens this ask.** With `fs` omitted entirely, the shipped branch returns a
real ACP `image` content block — `content:[{type:"image",data:"iVBORw0…",mimeType:"image/png"}]`,
with `rawOutput.ReadFile.ImageContent` beside it. So the shape a delegating client needs already
exists and is already correct; what is missing is routing that same block through the delegated
path. This is not "add an image format", it is "stop suppressing the one you already emit".

**Ask:** route a binary/image path through the shipped image branch **even when the read is
delegated** — a client advertising `fs.readTextFile` is offering to resolve text, not asking to
disable vision. Failing that, either honor `writeTextFile` independently of `readTextFile`, or add a
binary-capable client read method so delegation can carry pixels. Separately, still open from the
archive: advertise `image:true`; return generated media as structured `image`/`resource_link`
content instead of a path embedded in text or `rawOutput`; expose dropped-image errors on a
documented surface.

Re-confirmed on 1.0.4 and unchanged: an image below the 8×8 / 512-total-px floors is dropped, and
the model is left hunting for an attachment it never received (*"the image wasn't available (it was
1×1 and couldn't be processed)"*).

## 3. Rewind reports files it did not revert (archive §2.15)

**LIVE-VERIFIED 1.0.5** (2026-08-18); first seen 0.2.117, so this has now stood for three minor
versions with the fix present in published source. `_x.ai/rewind/execute` with `mode:"all"` can return a newly created path
in `reverted_files` while leaving that file on disk, so the response tells a client that more was
restored than actually was.

Published source deletes a file whose before-snapshot is missing and only then appends it to
`reverted_files`. That fix is **SOURCE-ONLY**; the shipped result is still wrong.

**Client cost/workaround:** our UI cannot state a restoration count or enumerate restored paths from
the response, so when the array is non-empty it says files were rolled back and warns that anything
created after that point may still be on disk. We also had to probe two undocumented semantics: the
target prompt is discarded inclusively, and the current tip is a legal target.

**Ask:** ship truthful created-file handling (or split `restored` from `createdLeftInPlace`),
document the discard-inclusive boundary, and advertise the rewind capability and its schema.

## 4. A large shipped surface is undiscoverable (archive §2.16, §2.2)

**LIVE-VERIFIED 0.2.117** (method existence by error code: `-32601` absent, `-32602`/success
present, run with known-present, known-absent and bare-prefix controls).

Routed and useful, advertised nowhere: `_x.ai/session/list`, `_x.ai/session/info`,
`_x.ai/session/fork`, `_x.ai/session/usage`, `_x.ai/session/state`, `_x.ai/session/import`,
`_x.ai/session/updates`, `_x.ai/rewind/points`, `_x.ai/hooks/list`, and
`_x.ai/compact_conversation` (returns `{}` — the position-independent compact clients otherwise have
to guess exists).

Push rails nothing announces: `_x.ai/settings/update`, `_x.ai/announcements/update`,
`_x.ai/models/update`, `_x.ai/sessions/changed`, `_x.ai/queue/changed`,
`_x.ai/mcp/servers_updated`, `_x.ai/mcp_initialized`, `_x.ai/mcp/init_progress`,
`_x.ai/mcp/server_status`, `_x.ai/session/prompt_complete`, plus the two
lifecycle rails — `_x.ai/session_notification` live and `_x.ai/session/update` on replay — whose
0.2.117 kinds include `tool_call_delta_chunk`, `response_completed`, `hook_execution`,
`pending_interaction`, `interaction_resolved`, `session_summary_generated` and `turn_completed`.

**Method sweep re-run on 1.0.5 (2026-08-18).** Everything previously found still exists —
`_x.ai/session/list`, `/info`, `/usage`, `/state`, `/import`, `/updates`, `_x.ai/rewind/points`,
`_x.ai/hooks/list`, `_x.ai/compact_conversation` — plus `_x.ai/session/fork`, `_x.ai/interject` and
`_x.ai/rewind/execute`, none of which regressed. **Three more turned up that we had never probed:**
`_x.ai/models/list`, `_x.ai/session/close`, and `_x.ai/mcp/list` — the last of which is the only
surface that reports managed connectors truthfully (§15). `_x.ai/session_notification` also carries a
`model_changed` kind not in the list above. The point is not the individual names; it is that a
routine re-probe of a *documented-nowhere* surface keeps finding load-bearing methods by accident.

`initialize` does advertise more than it used to (`x.ai/hooks`, `x.ai/fs_notify`,
`x.ai/capabilities.toolOverrides`, `modelState`, `defaultAuthMethodId`, `sessionCapabilities.list`,
and the flags `grokShell` / `voiceMode` / `cancelRewind` / `sessionRecap` / `x.ai/mcp/sdk` /
`x.ai/pluginDirs`) — but none of it names a method or a rail, so none of it makes the list above
discoverable.

Two slash commands that a generic client should not dispatch are still advertised on 0.2.117.
`/context` dispatches and emits **zero** output bytes — no inference, no content (LIVE-VERIFIED);
`/always-approve` flips the process-wide permission state (still advertised on 0.2.117;
SOURCE-VERIFIED 2026-07-16 for the mechanism). There is still no TUI-only or unsafe flag on an
advertised command, so every client ships its own denylist. Dispatch also still requires position 0:
sending `"Some editor-injected context.\n/session-info"` did not dispatch — the text went to the
model instead, taking the session from 5 472 to 16 047 context tokens.

**LIVE-VERIFIED 1.0.5 — the leader is a multi-client live-session transport, and nothing says so.**
`--leader` is documented as one row in a flags table ("Connect to a shared leader process"). Measured,
it does considerably more: two `grok agent --leader stdio` clients in the same `cwd`, the second
attaching mid-turn via `session/load`, **both stream the same live turn**. Matched pair, same prompt,
first client mid-turn in both arms: the second client received **107** `session/update` in 8s with
`--leader` against **1** with `--no-leader`. Either client can also drive — a prompt sent by the
second arrived at the first as a full turn including the second's own `user_message_chunk`. That is
the "two surfaces, one live session" capability clients have been asking for, shipped and unadvertised.
`grok agent serve` (WebSocket, `--bind`/`--secret`) exists on the same build and was not probed.

**LIVE-VERIFIED 1.0.5 — a completed `tool_call_update` drops its own identity.** Across `read`,
`search` and `execute` kinds, the initial `tool_call` carries `rawInput` + `title` + `_meta` (with
`kind` unset), the mid update carries a richer `rawInput`, and the **completed** update carries only
`sessionUpdate`, `toolCallId`, `status`, `content`, `rawOutput` — `title`, `kind` and `_meta` are all
absent, so a client must join on `toolCallId` to know what finished. Worth documenting rather than
changing; a client that filters updates on `kind` silently loses every completion.

Positive, and worth recording because our client was built against the opposite: **`session/load`
replays terminal output.** On 1.0.5 the replayed `tool_call` carries the command in `rawInput`, the
stdout in `content`, and the full result in `rawOutput` (`output_for_prompt`, `exit_code`,
`output_file`) — and the CLI persists it on disk under
`sessions/<cwd>/<id>/terminal/call-*.log`. Measured on 0.2.x this did not survive a load, which sent
us toward a bespoke client-side output store we no longer need.

**Client cost/workaround:** private method-name knowledge, `-32601` feature gates, payload probes,
send-reordering so commands land at position 0, and denylists for advertised commands. A rename or
prefix change silently breaks features.

**Ask:** publish an `initialize` capability set naming supported methods, push rails, versions and
schemas; mark commands that are TUI-only or unsafe for generic dispatch; document that xAI extension
methods are `_x.ai/...` on the wire; and accept a slash command anywhere in the first text block (or
provide a structured command field).

## 5. Context and usage numbers have misleading scopes (archive §2.3, §2.13)

**LIVE-VERIFIED 1.0.5 (2026-08-18); first established on 0.2.117.** The prompt **result**'s
`_meta.totalTokens` is a placeholder zero on commands that run no inference: a `/session-info` turn
returned `{"totalTokens":0,"modelId":"grok-4.6",…}` while its own prose reported
`16995 / 500000 tokens`. On a **real inference turn** 1.0.5 now populates it — but with the *turn's
usage total*, not the post-operation context size, alongside a new nested `usage` object
(`modelCalls`, `apiDurationMs`, `costUsdTicks`, `modelUsage`, `numTurns`). So the field is no longer
always-zero; it is now two different quantities depending on the turn.

**Also re-confirmed on 1.0.5**, and no longer at their older labels: the stale echo (the sibling
`_meta` usage fields repeat the *previous* inference turn byte-for-byte — now observed on
`/session-info` as well as `/compact`), a native `/compact` streaming **no content at all** while
compaction happens asynchronously afterwards (`chat_history.jsonl` 11 lines → 5 lines after the
wait), and the absence of any standard ACP `usage_update` notification.

**Two hazards measured on 1.0.5 that the old wording gets wrong.** The envelope is no longer simply
"the trustworthy one":

- **`_meta.totalTokens` carries two different quantities on different update kinds inside one
  turn** — `agent_thought_chunk` and `agent_message_chunk` reported 6753 (context) while
  `available_commands_update` reported 16909 (turn usage), in the same turn. A client reading
  "the latest envelope" gets whichever arrived last.
- **The context figure resets on `session/load`** and understates until a turn completes in that
  process: a session reporting 16995 reported 6839 after reload, then billed `inputTokens: 16995` on
  the very next turn. Within a turn it also lags by one model call.

`_x.ai/session/usage` is scoped to the agent **process**, not the session. Re-measured on 1.0.5
(2026-08-18), identical in shape to 0.2.117: `totalTokens 33941, numTurns 2, costUsdTicks 72709000`
(with a welcome per-model `modelUsage` breakdown), then **all zeros** on the next call after
`session/load` in a fresh process, and `numTurns: 1` after one further turn in a session that had had
three. A cumulative-looking counter
that silently resets under-reports while still looking authoritative. Published source defines the
fixed-point scale as **10^10 ticks per USD**, so that captured cost is `$0.0180384`.

**Client cost/workaround:** we discard placeholder zeros, read context size from `session/update`
envelopes (with `signals.json` retained only to seed a cold restore), and maintain our own persisted
per-turn ledger because the cumulative-looking RPC is process-scoped. Tokens and `costUsdTicks`
share that ledger, so rewind subtracts both. No hidden `/session-info` turn or prose parser remains.

**Ask:** return the true post-operation context size on the prompt result, including after
`session/load`; emit a standard `usage_update`; and either persist `_x.ai/session/usage` across load
or rename it `process/usage`.

Related quota gap, **last LIVE-VERIFIED 0.2.103, SOURCE-VERIFIED 2026-07-29, not re-checked on
0.2.117** (we cannot force a rate-limit without abusing the account): HTTP 429 maps to `-32003`
without the available retry delay. Please preserve `retry_after_secs` in error data.
The account-quota gap is now partly covered: the owner's 2026-09-13 probe verified
`_x.ai/billing` through our client. It exposes one weekly window through
`config.creditUsagePercent` and `config.currentPeriod`; plain `x.ai/billing` is
method-not-found. We consume only that capacity window, using `currentPeriod.end`
as reset time, and omit financial account detail. See
[subscription usage](../../research/subscription-usage.md) for the provider
differences and the event-driven cache that avoids masking prompt idle timeouts.

## 6. Edit diff delivery is inconsistent, and `old_line` is a post-edit coordinate (archive §2.10)

**LIVE-VERIFIED 1.0.5** (2026-08-18), first established on 0.2.117, across five edit shapes (single replace, multi-line region replace,
whole-file overwrite, new file, and a replace-all whose replacement grows each site).

- **The three delivery paths carry different metadata, never the same.** The pre-write echo carries
  block-level `_meta:{old_line,new_line}` and no `details[]`; the completed update carries
  `_meta:{details:[…]}` and **no** block-level `old_line`; `session/load` replay carries only
  `details[]`. A client seeding from the echo's shape gets nothing on replay, and vice versa.
- **The first diff is wrong for whole-file writes.** On an overwrite the echo's diff block has
  `oldText: ""` while the completed update carries the real 58-byte prior content — and the echo's
  `_meta` key is absent entirely, so there are no line numbers at all. A client painting the earliest diff paints a false
  "new file".
- **`details[].old_line` is located in post-edit text.** For a replace-all where each replacement
  adds two lines, the ground-truth pre-edit occurrences are lines 2, 4, 6, but `details[]` reports
  `old_line` 2, 6, 10 — identical to `new_line`. The pre-edit line number is therefore not
  recoverable from the payload at all.
- `details[]` does now enumerate every replaced site (12 of 12, at real 1-based lines 3, 5, … 25),
  which is right and worth keeping. It carries `line_prefix` plus `context_before`/`context_after`,
  but no `line_suffix` and no full changed line.

**Client cost/workaround:** we key idempotency on diff content, treat a missing `status` as
provisional, merge three incompatible metadata shapes, and reconstruct whole-file context from disk
when it still matches.

**Ask:** send one authoritative diff or mark the echo explicitly provisional; use identical metadata
on echo, completion and replay; include the full old/new changed line (or `line_suffix`); and define
the coordinate space — if `old_line` is post-edit, say so, or add a genuine pre-edit line.

## 7. Fork's cut point is undocumented and moved between builds (archive §2.12)

**LIVE-VERIFIED FIXED, re-confirmed 1.0.5 (2026-08-18) — the headline is a thank-you.** `_x.ai/session/fork` with
`targetPromptIndex` now truncates **both** logs at the same boundary. On a 2-prompt session a full
fork copied 11 chat messages / 10 updates; `targetPromptIndex: 0` copied 8 / 5, and the second
prompt's text is absent from `chat_history.jsonl` **and** `updates.jsonl` on disk. The 0.2.101
failure — the model forgetting turns that `session/load` still replayed to the user — is gone.

Two residual issues stop us from shipping per-message branching:

- **The index base changed with no signal.** On 0.2.101, `targetPromptIndex: 1` against a 2-prompt
  session cut to the first prompt. On 0.2.117 and again on 1.0.5 the identical call copies the *whole* session, and `0`
  is the value that cuts there. Same wire call, different cut point, nothing on the wire
  distinguishes them.
- **Out-of-range is silent.** `targetPromptIndex: 99` returns a successful **full** copy rather than
  an error, so a client that miscounts gets a whole-session fork and never learns.

**Client cost/workaround:** we ship whole-session fork only and withhold per-message branching,
because we cannot pin a cut point across builds.

**Ask:** document the index base, return the effective cut point in `ForkSessionResponse` so a
client can validate its own replay, and reject an out-of-range index instead of silently copying
everything.

## 8. The shell dialect comes from the agent's environment, not the client (archive §2.9)

**LIVE-VERIFIED 0.2.117, re-confirmed 1.0.5** (2026-08-18: with `GROK_SHELL` unset the model's first
user message carried `<user_info> … Shell: powershell`; set to `bash` it carried `Shell: bash`, same
host, nothing in `clientCapabilities` consulted). In ACP mode grok hands raw commands to the client to execute, but every
model-facing shell signal is derived from the grok host process. Measured: with `GROK_SHELL` unset
the model's first user message carries `Shell: powershell`; with `GROK_SHELL=bash` it carries
`Shell: bash`. Nothing in `clientCapabilities` is consulted, so detection and execution can diverge
and the model can emit POSIX syntax for a PowerShell executor (originally observed on 0.2.101).
`initialize._meta.grokShell` is advertised as `true`, but it is a constant — identical with
`GROK_SHELL` unset and set — so it does not report the resolved dialect either.

**Client cost/workaround:** on Windows we resolve the shell we will actually run and set the
undocumented `GROK_SHELL` variable in the stdio process's environment. Without it each mismatch
costs an extra tool call and model turn; rewriting arbitrary commands client-side is not safe.

**Ask:** document `GROK_SHELL`, and preferably accept and honor a client-declared terminal dialect
during `initialize`.

## 9. Effective permission policy is visible only in fragments (archive §2.11, §2.7)

**LIVE-VERIFIED 0.2.117, re-confirmed 1.0.5** (`permission_mode` and
`auto_permission_mode_enabled` both still `null` on a default config on 2026-08-18).
`_x.ai/settings/update` carries `permission_mode`
and `auto_permission_mode_enabled`, both `null` on a default config, so a client cannot distinguish
"not set" from "not reported" — and neither field names the winning rule or its source file. There
is no getter: `_x.ai/settings`, `_x.ai/settings/get`, `_x.ai/settings/list`, `_x.ai/permissions/get`,
`_x.ai/permission/mode` and `_x.ai/session/config` all return `-32601`.

**Last LIVE-VERIFIED 0.2.99–0.2.101; SOURCE-VERIFIED 2026-07-16** for the underlying cause, which we
did not re-run on 0.2.117 because reproducing it means mutating another product's config: permission
prompts vary by machine because grok merges several invisible policy sources — Grok project grants,
managed settings, and Claude Code's `~/.claude/settings*.json`. An `Edit`, `Write` or `Bash` allow
granted to a different product can bypass `session/request_permission` before this client is
involved.

**Client cost/workaround:** review is decoupled from approval and rendered from every diff update.
To explain why no approval arrived, a client would have to reimplement the CLI's policy-resolution
stack — and still could not manufacture the missing choice.

**Ask:** report the effective per-session decision policy, the winning rule and its source file, and
make the cross-product Claude settings import explicit rather than silent.

## 10. Entitlement failures are still prose-only (archive §2.14)

**Last LIVE-VERIFIED 0.2.101; SOURCE-VERIFIED 2026-07-29; not re-checked on 0.2.117** — we cannot
provoke a 403 on an entitled account. A 403 entitlement failure is returned as generic
`-32603 internal_error`, sharing a bucket with policy blocks and server faults, and the only
discriminator is mutable prose.

Subscription *state* is observable — `initialize._meta.defaultAuthMethodId` settled "which credential
won?" on 0.2.112, and `_x.ai/settings/update` carries `subscription_tier_display`, `allow_access` and
`gate_message`/`gate_url`/`gate_label` (all re-confirmed present on 1.0.5, 2026-08-18). None of that
classifies the error that ended a turn.

**The mechanism this ask wants already exists on 1.0.5 — for one family.** Error envelopes now carry
`data`, and the filesystem family is fully structured:
`session/load` → `{"code":-32603,"message":"Path not found.","data":{"code":"FS_NOT_FOUND","detail":"…(os error 3)"}}`.
Other families still carry `data` as a bare string (`"unknown session id"`, `"unknown model id"`).
So the ask below is no longer "invent a convention" but "extend the one you already ship".

**Client cost/workaround:** conservative text heuristics, to keep a subscription failure in chat
instead of dropping the user into an unfixable login loop.

**Ask:** extend the structured `data: {code, detail}` convention you already ship for the filesystem
family to the entitlement, policy and server-fault families.

The 403 shape itself stays at its 0.2.101 label: we have never been able to provoke a 403 on an
entitled account, and will not manufacture one by abusing quota.

## 11. Restore and subagent normalization remain client work (archive §2.6, §2.4)

**LIVE-VERIFIED 1.0.5 (2026-08-18)** — re-probed in full, both halves. The subagent half cost about
fifty seconds of wall clock, not the several long delegated turns we had assumed, so the old excuse
for leaving it unverified is withdrawn.

**Two things we used to report here are fixed — thank you.** `session/load` no longer replays
internal turns as user content: a session whose `chat_history.jsonl` held an environment preamble,
three `<system-reminder>` turns and a `<user_query>`-wrapped prompt replayed **exactly one**
`user_message_chunk`, unwrapped, with zero hits for any of those markers in a full dump of the
replay. And child sessions no longer appear as top-level rows: `_x.ai/session/list` for a cwd
containing a spawned subagent returned **one** row, the parent. The child is still persisted as a
sibling directory on disk (`summary.json` carries `session_kind: "subagent"`), so only a
disk-scraping client still needs a filter — the RPC is clean.

What still stands:

- **Resolved permissions do not replay.** Two permission requests answered `allow-once` in a live
  session; after `session/load` in a fresh process, zero replayed. (Reproducing this on 1.0.5 needs a
  *mutating* command — read-only shell like `echo` raises no permission request at all.)
- **Result text duplicates structured output.** The completing `tool_call_update` carries the answer
  as wrapped text (`<subagent_meta>`, `<subagent_result>` blocks), again in `rawOutput`, and a third
  time on `subagent_finished`.
- **A background start ack is marked completed before the result exists.** At t+4.5s:
  `{"status":"completed","rawOutput":{"type":"Text","text":"Subagent started in background…"}}`. The
  real output arrived at t+11.4s on `subagent_finished`.

**New on 1.0.5, and it looks unintended:** a `session/update [available_commands_update]` arrives on
the *parent's* connection carrying the **child's** `sessionId` — a session the client never opened
and has no way to route.

The lifecycle rails are richer than the archive records: `subagent_spawned` now carries
`parent_prompt_id`, `capability_mode` and `role`; there is a new `subagent_progress` kind
(`duration_ms`, `turn_count`, `tool_call_count`, `tokens_used`, `context_usage_pct`, `tools_used`);
and `subagent_finished` gained `will_wake`. All still undocumented.

**Client cost/workaround:** persisted and re-injected interaction state, wrapper stripping, task-id
correlation, and separate live/replay lifecycle routing. The replay filter and the `sessionKind`
filter are both retirable on 1.0.5.

**Cross-provider client mapping (2026-09-26 captures):** Codex's ACP subagent
opt-in replaces synthetic Start/Complete tool rows and replays child sessions;
Claude's opt-in loses the Agent call on replay, so the client retains its
default handshake and normalizes the hand-back. Muse workflow snapshots use
provider metadata on a standard ACP update, then the shared workflow card.
Codex's bundled initialize schema strips `subagents`, so the client also sends
AIR `nativeSubagentSessions`; `asyncTasks` remains disabled. Claude's workflow
card is a named, unpinned launch receipt. A task notification can finish it via
matching task/tool-use/run IDs; an uncorrelated answer leaves it launched.
The replay XML wake-up is a notice. [Captured shapes and normalization](../../research/subagent-workflow-shapes.md#client-mappings).

**Ask:** persist resolved interactions across `session/load`; make a background "completed" mean
completed; stop duplicating structured output in text; do not push a child session's updates down the
parent's connection; and document the `_x.ai/session_notification` lifecycle kinds, including the new
`subagent_progress` and `will_wake`.

---

## 12. `ask_user_question` promises a free-text "Other" that never arrives (new)

**LIVE-VERIFIED 0.2.117, re-confirmed 1.0.5** (2026-08-18). The agent-facing description of `ask_user_question` tells the model that
every question automatically carries an "Other" choice accepting free text, and that the typed text —
not the literal label — is what comes back. Over ACP, `x.ai/ask_user_question` requests carry only
the options the model itself supplied. A user therefore has no way to answer anything the listed
options do not cover, which is precisely when a clarifying question matters
([#85](https://github.com/phuryn/grok-build-vscode/issues/85)).

The response side is not the problem: `answers` is a `HashMap<String,String>` keyed by question
text, so a client can put typed text where a label would go and it deserializes. The gap is that
nothing tells the client the option should exist, and `annotations.notes` / `chat_about_this` are
undocumented enough that neither reads as the sanctioned channel.

**Client cost/workaround:** we append the missing option in the webview and send the typed text in
place of the label. That leaves us guessing at a wording the CLI might one day use — the day grok
starts sending its own, under any label we do not recognise, the user sees two of them.

**New on 1.0.5:** the request gained a `toolCallId` (so a client no longer correlates by question
text) and an undocumented `mode` field (`"default"` observed). `mode` is the obvious home for the
structural marker this ask wants. The description also now instructs the model to append
"(Recommended)" to a label, so CLI-authored labels can carry suffixes a client must not collide with.

**Ask:** inject the promised "Other" server-side so it reaches clients with the request; failing
that, document which of `answers`, `annotations.notes` and `chat_about_this` a free-text answer is
supposed to travel in, and mark the option in the payload so clients can recognise it by structure
rather than by label.

## 13. Auto session titles track the opener's shape, not the work (new)

**LIVE-VERIFIED 1.0.5 (2026-08-18)** — promoted from a field report
([#98](https://github.com/phuryn/grok-build-vscode/issues/98)) and reproduced first-hand. Three
sessions in one cwd, one turn each:

| opener | generated `session_summary` |
|---|---|
| "Continue working on the Wayfinder agent-home GitHub issue 4." | `Wayfinder agent-home GitHub issue 4` |
| "Continue working on the Wayfinder agent-home GitHub issue 4." | `Continue Wayfinder agent-home GitHub issue 4` |
| "Continue where we left off on the Wayfinder agent-home GitHub issue 4." | `Wayfinder agent-home GitHub issue 4` |

Two sessions with *different* openers got the *identical* title, and all three are echoes of the
opener carrying nothing about the work. Resume and history search by title are not usable in that
state. (Titles are no longer Title-Case on 1.0.5, so that detail of the original report is stale.)

**One of the three asks shipped — thank you.** The auto-title now refreshes after substantive work:
resuming the first session and doing three turns regenerated `Wayfinder agent-home GitHub issue 4`
into `HTTP caching notes.md bullet points`, with `title_refresh_idx` stepping `"0"` → `"1"` and
`_x.ai/session/list` reflecting it. There is a wire rail for it too —
`_x.ai/session_notification [session_summary_generated]` and
`session/update [session_info_update] {"title": …}` — so a client can follow a regenerated title live
instead of polling `summary.json`. That part of the client-cost note below is obsolete.

One inconsistency worth a line: the incremental catalog rail `_x.ai/sessions/changed` pushed
`"title": null` for a session whose `summary.json` and `_x.ai/session/list` both carried a title.

**Client cost/workaround:** none available for the title text itself. The client shows the best field
there is and lets a manual rename win, but it cannot regenerate titles without a model call it has no
business making.

**Ask:** bias summary/title generation toward topic + outcome rather than an echo of the opener; and
avoid emitting identical titles for distinct sessions started the same way (same continue command,
same issue link).

---

## 14. Permission rules are enforced inconsistently (new)

**LIVE-VERIFIED 1.0.5 on one Windows 11 host.** Two measured gaps, both silent. Neither affects our
shipped client — we pass no permission flags and rely on the CLI's own policy — but both mislead
anyone following the documented guidance.

**The `--deny` flag is accepted by `grok agent` and does nothing.** Same trusted repository, same
prompt, same flag:

| invocation | result |
|---|---|
| `grok --deny 'Bash(node *)' -p "<run node -e …>"` | blocked — *"the shell blocked it with a deny rule matching `node *`"* |
| `grok --deny 'Bash(node *)' agent --no-leader stdio` | **ran** — the command executed and wrote its file |

The policy engine itself is fine over stdio: the identical rule written into that repository's
`.grok/config.toml` as `[permission] deny` **is** honoured in `agent stdio`. So this is the flag not
reaching the agent transport, not policy being absent from it. It reproduced with the client's
`terminal` capability both advertised and withheld, and with `--leader` and `--no-leader`. The flag
parses and is accepted; nothing reports that it was dropped. `22-permissions-and-safety.md` states
that behaviour is the same for `grok -p`, `agent stdio` and `agent serve`, and that `deny` always
wins.

**An untrusted folder silently discards the project's permission rules, `deny` included.** A
`.grok/config.toml` carrying `[permission] deny` in a git repository that is not in
`trusted_folders.toml` has no effect in any mode, `grok inspect` does not list the file among its
permission sources, and nothing warns. Trusting the same folder makes it load (`inspect` then names
it, and the rule blocks). Ignoring an untrusted project's `allow` is the right call — a checkout
should not be able to grant itself capability. Ignoring its `deny` inverts that: the failure is
toward *more* permission, and it is invisible at exactly the moment a user is working in unfamiliar
code.

**Per-command "Always allow" never reaches ACP, and neither does `allow_always`.** 1.0.5 added
`[ui] remember_tool_approvals`, which gives TUI prompts an `Always allow: <command>` row and a
matching never-allow row, remembered per project. Over ACP it changes nothing. Forcing a card with a
trusted `[permission] ask` rule and running both arms of the flag, `session/request_permission`
offered exactly the same two options each time:

    kind=allow_once   name="Yes, proceed"
    kind=reject_once  name="No, and tell Grok what to do differently"

No per-command row, and no `allow_always` option at all — so on this build an ACP client cannot
offer *any* durable grant, only one-shot approval. Two user requests for scoped auto-approval
(grok-build-vscode#17, #61) are answered in the TUI and unanswerable in an ACP client, and a client
cannot invent the scope without auto-answering permission cards on the CLI's behalf.

**Ask:** three things, in severity order. Apply `--allow` / `--deny` / `--permission-mode` in the
`agent` subcommand, or reject them there rather than accepting a safety flag that does nothing. Keep
honouring `deny` from untrusted project configs even while `allow` is withheld, and surface which
sources were skipped in `grok inspect`. And send the remembered-grant options over ACP when
`remember_tool_approvals` is on, including `allow_always` in `session/request_permission`, so
durable grants exist for non-TUI clients at all.

## 15. MCP availability signals contradict what the session can actually do (new)

**LIVE-VERIFIED 1.0.5** (2026-08-18, Windows 11, authenticated account with
connectors active at grok.com). This supersedes the central claim of our public
`ACP-MCP-ask.md`, which was measured on 1.0.0 and said managed connectors never
reach an embedded client. **They do now — thank you.** The remaining problem is
that nothing a client can read admits it.

On a plain `grok agent stdio` session with `session/new {cwd, mcpServers: []}` —
nothing client-supplied, nothing in `config.toml` for these servers —
`_x.ai/mcp/list` reports three managed gateways, all ready, carrying **42 tools**:

| server | source | status | tools |
|---|---|---|---|
| Canva | managed | ready | 32 |
| Automations | managed | ready | 9 |
| Voice | managed | ready | 1 |

And they work: the model called `canva__search-designs` and `canva__get-design`
and returned real designs, raising an ordinary `session/request_permission` for
each. At that same moment, in that same session:

| signal | reports |
|---|---|
| `_x.ai/mcp/servers_updated` | local (config-file) servers only |
| `_x.ai/mcp_initialized` | `mcpToolCount: 0` |
| `initialize._meta.mcpApps` | `false` |
| `grok mcp list` / `doctor` / `inspect` | absent from all three |

A client that trusts the advertised rails concludes the session has no MCP tools,
and is wrong by 42. `mcpApps: false` is the most actively harmful of these,
because it reads exactly like the capability flag a client should gate a
connectors UI on.

`_x.ai/mcp/list` — the one surface telling the truth — is advertised nowhere,
which makes this a §4 problem as well: the correct behaviour is reachable only
through private method knowledge.

**Client cost/workaround:** to show a truthful connector list we must call an
undocumented method and ignore three documented signals that disagree with it.
Everything needed for a good UI is in that payload (`displayName`, `source`,
`type`, per-session `enabled`/`status`, and per-tool `name`/`displayName`/
`description`/`enabled`), so this is purely a discovery problem, not a data one.

**Ask:** count managed tools in `_x.ai/mcp_initialized` and list managed servers
on `_x.ai/mcp/servers_updated`; document `_x.ai/mcp/list` or fold it into those
rails; and make `initialize._meta.mcpApps` mean something a client can gate on,
or remove it. Full evidence and reproduction: `ACP-MCP-ask.md`.

## 16. An abandoned `ask_user_question` closes exactly like an answered one (new)

**LIVE-VERIFIED 1.0.30 (2026-09-13)**, two controlled runs on one Windows 11 host, driving
`grok agent stdio` directly and logging every frame stamped from the moment of the ask.

`ask_user_question` has its own documented timeout — `[toolset.ask_user_question]`,
`timeout_enabled = true`, `timeout_secs = 1800`, overridable by `GROK_ASK_USER_QUESTION_TIMEOUT_*`,
user config and requirements. On expiry the CLI stops waiting and continues the turn. That part is
documented and reasonable.

**The CLI does tell the client the interaction closed.** The request carries a `toolCallId`, and at
expiry two frames arrive naming it:

    interaction_resolved { tool_call_id: "call-…-0" }
    tool_call_update     { toolCallId: "call-…-0", status: "completed",
                           content: [{ text: "User declined to answer the questions.
                                              Continue with the task" }] }

**The problem is that an answered question closes with the identical shape.** Same two frames, same
`status: "completed"`, differing only in an English sentence inside `content`:

    tool_call_update     { toolCallId: "call-…-0", status: "completed",
                           content: [{ text: "User has answered your questions:
                                              \"Which colour?\"=\"Red\". You can now
                                              continue with the user's answers in mind." }] }

So a client can reliably learn *that* the interaction is over — which is enough to retire a card —
but cannot learn *why* without pattern-matching prose. `interaction_resolved` carries no reason
code, and `status` is `completed` in both cases even though one of them is an abandonment.

Note also `pending_interaction` does carry a `kind` (`"question"` / `"permission"`) when the
interaction opens, so the vocabulary for discriminating already exists on the way in — it is only
the way out that is undifferentiated.

**Client cost/workaround:** we correlate by `toolCallId` and treat any terminal `tool_call_update`
as closure, which is correct and is what we ship. What we cannot do is tell the user *why* their
card went inert — "the agent moved on without your answer" and "your answer was accepted" are the
same event on the wire. We deliberately do **not** match the prose: a client keying off an English
sentence breaks silently the day it is reworded, and that is not a dependency worth taking.

This is the direct cause of [#160](https://github.com/phuryn/grok-build-vscode/issues/160), where a
user answered after the CLI had already given up and reasonably reported "clicking Submit seems to
do nothing".

**Ask:** put a reason on the way out. Either a field on `interaction_resolved`
(`reason: "answered" | "timed_out" | "cancelled"`), or a non-`completed` status on the
`tool_call_update` for an abandonment — `completed` for a tool that never got its input is
misleading on its own terms. Either one is a small addition and it is the difference between a
client that can explain itself to the user and one that can only guess.

## 17. "Don't ask again" can only ever grant one exact command string (new)

**LIVE-VERIFIED 1.0.30 (2026-09-14)**, driving `grok agent stdio` directly against a
throwaway project and logging every `session/request_permission`.

`session/request_permission` for a terminal command offers four options:

    allow_always, allow_once, reject_once, reject_always

Answering `allow_always` persists, and it persists well — the grant lands in
`~/.grok/sessions/<url-encoded-cwd>/permission.toml` and survives into a **new session**:

    allowed_bash_commands = [
        "echo probe-one > out-one.txt",
    ]

| Step | Command | Permission request? |
|---|---|---|
| 1 | `echo probe-one > out-one.txt` | yes — answered `allow_always` |
| 2 | the same command | **no** |
| 3 | `echo probe-two > out-two.txt` | **yes** |
| 4 | step 1's command, later in the session | **no** |
| 5 | step 1's command, **brand new session** | **no** |

**The problem is step 3.** `allowed_bash_commands` is a list of literal strings matched
exactly, so a grant covers one command and nothing adjacent to it. In an agentic session
almost every command differs — a different test file, a different path, a different flag —
so almost every command is a fresh grant. A user who answers "Yes, and don't ask again" a
hundred times ends with a hundred single-command grants and a hundred-and-first prompt,
and reasonably concludes the setting does not work.

**The CLI already has the concept we need, and ACP cannot reach it.** The same file carries

    allowed_bash_globs = []

which would express "any `npm` command" in one grant. Nothing in the four permission option
kinds populates it. We also measured that hand-writing a glob into that file has no effect
on the ACP path, and neither does `allow_bash_execute = true` — both edits survive in the
file unrewritten and are simply not consulted here. So the field is real, it is not
reachable from a client, and it is not reachable by the user either.

**Client cost/workaround:** the host replaces execute `allow_always` with a
session-scoped program grant and answers the CLI's real `allow_once`. Every
shell segment must name an explicitly granted program; the existing Plan
tokenizer fails closed on syntax it cannot safely decompose. The grant lives
only on `Session`, is never persisted or inherited on load, and cannot approve
anything while planning. Automatic answers stay visible as collapsed,
persisted transcript cards. This addresses
[#123](https://github.com/phuryn/grok-build-vscode/issues/123) and
[#61](https://github.com/phuryn/grok-build-vscode/issues/61) without using the
CLI's exact-string store. Cards also omit `reject_always` (#154); edits keep
the CLI's useful path-keyed `allow_always`. Persistent allow/ask/deny policy
remains the CLI's `.grok/config.toml` route. Relabelling the original CLI
option alone could not fix its matching semantics; owning the session grant can.

**Ask:** a fifth option kind that grants a family rather than a string — enough to populate
`allowed_bash_globs`. The pattern could be the CLI's to choose (it already classifies the
command, so it knows the program and the shape) with the option's own `name` stating it, so
the client renders whatever the CLI decided to offer and nothing has to be inferred
client-side.

A secondary note, measured in passing and worth a line: the grant store is keyed on the
**literal** cwd string, URL-encoded. `C:/Project` and `c:\Project` are two separate stores
for one directory, confirmed by running the same folder both ways — a user whose terminal
and whose editor spell the path differently silently keeps two sets of grants.

## Closed since the archive

Recorded so the list above is not read as static. Both are LIVE-VERIFIED on 0.2.117, not merely
fixed in source.

| Was | Now |
|---|---|
| §2.1 — a rejected plan needed a synthetic hidden-prompt protocol, because the CLI read a JSON-RPC error response to `exit_plan_mode` as a disconnect | Success `{outcome:"cancelled"\|"approved"\|"abandoned"}` behaves correctly inside the original turn; we deleted the primer machinery |
| §2.12 — `targetPromptIndex` truncated `chat_history.jsonl` but not `updates.jsonl`, so a forked session replayed turns the model had forgotten | Both logs truncate at the same boundary (verified on disk). Only the undocumented index base and the silent out-of-range remain — §7 |

Also retired earlier. Re-observed on 0.2.117: `_x.ai/sessions/changed` pushes the incremental session
catalog we once asked for; `initialize._meta.defaultAuthMethodId` (`"cached_token"`) answers "which
credential won?"; and lifecycle events do ship on both rails, retiring the old "they never ship"
claim — though the subagent-specific kinds were last seen on 0.2.112. Retired on source evidence and
not re-run here: reasoning effort is session-settable via `set_model` `_meta` (0.2.117 still
advertises `reasoningEfforts` in `initialize._meta.modelState`).

## Coverage of this pass

Added or re-run on **1.0.5** (2026-08-18, one Windows 11 host): §14 and §15 in full; §2, §3, §6 and
§7 re-run in full against their original probes (two gaps in §2's re-run: the Plan-mode
`terminal/create` and `session/request_permission` cells were not re-observed because the model
attempted no shell in that turn, and `exit_plan_mode`/`planContent` was not exercised — both stay
1.0.4 evidence); §1's
passthrough re-observed (weaker sample — two read-only requests, mutating case not reproduced); §4's
method sweep re-run in full, finding three previously unprobed methods; §9's reporting gap
re-confirmed (`permission_mode` still `null`); and three §4 additions — the
leader multi-client live-session measurement, the completed-`tool_call_update` shape across three
tool kinds, and the `session/load` terminal-output replay. Also probed: the permission-option set on
a forced `session/request_permission` under both `remember_tool_approvals` arms, and MCP tool-call
shape via `session/new` `mcpServers` (see `research/mcp-shapes.md`, which covers codex and claude
too and is outside this file's scope), and the managed-connector surface in §15 — `_x.ai/mcp/list`,
a live managed tool call, and the three rails that disagree with it. `grok agent serve` was not probed, and permission-request
routing between two leader clients was not probed — this host emits no permission requests without a
forcing `ask` rule. No other section was re-run on 1.0.5.

Re-probed live on **1.0.4** (2026-08-15): §2 only, in full — the capability A/B, three attempted
content-level workarounds, and a Plan-mode hook comparison under both capability configurations
(which corrected our own first reading; see the note in that section). §1's Plan-mode claims were
NOT re-run on 1.0.4 beyond what that comparison touched: the `terminal/create` passthrough was
re-observed, but the five-requests-per-turn measurement stays at 0.2.117.

Not verifiable on any pass, and deliberately not manufactured: §5's 429 retry delay and §10's 403
shape, both of which need an account failure we will not provoke.

Re-observed live on 0.2.117: §1, §2, §3, §4, §5 (except the 429), §6, §7, §8, §9 (the reporting
gap). Left at an older named build because the trigger cannot be produced without abusing an
account or spending many delegated turns: the 429 `retry_after_secs` gap in §5 (0.2.103), the
cross-product settings merge in §9 (0.2.99–0.2.101), the 403 classification in §10 (0.2.101), and
restore/subagent normalization in §11 (0.2.112 / 0.2.101). Those four are the only claims here not
confirmed on the current build, and they are labelled in place.
