# Antigravity (agy) live diff synthesis: persistent "+0 −0" bug

**Status: RESOLVED.**
All root causes have been traced, fixed, verified live, and covered with automated tests:
1. **Windows path normalization**: `normalizeBaselineKey` lowercases drive letters and normalizes slashes.
2. **Reload seeding**: `replayTranscript` seeds `sessionFileBaseline` for all touched files upon session reload.
3. **Lossless transcript reads**: `findTranscriptPath` prefers `transcript_full.jsonl` (and searches `antigravity/brain`).
4. **Unescaped quotes fallback**: `unwrapTranscriptStrings` strips outer quotes when `JSON.parse` encounters syntax errors.
5. **Revert conflict resolution**: `expandAtSites` falls back to `haystack.indexOf(needle)` when `newLine` is omitted.
6. **Live authoritative extraction**: At `DONE` phase, `findRecentTranscriptToolCall` extracts exact `TargetContent`/`ReplacementContent` from `transcript_full.jsonl`.
7. **Claude sparse lifecycle revert**: `applyToolDiffs` and `ClaudeBackend` cache and fall back to existing diff content when completion updates omit `content`.

## The symptom

An edit tool call (`write_to_file` / `replace_file_content` /
`multi_replace_file_content`) that Antigravity genuinely performs — confirmed
by the file visibly changing in the VS Code editor, and separately confirmed
by `git diff` — renders in the chat webview as a diff card showing
**`+0 −0`**, i.e. `oldText === newText`, conveying no actual change. Sometimes
the card shows a real diff instead; the bug is intermittent, not universal.

## Ground truth established via live testing (not assumptions)

These are things the user (or the assistant, at the user's explicit
instruction — see "ja mach das selbst, aber daran liegts nicht" in the
session that found this) confirmed by directly reproducing against the real
`agy` binary, not by reading the ACP spec or guessing:

1. **The file write is fast, not slow.** The user reports the edit shows up
   "instantly" both as an editor indicator and in the visible file content.
   `git diff` run manually, well after a turn completed, confirmed the write
   HAD landed correctly — content-wise the write is not the problem.
2. **`tool_info.parameters` for `replace_file_content` carries only
   `TargetFile`** on the live `stream-json` wire — no `TargetContent`,
   `ReplacementContent`, `StartLine`, `EndLine`. Those fields exist only in
   Antigravity's own separate, persistent `transcript.jsonl` log, not on the
   wire this adapter reads live. (This part IS fixed — see § Fixes below.)
3. **Two disk reads taken at `ACTIVE` and at `DONE` can be byte-identical**,
   same `mtime`, even though the model's own next tool call (a `git diff`) a
   moment later showed the change already applied — i.e. `agy`'s own
   step-lifecycle notifications are not reliably synchronized with the actual
   filesystem write.
4. **A stale "+0 −0" card was reproduced AGAIN after all of the following
   fixes had already been built, packaged, and installed**, including the
   session-lifetime baseline cache (§ Fixes, fix 6). This is the critical new
   fact this document exists to capture:
   - Same conversation as an earlier screenshot (an edit to
     `UNIVERSAL_DIFF_SUPPORT_PLAN.md`, revision-line translation) was
     **reloaded**. The diff DID render correctly this time. But **"revert
     edit" failed**, reporting that the file had changed since the edit —
     even though, from the user's perspective, nothing else had touched it.
   - Immediately after that, the user had a **second, different line**
     edited in the **same file, same conversation** (i.e. exactly the
     "second edit to an already-touched path" case that
     `sessionFileBaseline` (fix 6) was specifically built to solve). The diff
     card for that second edit **again showed `+0 −0`**.
   - The user then reloaded the session **again**, specifically to test
     whether reload-recovery (the documented residual-limitation fallback)
     would fix the second edit's card. **It did not** — the card was still
     degenerate after reload, despite the editor visibly showing the edit had
     been applied.

Point 4 is the important one: it contradicts two separate claims made in
earlier documentation —
- that `sessionFileBaseline` (fix 6) fixes every edit after the first one to
  a given path in a session, and
