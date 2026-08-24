# Desktop conversation turn rail

Desktop-only navigator for a multi-turn chat: a pinned column of one bar per
Q&A, overlaid on the left gutter of `#messages`. Click jumps to that turn.
Hover shows a truncated question and truncated answer.

Not affiliated with OpenAI Codex; the interaction is the OpenCode-style
left-gutter index the contributor asked to match.

## Goal

In Grok Build Desktop, a long conversation is reachable without scrubbing the
transcript. Each visible user turn gets a short bar in a left-edge index that
stays on screen while the chat scrolls.

## Non-goals

- VS Code / Cursor sidebar, AFK Pilot remote, or any host without `#turn-rail`
- A compressed minimap, viewport rectangle, or scrollbar replacement
- Keyboard shortcuts beyond native `button` focus / Enter / Space
- Persisting rail scroll or hover state across sessions
- Including thinking traces, tool cards, or permission cards in the preview
- Changing Rewind, Edit, Find-in-session, or session history

## Surfaces

Desktop `getHtml` only (`host.canSwitchWorkspaceFolder === true`). The mount,
stylesheet, and script are omitted from the VS Code HTML the same way
`#projects-rail` and the file panel are. Absence of `#turn-rail` is the off
switch: `chat.js` must not create the node.

## Placement

```
[ projects rail ] [ top bar
                    turn-rail overlay | #messages
                    composer          ] [ file panel ]
```

`#turn-rail` is a sibling overlay on the left edge of `#messages` inside
`.desk-ft-chat`. It is not a new window column and does not resize the
projects rail or the file panel.

When the rail has at least one bar, `#messages` gains **16px** extra left
padding on top of `--pad` so bubbles do not sit under the ticks. When the
rail is hidden, that extra padding is not applied.

## A turn

A rail entry is one **countable user bubble** plus everything after it until
the next countable user bubble.

Countable means the same set Rewind already uses:

- `.msg.user:not(.queued)`
- `dataset.steer !== "1"`

Not a turn:

- queued unsent composer blocks
- steer / interject bubbles
- hidden legacy primer turns (they never become a `.msg.user`)
- the welcome screen

Question text: visible plain text of the user bubble (`_copyText` if set,
otherwise `.body` textContent). If that string is empty:

- any image chip or image preview → `"(image)"`
- otherwise any file chip → `"(attachment)"`
- otherwise `"(empty)"`

Answer text: concatenate `.body` textContent of `.msg.agent` nodes in the
turn, in DOM order, separated by a single newline. Skip `.msg.thinking`,
tool-call cards, permission cards, plan cards, and queued blocks.

Pending: `listTurns` sets `pending: true` on the last countable user bubble
when that turn has not yet received `agentEnd`. If `pending` and the answer
string is empty, the preview answer is `"Answering…"`.

History windowing: the rail lists only turns whose user bubble is currently
in `#messages`. Prepending older history inserts bars at the top.

UI copy is English, matching the rest of the desktop client.

## Truncation

Constants, exported from `media/turn-rail.js` and locked by tests:

| Field | Max |
|---|---|
| Question | 80 |
| Answer | 160 |

`truncatePreview(text, max)`:

1. Treat `text` as a string; empty → empty (callers apply the pending /
   image fallbacks first).
2. Segment by grapheme cluster (`Intl.Segmenter` `granularity: "grapheme"`).
   If `Segmenter` is missing, fall back to `[...text]` (Unicode code points).
3. If the cluster count is `<= max`, return the string unchanged.
4. Otherwise join the first `max` clusters and append `"…"` (U+2026).

Both question and answer go through this function. The hover card never
shows untruncated bodies.

## Interaction

### Click

Scroll `#messages` so the turn's user bubble is at the **start** of the
visible area (`block: "start"`). If that bubble is not the last countable
user bubble, clear stick-to-bottom (same signal as a deliberate user scroll)
so a live turn cannot yank the viewport back.

If the recorded user bubble is no longer in `document` (session switch,
rewind, clear, history splice), the click is a no-op: no scroll, no throw,
no user-visible error. The next rail refresh drops the stale bar.

After a successful jump, scroll `#turn-rail` so the clicked bar is visible.

### Hover

After 150ms of hovering a bar, show a popover to the right of the rail:

- label `Question` + truncated question
- label `Answer` + truncated answer

Hide on pointer leave of the bar **and** the popover. Clamp the popover so it
stays inside the window (flip up if it would overflow the bottom). The
popover is not a click target for navigation; the bar is.

### Active bar

Follow `#messages` scroll. The active turn is the countable user bubble
closest to the top of the messages viewport (still intersecting it). While
stick-to-bottom is on, the last turn is active. The active bar uses
`--vscode-textLink-foreground`.

### Rail scroll

Bars have a fixed gap and do not compress. When they overflow the gutter
height, only `#turn-rail` scrolls. There is no minimap viewport overlay.

Zero countable turns: `#turn-rail` is `hidden`, extra messages padding is
removed.

### Keyboard

No extra shortcuts. Each bar is a `<button type="button">` with
`aria-label` set to the truncated question and `aria-current="true"` on the
active bar.

## Architecture

New files, same UMD shape as `media/file-panel.js` (`module.exports` in tests,
`window.GrokTurnRail` in the webview):

