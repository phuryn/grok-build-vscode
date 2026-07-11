# Multi-workspace — the Grok Workspaces panel + per-session workspace ownership

Status: **shipped on the `multi-workspace` branch** (2026-07). This is the
feature deep-dive: what was built, the design decisions and why, current
limitations, and the extensions deliberately left for later. The current-state
summary lives in [CLAUDE.md](../CLAUDE.md) (§ Module map, § Session pool →
Workspace scope, § ACP surfaces) and [docs/architecture.md](../docs/architecture.md)
(§ The Workspaces panel); this file holds the reasoning.

## What shipped

1. **Per-session workspace ownership (`Session.cwd`).** Every live session
   records the folder its grok process was spawned in, and *everything derived
   from a session* goes through it (`sessionCwd` in sidebar.ts): the spawn cwd,
   the plan-gate containment root, the workspace `.env`, the **project**
   `.grok/config.toml` lookup (always-approve detection, #31 — the
   highest-stakes item in the audit: without it a cross-workspace session would
   read the *window's* project config and could silently auto-approve), chat
   file-link resolution, the empty-primer cleanup, and the mtime read-cache
   (keys are now `cwd + id`). The window's own folder (`activeWorkspaceCwd`)
   remains the scope for window-level things only: the popover list, the
   startup empty-session sweep, voice `.env` credentials, export dialogs, the
   welcome-screen cwd.
2. **The Grok Workspaces panel** (`src/workspace-tree.ts`) — a native TreeView
   in the `grokPrimary` activity-bar container, **contributed by default**.
   Workspace nodes: the window's folder(s) first (multi-root included, never
   removable), then a persisted registry of added folders
   (`globalState["grok.addedWorkspaces"]`). Session rows carry the popover's
   status dots as colored `ThemeIcon`s. Pagination: **5 rows per workspace**,
   then a grayed **"Show more (N hidden)"** row (+10 per click) — an empty
   TreeItem label with description-only text, which native theming renders dim
   with the standard hover highlight in both light and dark.
3. **The pure data layer** (`src/workspaces.ts`) — discovery, identity,
   registry policy, index merging, tree presentation helpers. All unit-tested
   against an in-memory `FsLike`.
4. **Cross-workspace open.** Clicking a session homed elsewhere spawns grok in
   *that* folder (`openSessionInWorkspace` → `openSession(id, storageCwd)`); a
   live pool member re-focuses instantly regardless of its workspace. "New
   session here" and "Open folder in new window" ride along.
5. **Panel ↔ chat coupling.** Tree visibility posts `historyPanelVisible`; the
   chat hides its own history button while the panel is showing (New stays).
6. **Per-workspace Clear sessions** — deletes a workspace's on-disk history
   across *all* its storage spellings while **preserving every live session**
   homed there (see below).

## Design decisions

### Identity is canonical; disk access is literal

grok keys its store by the **exact spawn cwd**, URL-encoded:
`~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/`. One real folder can
therefore appear under several spellings — VS Code's `Uri.fsPath` lowercases
the Windows drive letter (`c:\proj`) while a terminal usually doesn't
(`C:\proj`); trailing separators and slash direction vary too. Two rules:

- **Dedupe/equality** uses `canonicalizeWorkspacePath` (win32: case + slash +
  trailing-separator folding; POSIX: trailing slashes only — case is
  significant there).
- **Every read/delete/spawn** uses the literal on-disk spelling
  (`WorkspaceRef.storageCwds`, plural). The canonical form never touches disk.

The subtle half of this: on a **case-insensitive filesystem** (NTFS, APFS
default) two spellings resolve to the *same physical directory*, so indexing
both would double-list every session. `mergeSessionIndexes` therefore dedupes
by session id (UUIDs — unambiguous). On case-sensitive filesystems the two
spellings are genuinely two dirs, and the merge aggregates them under one node.

### Discovery over configuration

"Add workspace" quick-picks from `discoverWorkspaces` — a readdir +
`decodeURIComponent` over the store's dir names, with session counts and
recency, no summary parsing. This sidesteps the encoding-fidelity trap
(re-encoding a user-picked path and missing the store dir by one character of
case) because the offered paths *are* the store's own spellings. Browse… stays
as the escape hatch for folders grok hasn't seen yet.

The suggestions are filtered through `isInternalWorkspacePath`: grok-internal
cwds — anything under the OS temp dir (our own live tests leave `grok-live-*`
scratch workspaces there), under Windows `AppData`, or inside `~/.grok` itself —
are noise no user would add on purpose, so they're excluded from the quick-pick.
The filter applies to *suggestions only*: the active folder and explicitly
added/browsed paths are never filtered.

### Clear preserves every live session