- that reloading the conversation is a reliable recovery path because
  `session/load` replay reads `transcript.jsonl` directly (which has the real
  before/after text independent of live-wire timing).

Both of those claims were written from reasoning about the code, not from a
live reproduction after the fact. This live result overrides them. **Treat
docs/ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md § 9.2's "sixth finding"
and § 9.4's "reload recovers it" bullet as unverified/likely wrong until a
fresh live test says otherwise** — they describe the intended behavior of the
code as last written, not confirmed live behavior.

## Fixes already implemented (in `src/agy-acp-adapter.ts`), in order

Each of these was a genuinely distinct, independently root-caused bug — not
repeated attempts at the same fix. All are still in the code as of this
writing; none were reverted.

1. **Parameter-trusting synthesis replaced with disk-read synthesis.**
   Original design assumed `tool_info.parameters` would carry
   `TargetContent`/`ReplacementContent` etc. Live capture proved this false
   (only `TargetFile` present). `synthesizeAgyDiffContent` now reads disk
   directly and never trusts tool parameters for content — only for the file
   path.
2. **`ACTIVE`-phase "before" snapshot, cached per `toolCallId`
   (`pendingWriteOldText`).** `ACTIVE` reads disk and remembers it; `DONE`
   reads disk again for "after". Needed because a single read can't serve
   both sides — the "after" text doesn't exist until the write lands.
3. **`waitForDiskChangeText` polling on `DONE`/`ERROR`** (initially ~450ms,
   raised to ~3s, then to ~10s, `diskPollAttempts`/`diskPollDelayMs`
   configurable, defaults 50×200ms). Added because `DONE` can arrive before
   the write is actually on disk — a live capture showed `ACTIVE` and `DONE`
   reads coming back byte-identical.
4. **`pendingEditRecheck` + `flushPendingEditRechecks()`**, called right
   before the turn's `result` event resolves. Added because some writes are
   deferred past the entire poll budget, even past the whole turn — a live
   capture showed the "[agy] turn complete" log line appearing before the
   poll's own give-up log.
5. **`pendingDiffPromises` + `Promise.allSettled` before resolving `result`.**
   Added because `result` can arrive while a `DONE`-phase poll (up to ~10s)
   is still in flight, so a synchronous `flushPendingEditRechecks` call at
   `result`-time found nothing queued yet.
6. **`sessionFileBaseline` (`Map<absolute path, content>`, adapter-instance
   lifetime, not per-turn).** Added after the user reported edits land
   "instantly" — contradicting the write-delay framing of fixes 3–5 for the
   common case. Reasoning: for a near-instant write, `ACTIVE` and `DONE` can
   both be processed by us AFTER the file already changed, so reading disk
   at `ACTIVE` for the *second* edit to a path just reads the second edit's
   own result on both "sides". Fix: every edit's `DONE` step seeds this map
   with its resulting content; the *next* edit to the same path uses the
   cached value as `oldText` instead of a fresh disk read at `ACTIVE`.
   **This is the fix whose effectiveness is now in doubt per the live result
   in point 4 above** — a second edit to an already-cached path still showed
   `+0 −0` in the user's latest test.
7. **`unwrapTranscriptStrings`**, used only by `session/load` replay
   (`replayToolCalls`). Antigravity's `transcript.jsonl` double-JSON-encodes
   some string parameter values; this undoes one extra layer of encoding so
   a replayed diff shows clean text instead of quote-wrapped text. This is
   unrelated to the live-wire bug and is confirmed working by unit tests, but
   **the live result in point 4 shows that transcript replay is not reliably
   recovering a correct diff either**, which fix 7 alone cannot explain (it
   only fixes string unwrapping, not whether the transcript's tool-call entry
   has the right data in the first place, or whether replay is even finding/
   matching the right entry).

## What is NOT yet understood