| File | Role |
|---|---|
| `media/turn-rail.js` | Rail DOM, hover popover, truncation, bar list rendering |
| `media/turn-rail.css` | Gutter, bars, popover; theme tokens only, no raw hex that fights light/dark |
| `test/turn-rail.dom.test.ts` | happy-dom tests of the module with a fake host |

`chat.js` does not draw bars. It:

1. On boot, if `#turn-rail` exists and `window.GrokTurnRail.createTurnRail` is
   a function, calls it with a host object.
2. Implements that host:
   - `messagesEl` — the transcript scroller
   - `listTurns()` — walks countable user bubbles, returns
     `{ userEl, question, answer, pending }[]` using the rules above
   - `scrollToTurn(userEl)` — performs the messages scroll + stick-to-bottom
     policy; returns `false` when `userEl` is not connected
   - `subscribe(listener)` — fires on transcript mutations (user/agent
     append, prepend, clear, session switch). Implementations must coalesce
     with `requestAnimationFrame` so a streaming token does not rebuild the
     rail once per chunk
3. Leaves Rewind's `data-user-bubble-index` mapping unchanged. `listTurns`
   must use the same membership test as `visibleUserBubbleCount` so bar N
   and rewind bubble N cannot drift. Export `isCountableUserBubble(el)` from
   `media/webview-helpers.js` (already loaded on every host) and call it from
   both `chat.js` rewind indexing and `listTurns`. Do **not** put that helper
   only in `turn-rail.js`: VS Code does not load that script.

`src/sidebar.ts` `getHtml`:

- Desktop: `<aside id="turn-rail" hidden aria-label="Conversation turns">`
  as a sibling overlay on `#messages`, plus `<link>` / `<script>` for the
  new assets (script after `webview-helpers.js`, before `chat.js`).
- VS Code: no node, no assets.

No new host↔webview protocol messages. The rail is renderer-local.

## Error handling

| Situation | Behaviour |
|---|---|
| Zero turns | Rail `hidden`, no extra padding |
| Session switch / clear all | Tear down bars and popover, then rebuild from the new DOM (often empty) |
| Click target disconnected | No-op |
| Image-only / chip-only user message | Fallback question strings above |
| History prepend | `listTurns` re-reads DOM; bars for new prefix appear at the top |
| Streaming tokens | rAF-coalesced refresh; pending answer uses `"Answering…"` until prose exists |
| Missing `#turn-rail` or missing `GrokTurnRail` | `chat.js` skips setup |
| `Intl.Segmenter` absent (happy-dom) | Code-point fallback; tests cover both if the env allows |

Do not `console.error` on the disconnected-click path.

## Testing

`npm test` only (layer 1, grok-free). No new Electron / `test:integration`
job for this feature.

`test/turn-rail.dom.test.ts` drives `media/turn-rail.js` with a fake host
and fixture transcript DOM. Required cases:

- `truncatePreview` at 80 and 160: unchanged when short; ellipsis when long;
  CJK characters stay whole; a simple emoji stays whole
- `isCountableUserBubble` (from webview-helpers) false for `.queued` and `data-steer="1"`
- answer extraction skips thinking / tool cards
- zero turns → mount `hidden`
- one turn → one bar, rail unhidden
- click calls `scrollToTurn` with that `userEl`
- click when the fake host returns `false` does not throw
- hover popover contains the truncated question and answer
- empty pending answer shows `"Answering…"`
- `"(image)"` / `"(attachment)"` fallbacks

Thin packaging assertions (existing getHtml tests or a small addition):

- Desktop HTML (`canSwitchWorkspaceFolder: true`) includes `turn-rail.js`,
  `turn-rail.css`, and `id="turn-rail"`
- VS Code HTML includes none of those

Existing `test/webview-harness.ts` `BODY` has no `#turn-rail`; current
chat.js DOM tests must keep passing with the rail unmounted.

## Docs to update when the feature ships

- `docs/architecture.md` module map: one line for `media/turn-rail.{js,css}`
- `README.md` (GitHub) desktop feature list: one bullet. Do **not** add a
  desktop screenshot to `README.marketplace.md`
- `CHANGELOG.md` under Added when the PR lands, not in this spec commit

## File list

Create:

- `media/turn-rail.js`
- `media/turn-rail.css`
- `test/turn-rail.dom.test.ts`

Modify:

- `src/sidebar.ts` (`getHtml` desktop mount + assets)
- `media/chat.js` (createTurnRail host; rewind indexing calls `isCountableUserBubble`)
- `media/webview-helpers.js` (`isCountableUserBubble`)
- `docs/architecture.md` (module map, with the implementation)
- `README.md` (GitHub feature bullet, with the implementation)

## Decisions

1. **Separate module, not a `chat.js` dump** — same split as the file panel;
   the rail is testable without booting the full webview.
2. **Overlay gutter, not a new column** — matches the requested OpenCode
   left-edge index without stealing width from projects or files.
3. **Fixed-gap pinned list, independently scrollable** — not a minimap;
   every loaded turn stays clickable without shrinking bars.
4. **Desktop only** — the shared chat column in VS Code is too narrow.
5. **Truncate both fields** — question 80, answer 160, grapheme-safe.
6. **Stale click is silent** — the bubble can vanish between pointer down
   and scroll because of rewind, clear, or session switch.