`clearSessions` grew `exceptIds` (plural). The workspace-level clear collects
the ids of **all** pool sessions homed in that workspace — focused *and*
backgrounded — and skips them. Two reasons: deleting a live session's dir
doesn't stick (grok re-persists it on the next turn), and a working background
agent shouldn't silently lose its record. This is a deliberate semantic change
from the old popover behavior (which kept only the focused session and tore
down + deleted backgrounded live members); the confirm dialog states both
counts ("Delete N … M live sessions will be kept").

### Default-on

The panel ships enabled (an activity-bar icon appears for every install). The
call: it's intended as a primary surface, it's useful even single-workspace
(the only *persistent* view of live dots + unread badges — the popover is
transient), opt-in features are hard to discover, and VS Code's native
hide-affordances (right-click the icon) cover anyone who objects.

### Refresh plumbing

The sidebar exposes `onDidChangeSessions`, fired from `postSessionsList` (every
catalog mutation funnels through it) and on every dot change
(`pushDot`/`disposeSession`). The tree debounces 200 ms — a working session
fires several events per turn. The tree's in-memory overlay mirrors the
popover's: synthesized rows for live not-yet-persisted sessions, and the
"New session" display-name override for live primer-only sessions.

## Dot semantics (same policy as the popover — `computeDot`)

| Dot | Meaning | Source | Survives reload? |
|---|---|---|---|
| blue | working right now | live pool status (this window) | no — live state |
| yellow | **needs you now** (permission / question / plan card waiting) | live pool status (this window) | no — live state (the pending request dies with the process) |
| green | finished while unfocused, **not opened since** ("unread") | persisted `SessionMetaOverride.unread` in globalState | **yes** — cleared on open |
| red | same as green but the turn errored | persisted `unreadError` | **yes** |
| gray | at rest (idle / read / cold) | default | — |

"Unread" is deliberately a *badge*, not a live state: fire off several agents,
close the laptop, come back — the green dots are exactly the sessions with
results you haven't looked at. Yellow is deliberately *not* persisted: a
pending approval only exists inside a live process, so a persisted "needs you"
would routinely be a lie after a reap or restart.

## Known limitations

- **Cross-window live status.** Blue/yellow only reflect sessions run by *this*
  window's pool. A session running in another VS Code window shows at most its
  persisted unread badge (globalState is shared per-profile, with lazy sync).
- **Active-editor context chip.** A cross-workspace focused session keeps the
  window's own editor chip — absolute paths still resolve for grok, but
  relative-path ergonomics degrade, and plan-mode containment guards the
  *session's* folder while you're looking at the window's.
- **Deleting the focused session from the panel** isn't offered (same rule as
  the popover: the live CLI re-persists it, so it wouldn't stick).
- **Session counts in the Add quick-pick** are dir-entry counts (cheap hint,
  not a parsed truth).

## Possible extensions (deliberately not built)

- **Cross-window "needs you" / live status.** Theoretically doable, two ways:
  1. *globalState mirroring* — persist `needs-you` like `unread`. Cheap, but
     globalState syncs lazily between windows and a flag that outlives its
     process is a lie; it would need a heartbeat/timestamp guard to self-expire.
  2. *Per-session status file* — the owning window writes
     `status.json` + heartbeat under the session dir (or `globalStorage`);
     other windows watch it (`fs.watch`/poll). Reliable and crash-detectable
     (stale heartbeat ⇒ demote to gray), more moving parts. This is the right
     design if the panel should become a true cross-window dashboard.
- **Open-in-new-window with auto-resume** — stash a "resume session X" note in
  globalState for the new window's activation to consume. Skipped: same-window
  opening made it near-redundant.
- **Workspace-scoped defaults** (model/effort/mode per workspace node).
- **Worktree UI** (CLAUDE.md § What's next) — workspace nodes are the natural
  parent for worktree children.
- **Panel search/filter** across workspaces (the popover's search stays
  window-scoped).

## Verification

- **Unit (grok-free):** 787 total. New: `test/workspaces.test.ts` (22 — incl. the internal-path suggestion filter,
  the two-spelling merge and the id-dedupe double-listing guard),
  `test/history-panel.dom.test.ts` (2, drives the real chat.js), `clearSessions
  exceptIds` (2). Protocol exhaustiveness re-verifies `historyPanelVisible`
  across protocol.ts / webview-helpers.js / chat.js automatically.
- **Live (real grok):** new `parallel-workspaces` — two concurrent processes on
  two temp cwds; asserts independent answers, per-cwd store placement via the
  real compiled `sessionsDirFor`, and that the real `discoverWorkspaces` +
  `indexSessions` see both workspaces. Full gate 12/12 (one `plan-mode` run
  timed out at 240 s — a slow grok turn, passed on retry at 247 s; path
  untouched by this feature).
- **Electron smoke:** activation with the tree registration passes
  (`npm run test:integration`, 3/3).