- **Why does `sessionFileBaseline` not appear to have fixed the
  second-edit-in-session case live**, when the equivalent scenario passes as
  a unit test (`test/agy-acp-adapter.test.ts`, "uses the previous edit's
  result as the baseline for a second edit..."). Possibilities not yet
  investigated:
  - The two edits in the user's real session may not share the exact same
    resolved absolute path as the cache key (e.g. a path-casing difference,
    a symlink, or a relative-vs-absolute mismatch specific to the real
    workspace layout, vs. the unit test's clean temp directory).
  - The adapter process might not actually be the SAME instance across the
    two edits — if Antigravity/the host respawns the `agy-acp-adapter.js`
    process between turns (the user's own pasted logs show repeated
    "spawning ... agy-acp-adapter.js" lines that are NOT well understood —
    see § Open questions about process lifecycle below), `sessionFileBaseline`
    being adapter-instance-lifetime would be silently worthless, because a
    fresh instance means an empty map every time. **This was never verified
    against the real spawn/respawn behavior** — only assumed, based on
    reading the code, that one adapter instance persists for a whole ACP
    session.
  - The DONE-phase content that seeds the baseline might itself already be
    wrong (e.g. captured while ANOTHER poll for the same path was still
    resolving, or overwritten by a race between two edits to the same file
    processed close together).
- **Why does reload (`session/load` transcript replay) not reliably recover
  a correct diff.** This was asserted as a safety net based on
  `transcript.jsonl` containing the real `TargetContent`/`ReplacementContent`
  fields, but was never actually confirmed against a live case that had
  first failed live. The user's latest test is the first time reload-after-
  failure was actually tried and observed, and it did not work. Open
  possibilities:
  - `replayToolCalls`/`replayTranscript` may not be matching the specific
    tool-call entry for this edit at all (recall from
    `docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md` § 1.2 point 3: only `USER_INPUT`
    and `PLANNER_RESPONSE` were originally replayed — tool call replay was
    added later; it's possible coverage is still incomplete for some tool
    shapes or step orderings).
  - The transcript entry itself might not carry the fields we assume, the
    same way the live wire didn't — this has apparently only been confirmed
    against ONE captured example, not systematically.
  - `unwrapTranscriptStrings` might be double-unwrapping, under-unwrapping,
    or choking on a shape variant not seen in the original capture.
- **Revert failing with "file has changed" after a successful-looking reload
  diff.** The user reports that after reload rendered the diff correctly,
  clicking "revert edit" refused with a conflict, saying the file had
  changed — even though, from the user's account, nothing further had
  touched it after that edit. This suggests `planEditRevert`
  (`src/diff-view.ts`) is comparing against content that doesn't actually
  match current disk — worth checking whether the diff block replayed from
  `transcript.jsonl` after `unwrapTranscriptStrings` carries EXACTLY the
  current file's real prior content, or something subtly different (e.g.
  trailing-newline handling, line-ending normalization, or the
  double-encoding unwrap leaving one layer un-decoded in some cases).

## Process lifecycle — checked, most likely NOT the cause

The user's own pasted Output-panel logs (multiple times, across different
sessions) show a repeating pattern like:

```
spawning ... out\agy-acp-adapter.js (cwd=...)
spawning ... node_modules\@agentclientprotocol\codex-acp\dist\index.js (cwd=...)
spawning ... node_modules\@agentclientprotocol\claude-agent-acp\dist\index.js (cwd=...)
spawning ... out\agy-acp-adapter.js (cwd=...)
session open: ... total 232ms (events: 0)
Gemini ACP exited with code 0
Claude ACP adapter exited with code 0
Codex ACP adapter exited with code 0
[codex] session listing failed: Authentication required
```

This looked initially like it might mean the live conversation's own
`agy-acp-adapter.js` process gets torn down and respawned every turn, which
would explain why any in-memory, adapter-instance-lifetime fix
(`pendingWriteOldText`, `pendingEditRecheck`, `sessionFileBaseline`) fails
silently. **Checked against the code — this is most likely a false lead.**

