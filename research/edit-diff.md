# Edit diffs inline (#45)

**Goal.** Show what an edit changed *in the chat transcript*, not only via a native diff-editor tab — and make it work under **Auto accept** (no permission card), which is the case the reporter hit.

## Wire facts (grok 0.2.99, native Windows; `research/edit-diff-probe.cjs`)

- An edit's `tool_call_update` carries the diff as a content block:
  ```json
  { "type": "diff", "path": "…/note.txt", "oldText": "alpha", "newText": "beta",
    "_meta": { "old_line": 2, "new_line": 2 } }
  ```
  `oldText`/`newText` are the **replaced region** (search_replace's `old_string`/`new_string`), **not** the whole file and **not** a pre-computed diff. A new-file create sends `oldText: ""`.
- **The region's file position IS on the wire** — `_meta.old_line`/`new_line` on the block itself, real 1-based file lines (verified 0.2.101 against a fixture whose token sat on line 2). We believed the opposite until 2026-07-15 and rendered the gutter from 1, so a one-line replace at line 147 read "1". The completed update carries strictly more in `_meta.details[]` — an array of `{old_string, old_line, new_string, new_line, context_before, context_after, line_prefix}` — enough to render surrounding context we don't use yet, and **one entry per replaced site** (a replace-all's *block* describes only the token, so `details[]` is the only complete account of it). Which `_meta` rides which delivery path is the subtle part — see § Line numbers + replace-all.
- The diff block rides the `tool_call_update` **regardless of permission mode** — it is not gated by `session/request_permission`. So the review surface can be built purely client-side, independent of the permission flow.
- On **session/load** the same edit replays as a single completed `tool_call` that carries the diff in its own `content` (no separate update) — so extraction must run for both shapes (#30).

## Timing + the two updates per edit (grok 0.2.101, native Windows, 2026-07-15; `research/edit-diff-timing-probe.cjs` → `edit-diff-timing.log`)

- **The diff is on the wire per-edit, seconds before the turn ends.** In a 3-file batch each edit's diff-carrying update landed **2.2–3.3s** before `session/prompt` returned (`t=2766/3117/3471ms`, turn end `t=6026ms`), each arriving as its own edit finished. So the group-header roll-up must be painted as edits land — waiting for `closeToolGroup` is a self-inflicted lag, not a wire constraint.
- **Every edit reports its diff TWICE**, and the two are not always equal:
  1. an **optimistic pre-write echo** — `kind:"edit"`, no `status`, titled (`"Edit \`alpha.txt\`"`), fired *before* `fs/write_text_file`;
  2. the **authoritative completed update** — `status:"completed"`, no `title`/`kind`, fired *after* the write, with `_meta.details[]` (context lines).

  For a `search_replace` both carry byte-identical `oldText`/`newText`. For a whole-file **Write that overwrites an existing file** they differ: the echo sends `oldText: ""` (it hasn't read the old content yet) while the completed update sends the **real prior file content**. The echo lands first, so a first-wins attach renders an overwrite as **pure adds** forever — `attachDiffPreviewToToolItem` must let a *different* later diff repaint (byte-identical → no-op, which keeps buffer replay idempotent).
- **The initial `tool_call` carries the edit args but no diff**: `rawInput: {file_path, old_string, new_string}` (Write: `{file_path, content}`), `content` absent. Painting from `rawInput` would buy ~30ms (`t=2735` vs `t=2766`) and reconstructs `oldText:""` for a Write — exactly the mis-render above. **The echo update is the earliest correct moment; the `rawInput` shortcut is not worth taking.**

## Line numbers + replace-all (grok 0.2.101, native Windows, 2026-07-15; `research/edit-diff-lines-probe.cjs` → `edit-diff-lines.log`)

The line data **is** on the wire — but the three delivery shapes carry **different** `_meta`, and `details[]` (not the block `_meta`) is the one that's almost always there:

| | pre-write **echo** (`kind:"edit"`, titled, no `status`) | **completed** (`status:"completed"`) | **session/load replay** (single completed `tool_call`) |
|---|---|---|---|
| block `_meta.old_line`/`new_line` | present — **first site only** | **absent** | **absent** |
| `_meta.details[]` | *absent* | **present — one entry per replaced site** | **present — one entry per replaced site** |
| whole-file Write | `_meta: {}` — no line data at all | `details[]` length 1, `old_line:1`/`new_line:1` | `details[]` length 1, `old_line:1`/`new_line:1` |

**`details[]` is the primary source** (2 of 3 shapes, and the only complete one); the block `_meta` is an echo-only, first-site-only fallback. **A client that seeds gutter numbers from the block `_meta` alone gets a number only during the echo** — the completed update and every restored session carry no block `_meta`, so the gutter falls back to 1.

- **`details[]` enumerates EVERY site of a replace-all.** A `replace_all` over 12 `PLACEHOLDER` occurrences at known, non-consecutive lines produced `details.length === 12` with `old_line` `[3,5,7,9,11,13,15,17,19,21,23,25]` — an exact ground-truth match. Each entry carries `{old_string, old_line, new_string, new_line, context_before, context_after, line_prefix}`. **So a `+1 −1` render of a 148-occurrence replace is a client gap, not a CLI defect** — the block-level `oldText`/`newText` is token-sized by design (it's the *pattern*), and `details[]` is where the per-site truth lives.
- **`old_line`/`new_line` are 1-based real file lines, and for a multi-line region they are the region's FIRST line.** A 3-line block at lines 40–42 of a 60-line file reported `old_line: 40` (region-relative would be `1`, last-line would be `42`) — on both the echo's block `_meta` and the completed `details[0]`.
- **`details[]` is computed against the POST-EDIT file**, which is why `old_line` is *not* a pre-edit coordinate. In a replace-all whose replacement **grows** the line count (3 sites at pre-edit lines 2/4/6, each `EXPANDME` → 3 lines), every entry reported `old_line === new_line === [2,6,10]` — the sites' lines in the *final* file, not the original 2/4/6. `context_before`/`context_after` corroborate: site 1's `context_after` already shows site 2 replaced. **`new_line` is trustworthy as a post-edit gutter number; `old_line` is only equal to the pre-edit line when the edit is line-count-neutral** (the common case: a token rename). In every capture so far `old_line === new_line`.
- **The echo under-describes a replace-all**: its block `_meta` is `{old_line: 3, new_line: 3}` — the first site only, with no `details[]`. So the echo is the earliest *approximate* paint; the completed update is the only complete one (it lands ~1s after the echo and still ~2.2s before turn end — § Timing).

**Client rule of thumb.** Read `_meta.details[]` **first** — it's on the completed update *and* the replay, one entry per site, `new_line` = the post-edit gutter number. Use the echo's block `_meta.old_line`/`new_line` only as the earliest single-site paint, and region-relative `1` only when neither exists (a whole-file Write echo). Because the echo and the completed update disagree in *shape*, the repaint must be able to **upgrade** an echo-seeded row to the `details[]`-seeded one — the same echo→completed correction the `oldText:""` overwrite bug already forces (§ Timing), so it costs no new machinery.

## The permission-card red herring

The old auto-surfacing of a diff came from the permission card auto-opening a native diff tab (#21). That path is unreliable to depend on:

- With `permission_mode = "ask"`, `yolo = false`, `support_permission` either value, **and even a pristine default config**, `grok agent stdio` on this machine sends **0** `session/request_permission` for an in-workspace edit (probe reproduced with the extension's exact `initialize` handshake). A different machine *does* prompt for the same edit — so **whether the card appears is grok-build/platform-dependent, not a config toggle**.
- Under Auto accept / `always-approve` there is deliberately never a card.

Conclusion: don't tie diff visibility to the card. Render from the always-present wire diff instead.

## Implementation (all client-side)

- `computeLineDiff(oldText, newText)` — pure, `media/webview-helpers.js`. LCS backtrack → `{lines:[{type:'ctx'|'add'|'del',text}], added, removed, truncated}`. CRLF normalized for compare **and** display; empty region = 0 lines (new file = pure adds); huge regions skip the O(m·n) table (flat replace, `truncated`).
- `extractDiffSites(meta, oldText, newText)` — `media/chat.js`. Expands one diff block into **one site per replaced occurrence**, the fix for a `replace_all` rendering as a meaningless `+1 −1`: `_meta.details[]` (completed + session/load) → one site each, `oldText: line_prefix + old_string` / `newText: line_prefix + new_string`, seeded at that entry's `old_line`/`new_line`; the **echo** (no `details[]`) → one approximate site from the block's own `oldText`/`newText` seeded from `_meta.old_line`/`new_line`; neither → one site seeded 1. Two deliberate carve-outs: a site whose `old_string` is `""` (a creation — a new file's `details[0]`) takes **no** prefix, so it stays a pure add instead of the prefix becoming a phantom deleted line; and a `details[]` entry naming **no strings** can't describe a site, so it only *positions* the block's own region (defensive — every captured build sends the strings). Because `line_prefix` has no `line_suffix` counterpart on the wire, a rendered site is prefix+token — the line's tail is unavailable (§ Line numbers + replace-all) and is deliberately **not** reconstructed from a neighbour's `context_before`.
- `openDiffMessage(diff, requestId)` — `media/chat.js` → `WebviewMsg.openDiff`. Keeps the block-level region for the safe fallback and also carries positioned sites plus an explicit `rawInput.replace_all` flag. `expandDiffToWholeFile` in pure `src/diff-view.ts` combines those with the current disk file: completed/replayed edits reverse each verified post-edit site bottom-up; pending single-site edits use the echo's pre-edit line; pending `replace_all` edits substitute every old-side match only because the raw input explicitly requested it. Without usable coordinates/flag, a duplicate pattern is replaced once, never globally by guess. Unreadable, oversized, stale, or non-matching files retain the old region-only diff. `firstChangedLine` seeds the native editor's selection so it opens on the first hunk.
- `attachDiffPreviewToToolItem(toolCallId, diffs)` / `applyToolDiffs(call)` — `media/chat.js`. Always-visible `+N −M` on the row + group-header roll-up (path-deduped), an expandable inline diff riding the command IN/OUT expand machinery (`has-details` + `wireCommandToggle` + `detailShouldExpand`). Handles multiple `diff` blocks per call. **The counts sum every site of every block** (that's the point — a 148-occurrence replace is `+148 −148`) and are computed *before* the render cap, so a capped render never understates the change. Idempotency is keyed on `item._diffSig` (the serialized diffs, now **including the sites**, so the completed update's `details[]`-seeded render outranks the echo's approximate one), not on "a detail already exists" — so a replayed identical diff stays a no-op while the authoritative completed diff can still **correct** the optimistic echo (see § Timing). A repaint reuses the existing detail node: swapping it would strand `wireCommandToggle`'s click listener on a detached node *and* double-bind a second one. One `open diff →` per **block** (its payload is still the block's own `oldText`/`newText`) — per-site would emit 148 buttons.
- `recomputeGroupDiffTotals(item)` / `paintGroupDiffTotals(group)` — the header roll-up, painted **as each edit lands** rather than at batch close. Totals are *recomputed* from the rows' `_diffStat` (not incrementally accumulated), so a corrected row replaces its earlier counts instead of double-counting. They live in their own `.tool-group-diff-totals` span because two things wipe the header: `addToToolGroup` rebuilds `hdr.innerHTML` on every new call in the batch, and `closeToolGroup` resets the label's `textContent` — both re-paint immediately after. Expansion is untouched: totals show on the *collapsed* header, and only `grok.expandCommandOutputs` / the `toolExpandOverride` latch ever open anything.
- `buildInlineDiffRegion(hunks)` — Codex-style rendering: **ONE `.tool-diff-region` per diff BLOCK holding N hunks** (one per site), *never* one region per site — the region is a 320px scroll box, so 148 of them would stack 148 nested scrollers. Each hunk is `.tdl` grid rows `[+/− sign][line-number gutter][code]`, colored left-border stripe + subtle per-line tint. Each hunk seeds its own gutter from its site's lines via `fileLineOr1` (falls back to 1 when absent or bogus — 0/negative/non-number — the old region-relative rendering). Non-contiguous hunks are parted by a quiet `.tdl-sep` hairline (a replace-all's sites sit at scattered lines; `newLine !== ` the previous hunk's next new-side line ⇒ separate) — never before the first hunk, never between contiguous ones. `MAX_INLINE_DIFF_LINES = 400` is a budget **across** the block's hunks (not per hunk), then a `.tool-diff-more` note + `open diff →`; the `+N −M` stat is summed over every site independently of it. The gutter track sizes to the widest number *actually rendered* (`--tdl-num-w` = `max(4ch, digits+1)`, set per region): 4ch through 999 (unchanged), wider only for a 1000+ line file — real line numbers made 4–5 digits reachable, and a fixed track would clip them into the `+/−` glyph. The sign is a color-blind affordance. Palette = **Codex's exact green/red** via `--tdiff-*` vars (dark default + `body.vscode-light` override), reused by the `+N −M` stat.
- The gear toggle `grok.expandCommandOutputs` label was renamed **Expand tool details** (key unchanged) since it now governs edit diffs as well as command IN/OUT.

## Turn-level file change summary

One **Changed N files · +A −R** card per agent turn, listing every path touched
in that turn. Pure client aggregation — no disk re-diff, no new ACP surface.

- **Edits:** `attachDiffPreviewToToolItem` records each toolCallId's
  `{path, added, removed, oldText, newText, openDiff}` into
  `state.turnEditsByToolCallId`.
- **Deletes:** `maybeRecordTurnDelete` on every tool row — ACP `kind:"delete"`
  **or** shell verbs parsed by pure `parseShellDeletePaths` (PowerShell
  `Remove-Item`/`ri`/`del`, POSIX `rm`). Grok often deletes via shell because
  there is no write-path delete RPC the client owns.
- **Path merge:** pure `normalizeTurnEditPathKey` (slash-normalize + lower-case)
  so `F1.txt` and `f1.txt` are one row on Windows.
- **Multi-edit:** pure `aggregateTurnEdits` **sums** every edit's +/− for that
  path (create in batch 1 + edit in batch 2 both count — we do not keep only
  the last). `openDiff` spans **first.oldText → last.newText** so the native
  editor shows the whole turn (batch-1 content included), not only the last
  region. A delete after edits wins; an edit after a delete recreates the row.
- **Host baselines (view deleted / undo):** first-touch snapshot per path for
  the open turn (`src/file-baseline.ts`). Captured on `fs/write_text_file`
  (before write) and on `terminal/create` for shell deletes (sync read before
  spawn). Content stays host-side; webview gets `turnBaselines` meta keyed by
  `agentStart.turnId`. UI: **View** on deleted rows, **Undo** per file, **Undo
  all** on the card. Restore writes baseline content or deletes a created file.
- **Live / restore / click:** same as before (card pins at turn end; restore
  rebuilds from completed `tool_call`s; path click posts `openDiff`).
- **Out of scope:** non-delete shell mutations (`sed`, `mv`, redirects),
  subagent child edits, LLM prose "what changed", per-file restore via CLI
  rewind (no single-path RPC).

## Tests

- `test/webview-helpers.test.ts` → `computeLineDiff` (word change, context, new file, deletion, CRLF, size-cap) + `aggregateTurnEdits` / `turnDiffSummaryTitle`.
- `test/tool-edit-expand.dom.test.ts` → row `+N −M`, group-header totals + path dedupe, inline diff render, expand via row click, `open diff →`, replay idempotency, new-file, restore, expand-tool-details pre-open. Plus the timing half: totals on the **in-progress** header growing per edit (and surviving the `addToToolGroup` header rebuild) with no `promptComplete`, a running batch with a landed diff still **collapsed**, the overwrite echo→authoritative correction (+7 −0 → +4 −3, one stat not two, roll-up follows), one working toggle after a repaint, and an identical repaint staying a no-op with the row's open state intact. Plus the replace-all half (fixtures copied from `edit-diff-lines.log`'s A-replace-all case): 3 sites → 3 hunks at the real non-contiguous lines `[3,3,5,5,7,7]` with `line_prefix` in the rendered text and `+3 −3` (not the block's `+1 −1`), one region + one `open diff →` per block, separators only between non-contiguous hunks, still collapsed by default, echo→completed upgrading 1 approximate hunk → 3 without double-counting the roll-up, a 250-site render capping at 400 rows while the stat still reads `+250 −250`, and the single-site Write/new-file shapes rendering exactly as before.
- `test/turn-diff-summary.dom.test.ts` → live card, path-dedupe + multi-edit sum, openDiff click, echo→completed no double-count, next-turn fresh card, session/load restore (incl. multi-edit same file), non-edit turns stay empty. Multi-edit suite: three appends, add-then-remove same line, add-then-rewrite, three-pass append/edit/remove, live growth mid-turn, interleaved A/B/A, delete+recreate.
- `test/webview-helpers.test.ts` → `aggregateTurnEdits` multi-edit (sum + first→last openDiff), add/remove/rewrite same content, unchained regions, delete lifecycle, case-fold path keys, `parseShellDeletePaths`.
- `test/command-details.dom.test.ts` → exit-0-no-output done marker (empty-pre drop) + non-zero/whitespace variants.