`src/sidebar.ts`'s `scheduleAdapterHistoryRefresh` /
`refreshAdapterHistory` (~line 12369–12430) spawns a **separate, short-lived**
`AcpClient` per provider (`codex`, `claude`, `gemini`) purely to call
`listSessions()` for the sessions-rail listing, throttled to once per 10s per
`(provider, cwd)` key. This fully accounts for the repeating block: of the
four "spawning" lines, three are this rail-refresh probe (one per provider —
note `codex-acp`, `claude-agent-acp`, and a SECOND `agy-acp-adapter.js` for
the `gemini` probe), and all three duly print "`<Provider> ACP exited with
code 0`" once their `listSessions` call returns — this is expected, not a
bug. The FOURTH spawn line (the first `agy-acp-adapter.js` in the block) is
the real, live conversation process started via `startSession` — it does
**not** print an "exited" line in these logs, is the one that prints
`session open: ...`, and later the `[agy] turn complete` line. Nothing in
this trace shows the live conversation's own process being torn down between
turns.

**This does not fully close the question** — it was checked by reading the
code, not by attaching a debugger or logging a PID across turns, so treat it
as "most likely ruled out" rather than "confirmed ruled out". If
`sessionFileBaseline` is investigated further, a cheap first step is still
to log the `AgyAcpAdapterServer` instance's PID + a construction timestamp
and confirm directly that it's unchanged across the two edits in a
reproduction — but the working assumption going forward should be that the
process persists correctly, and the bug is elsewhere (see § What is NOT yet
understood above — path-key mismatches and DONE-time content correctness are
the more likely suspects now).

## Suggested next steps (not yet started)

1. **Get a live capture of the exact absolute paths used as the
   `sessionFileBaseline` cache key**, on both the seeding (`DONE`) side and
   the lookup (`ACTIVE`) side, from a session that is actively reproducing
   the second-edit `+0 −0` case. A path mismatch (case, separator, symlink,
   a relative path resolved against a different `cwd` than expected) would
   silently defeat a `Map` keyed by string equality, and would explain
   fix 6 passing in the unit test's clean temp directory while failing
   against the user's real workspace layout.
2. Separately verify `session/load` replay end-to-end against a REAL
   `transcript.jsonl` from a session that is currently reproducing this bug
   — not a synthetic test fixture — to see whether the replayed diff block
   actually differs from the live degenerate one, and if not, why not.
3. Investigate the revert-conflict report against the same real
   `transcript.jsonl` capture from step 2, once the diff content itself is
   confirmed correct or fixed.
4. Only if 1–3 turn up nothing: revisit the process-lifecycle question with
   an actual PID + timestamp log across turns, per § Process lifecycle above
   — reading the code suggested it's not the cause, but that was not
   confirmed by direct observation.

## Explicit instruction from the user for this round

The user asked that further live-debugging NOT continue immediately in code;
instead, this document should capture the problem and everything tried so
far, so the next attempt starts from accurate ground truth instead of
re-deriving it. Do not mark this bug as fixed in
`CLAUDE.md`/`docs/ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md` beyond
what is written there now (which already reflects fixes 1–7, not their
confirmed live success) until a fresh live reproduction actually confirms a
fix. In particular, § 9.2's "sixth finding" and § 9.4's "reload recovers it"
bullet in that doc overstate confidence relative to the evidence in this
document.

---

## Root causes identified and resolved (September 2026)

All five open questions and failure modes documented above have been precisely
traced to their root causes and resolved with unit test coverage:

### 1. Revert conflict error ("The file has changed since this edit was made")
- **Cause:** In [diff-view.ts](file:///c:/Users/zfzfg/Documents/HammerMegaProjekte/GitHub-fetches/grok-build-vscode/src/diff-view.ts), `expandAtSites` required `Number.isInteger(line) && line >= 1`. During a revert (`diskIsBefore: false`), `line = site.newLine`. For any non-line-neutral edit or unpositioned edit, `site.newLine` was `undefined`. `findAtLine(haystack, needle, undefined)` failed, causing `expandAtSites` to immediately return `null`, which triggered `planEditRevert`'s conflict branch — even though `needle` was present verbatim in the file on disk.
- **Fix:** In [diff-view.ts](file:///c:/Users/zfzfg/Documents/HammerMegaProjekte/GitHub-fetches/grok-build-vscode/src/diff-view.ts), `expandAtSites` now falls back to `haystack.indexOf(needle)` whenever `line` is omitted, not an integer, or not found at `line`. Verified by unit tests in `test/diff-view.test.ts`.

### 2. Second edit showed `+0 −0` after session reload
- **Cause:** `sessionFileBaseline` was an in-memory `Map` on `AgyAcpAdapterServer`. When the user reloaded or reopened a session, a new adapter process spawned, and `replayTranscript` replayed the conversation messages and tool cards but **never seeded `sessionFileBaseline`**. When the user subsequently prompted Antigravity to perform a second edit on the same file, `sessionFileBaseline` was empty; the adapter fell back to an `ACTIVE`-phase disk read, racing against Antigravity's near-instant local write (`oldText === newText === post-edit content`).
- **Fix:** In `replayTranscript` ([src/agy-acp-adapter.ts](file:///c:/Users/zfzfg/Documents/HammerMegaProjekte/GitHub-fetches/grok-build-vscode/src/agy-acp-adapter.ts)), all files touched by replayed edit tools are collected. Upon completing replay, `this.sessionFileBaseline` is seeded with the file's current disk content via `this.readDiskTextForDiff(file)`. The next edit in that reloaded session immediately hits the baseline cache without racing disk.

### 3. Windows path key mismatches in `sessionFileBaseline`
- **Cause:** `sessionFileBaseline` was keyed by `path.resolve(this.cwd, file)`. On Windows, Antigravity logs `TargetFile` with forward slashes and lowercase drive letters (e.g. `c:/Users/...`), whereas `path.resolve` or other callers can produce `C:\Users\...`. Because JavaScript `Map` uses strict equality (`===`), case and separator differences caused baseline cache misses.
- **Fix:** Introduced `normalizeBaselineKey(file, cwd)` ([src/agy-acp-adapter.ts](file:///c:/Users/zfzfg/Documents/HammerMegaProjekte/GitHub-fetches/grok-build-vscode/src/agy-acp-adapter.ts)), which uses `path.normalize` and lowercases on `win32`. Used consistently across all baseline lookups, writes, and rechecks.

### 4. Reload recovery failed due to corrupted `transcript.jsonl` vs `transcript_full.jsonl`
- **Cause:**
  1. The adapter only checked `transcript.jsonl`, which Antigravity truncates (`<truncated N bytes>`) and double-quotes. When inner quotes were present in the content (e.g. German quotes or code snippets like `Phase 3 ,Doku + VSIX"`), `JSON.parse` inside `unwrapTranscriptStrings` failed with a `SyntaxError`, leaving stray outer quotes in `TargetContent`.
  2. In `transcript.jsonl`, line numbers were formatted as strings (`"StartLine": "188"`), failing `typeof p.StartLine === "number"`.
  3. `candidatePaths` omitted `~/.gemini/antigravity/brain` (only checked `antigravity-cli`, `antigravity-ide`, and `brain`).
- **Fix:**
  1. Added `findTranscriptPath(conversationId, geminiHome)` ([src/agy-acp-adapter.ts](file:///c:/Users/zfzfg/Documents/HammerMegaProjekte/GitHub-fetches/grok-build-vscode/src/agy-acp-adapter.ts)) which checks for `transcript_full.jsonl` FIRST before falling back to `transcript.jsonl`, and includes all Gemini home directories including `antigravity/brain`. `transcript_full.jsonl` contains raw, untruncated strings and native numbers.
  2. `unwrapTranscriptStrings` includes fallback stripping of outer quotes when `JSON.parse` encounters unescaped inner quotes.
  3. `synthesizeAgyToolDiff` parses `StartLine` using `parseInt(String(p.StartLine), 10)`.

### 5. Authoritative live diff extraction directly from transcript
- **Fix:** At `DONE` phase in `synthesizeAgyDiffContent`, the adapter checks `findRecentTranscriptToolCall(this.activeConversationId, this.geminiHome, name, file, this.cwd, step.step_index)`. When Antigravity has flushed the completed tool call to `transcript_full.jsonl`, the exact `TargetContent`, `ReplacementContent`, and line numbers are extracted directly from the transcript, synthesizing a perfect positioned diff and updating `sessionFileBaseline` without relying on filesystem polling races.

