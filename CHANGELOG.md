# Changelog

## Unreleased

### Added

- **Desktop: jump a long conversation from the left gutter.** Each question/answer pair gets a bar on the left edge of the chat. Click jumps to that turn; hover previews a truncated question and answer. VS Code is unchanged.

## 3.15.0 — 2026-08-23

### Added

- **A file read is now a link to the file, and clicking it shows you the file.** A `Read` row reads `Read chat.js lines 8400-8459`, with the path and range themselves clickable and no excerpt underneath — the six lines it used to print were the ones you could already see, and they cost the row the space the path needed ([#122](https://github.com/phuryn/grok-build-vscode/issues/122)). In an editor the link opens the real file with those lines selected. In the desktop app it opens a preview showing the **whole file** with line numbers and the agent's lines marked in blue, scrolled to them — the surrounding context is the reason to click, and until now that surface showed only the excerpt. Both previews gained **Open in file panel**, beside Copy and Save As, for when a glance turns into reading.

### Fixed

- **Connectors stop asking you to sign in again when more than one window is open.** `mcp-remote` pins its sign-in port to the one recorded in its own registration, and on Windows it cannot see that another window already holds it. The extension answered that collision by retrying on a different port — which is `mcp-remote`'s signal to discard its registration and enrol afresh, so a browser tab opened, and because the credential store is shared, every other window was pushed into signing in too. One collision re-authorised the machine. The collision is now reported instead of worked around: it means the connector is already signed in and running, which is the good case.
- **Links to files under `~` open ([#125](https://github.com/phuryn/grok-build-vscode/issues/125)).** `~/Downloads/notes.md` was treated as a relative name and looked for inside the project, so clicking it said the file was missing. `~` is now expanded to your home directory. `~someone/…` is deliberately left alone — resolving another account's home needs more than a guess.
- **Reading a whole file no longer invents a line range.** A read with no offset or limit showed `lines 1-812`, which was not a range the agent chose but simply the length of the file. The row shows the path alone, and the link opens the file with nothing selected.
- **Expanded tool details appear while the agent is still working.** With *Expand tool details* on, a group settled its expansion only once the batch had finished, so reads and searches stayed collapsed until the end — commands too. They open as the rows arrive now.
- **The desktop app was reporting no usage data at all.** Packaging rewrote the app's name, so its identity check could never match and telemetry disabled itself silently — which is correct behaviour for a fork and wrong for our own app. Every figure we had was therefore "of editor users" without saying so.
- **Usage data stopped discarding editors it did not recognise.** The host name was checked against a fixed list of seven products, so anything else — Antigravity IDE, code-server, Kiro, Devin, Windsurf — was dropped on the floor rather than recorded. It is now validated for shape, the same way the model name always has been.

### Changed

- **The anonymous usage event records four more things**, all documented in [docs/privacy.md](docs/privacy.md): which CLI the session runs on, how many connectors are set up on the machine, whether the session started in a git worktree, and whether this install has been seen before. Values only, never content — the CLI is one of three names, and the connector figure is a count, never the list.
- **`install.sh` and `release.sh` do what their PowerShell counterparts do.** The shell versions were about half the size, and the gaps were not cosmetic: `install.sh` could not build against a staging relay at all, `release.sh` skipped the screens gate, the wait for CI, the Open VSX publish and the local install, and was committed without its execute bit — so the command its own usage text documents could never have run. `install.sh --all` also found no editors on macOS, exited non-zero, and looked successful.

## 3.14.1 — 2026-08-22

### Fixed

- **Connectors stop asking you to sign in again.** `mcp-remote` stores its authorisation tokens in a folder named after its own version, and the extension was letting npm resolve whichever version was newest at the moment a session started — so every upstream release silently emptied your credentials and opened a browser tab for each connected service. Three versions shipped in twenty-four hours. The version is pinned now: the desktop app and the editors share one set of tokens, and changing it becomes a deliberate decision instead of a surprise.
- **View all on a Read row opens the file, not a copy of it ([#122](https://github.com/phuryn/grok-build-vscode/issues/122)).** It opened an untitled document holding just the lines the agent had read; it now opens the real file with those lines selected.
- **A long-running conversation stops growing its stored cost ledger without limit.** One entry per turn was kept forever; past 400 turns the older ones now fold into a running total.

## 3.14.0 — 2026-08-21

### Added

- **Three more connectors, and connectors that take a key.** **GitHub**, **Calendly** and **Airtable** join Settings → Connectors. GitHub is the first that authorises with a personal access token you paste on the row itself (fine-grained recommended) rather than a browser round trip — the token goes to the platform secret store, never into `grok.mcpConnectors` and never into a settings file you might share. Connecting it in one editor now takes effect in the others instead of disconnecting them.
- **A long conversation opens in a fifth of a second ([#102](https://github.com/phuryn/grok-build-vscode/issues/102)).** Opening a conversation with hundreds of turns took the better part of a minute and left the panel unusable while it worked. It now renders the most recent turns first and fills in the rest as you scroll back: 46 seconds became 191 milliseconds on the conversation that prompted the report, and resizing the panel went from a quarter of a second to ten milliseconds.

### Fixed

- **A reconnect feels like nothing happened.** Switching apps on a phone, locking the screen, or losing signal all drop the socket, and the reconnect used to be loud: the conversation was torn down before its replacement existed, the welcome screen flashed over a chat that was still coming back, the title blanked, the composer stole focus, and "Starting" appeared over a conversation that was merely being restored. The conversation now stays on screen throughout, and the panel says *Restoring conversation* rather than pretending to start a new one.
- **Your place in the conversation survives a reconnect.** A reader scrolled up was yanked back to the bottom when the transcript was replayed — twice over, and from more than one direction. If you had scrolled up you stay where you were; if you were at the bottom you keep following, as before.
- **A conversation name is a name, not the prompt that started it.** Whole first prompts were being stored as the conversation's automatic name — one had grown to 27,813 characters — which bloated the stored session index and slowed every read of it. Names are capped, and existing oversized ones are trimmed on load: the index on the machine that surfaced this went from 4.4 MB to 1.4 MB.
- **File-panel row actions stop sticking.** After clicking a row, its actions stayed visible and highlighted once the pointer had moved away.
- **The desktop app focuses the composer when it opens**, so you can type straight away.
- **Plan and permission cards stay with their turn** when a long conversation fills in earlier history, instead of draining to the wrong place.

## 3.13.1 — 2026-08-20

### Added

- **Connectors — sign in to the apps you already work in.** **Settings → Connectors** ships in release builds now; it was development-only in 3.13.0. Connect Linear, Notion, Atlassian, Canva, Stripe, Sentry or Cloudflare once on this computer and every agent can use them — Grok, Codex and Claude alike. You authorise in your browser and the tokens are cached by `mcp-remote` under `~/.mcp-auth`, so the extension never handles one. The page has three sections: apps you connect here, the grok.com connectors that follow your Grok account, and local Grok connectors declared in this machine's config files. Project-file servers stay off it.
- **Copy path and Copy relative path ([#120](https://github.com/phuryn/grok-build-vscode/issues/120)).** Every row in the file panel offers both, on files and folders, on the desk and on a phone.
- **Rate a Grok turn ([#114](https://github.com/phuryn/grok-build-vscode/issues/114)).** Thumbs on a finished turn send a rating to SpaceXAI. Off by default — turn on **Thumbs feedback to SpaceXAI** in Settings → General — and they appear only where the Grok session actually supports feedback, never on Codex or Claude.

### Fixed

- **Connectors could not start at all on macOS.** A desktop app launched from Finder inherits a PATH with no Homebrew in it, so `npx` was missing. Finding it was not enough either: `npx` is a script whose `#!/usr/bin/env node` line needs `node` findable as well, so the child's environment is fixed alongside the lookup. Windows keeps its PATH exactly as you wrote it.
- **Queueing a message with images keeps the images.** Attachments were dropped when a message went to the queue — everything you attached is queued with it, or nothing is. Steer carries them too, and an image's number is stamped when you attach it and never moves afterwards.
- **The context breakdown adds up, and stays put.** The rows in the popover did not sum to the figure above them, and a breakdown could be shown against numbers from a different reading. Each one now belongs to the measurement that produced it. Settings also stopped rebuilding itself over and over while open.
- **Queued messages look like sent ones.** Images in a queued message sit below the text, where they sit in a message you have already sent, and the first message in a conversation gets a little room above it.

## 3.13.0 — 2026-08-19

### Added

- **Find in a conversation.** Long conversations were navigable only by scrolling. There is now a find bar — in the **⋯** menu on every surface, and on **Ctrl/Cmd+F** in VS Code and the desktop app (the browser keeps its own find, and on a phone the menu is the only door there was). Next and previous, a live match count, case sensitivity, and regular expressions, with `^` and `$` matching per line. It searches what you wrote and what the agent replied, plus the label on each tool row — the command that ran, the file that was read — but not the contents of those rows: searching a common word used to bury the handful of hits in your conversation under dozens from command output and diffs. Matches are highlighted without touching the page, so nothing in the transcript stops working while you search.
- **The context donut shows where the window went.** Clicking it now breaks the used space into System, Tools, Messages, Skills, MCP and Free, with the auto-compact threshold. Grok only, and it costs nothing to look: the number comes from a control-plane reading rather than a question put to the model, so opening the popover does not consume the window it is describing. Contributed by @funkpopo.
- **Icons in the gear menu and Settings.** Knowledge work and Coding carry marks, as do Report a bug, Request a feature, Contact and the repository link.

### Fixed

- **A larger chat font no longer cuts the panel in half ([#119](https://github.com/phuryn/grok-build-vscode/issues/119)).** At 200% only a fraction of the chat was visible. The stylesheet was correcting for zoom in a way browsers used to require and no longer do, so the correction became the error — and it was wrong at every setting except 100%, overflowing below it as well as clipping above. Reported by @FireInWinter.
- **Slash autocomplete stops offering commands that would not run ([#110](https://github.com/phuryn/grok-build-vscode/issues/110)).** Skills work anywhere in a message; commands only run when they start it. The popover treated both the same, so a command typed on a second line was suggested, accepted, and then quietly sent as ordinary text. Now skills are offered wherever you are typing and commands only at the start, which is exactly where each one works. Reported by @ryukenshin546-a11y and @SimonEast.
- **A file the agent reads says which file, and which lines ([#122](https://github.com/phuryn/grok-build-vscode/issues/122)).** Read rows now carry the path and the line range, and open the whole file the same way command output does. Where the range is not reported, the path shows without one rather than a guess. Requested by @padixa.
- **Settings is clearer about what it can act on.** The **Account** page is now **Remote control**, which is what it does — linking this desk to a phone or browser. Version rows for the two ACP adapters are gone: they ship inside the extension and move only when it does, so there was nothing to act on. The Codex updates row is gone for the opposite reason — it said updates were handled elsewhere, which was untrue whenever the extension had installed Codex itself.
- **A fresh clone no longer produces a file the tests cannot parse.** The repository never declared its line-ending convention, so a new checkout on Windows could rewrite a script's first line into something Node refused to read.

### Internal

- MCP server inventory, read from the agent's own rails rather than a command that cannot see managed connectors. Contributed by @funkpopo. Together with the connector work it is visible in development builds only, until a failed sign-in stops leaving a process behind.
- The unit suite stopped reporting the machine's mood: bounds that were measuring how fast a subprocess starts, rather than detecting one that had hung, made three or four unrelated tests fail per run.

## 3.12.4 — 2026-08-18

### Fixed

- **MCP tool calls show what went in and what came back.** An MCP call was a single line with no way to see the arguments or the result. It now gets the same expandable IN/OUT block shell commands have, on all three agents — which took measuring each one, because they agree on nothing: the tool name, the arguments and the result each live somewhere different, and two of the three send no `content` at all on completion. Grok's internal tool-search rows fold into the explore group instead of cluttering the transcript, and a Codex server that genuinely fails to start still says so.
- **Long tool names stay readable.** A name like `mcp.codex_apps.codex_document_control.list_documents` was cut at the end — exactly where the useful part is, leaving a column of rows that all read the same. Long names now elide in the middle, keeping both ends, and hovering shows the complete name.
- **Skill search looks at descriptions, not just names.** A skill you remembered by what it does rather than what it is called was unfindable. Matching now covers descriptions, name matches still rank first, and the matched words are highlighted wherever they landed so a description-only hit makes sense.
- **Opening a long conversation no longer scrolls endlessly.** Loading a big conversation replayed every message while forcing the view to the bottom after each one — roughly fifteen hundred times on the largest conversations here, which read as an infinite scroll that only stopped when you switched away. The view now settles once, at the end, and loading is quicker for it. Opening the same conversation twice at once can no longer interleave two copies of its history either.
- **Grok conversations stop jumping in Recents when you open them.** A `session/load` rewrites `events.jsonl`, so ranking by that file promoted whatever you had just opened — and, because the previously-opened one carried a fresh stamp too, it often looked like the *previous* conversation jumping. Grok now ranks by `updates.jsonl`, which a load leaves alone and a real turn advances, so work done in the terminal still promotes a row. **Claude conversations can still jump** — its listing time is restamped on open and the pinning that should hold it does not yet survive in practice; Codex was never affected.
- **A live turn no longer dies at 30 minutes with `ACP request timed out: session/prompt` ([#117](https://github.com/phuryn/grok-build-vscode/issues/117)).** `session/prompt` stays open for the whole turn, but the client armed a one-shot 30-minute timer that streaming `session/update` traffic never reset — so a healthy long job (training, a long tool loop, many slow steps) was cut while the agent was still working. The timer is now idle-based: any ACP traffic re-arms it (default 30 minutes of silence). A 24-hour absolute cap remains as a safety net. Tune `grok.acp.promptIdleTimeoutMs`, `grok.acp.promptAbsoluteTimeoutMs` (`0` disables), and `grok.acp.requestTimeoutMs` on newly started sessions.
- **MCP tool results show the whole payload.** Codex rows that only printed a terse `Action completed.` were dropping `structuredContent` — where Gmail and similar servers put the actual messages. OUT now carries the text and the structured JSON, and a failed Codex call shows its error instead of an empty box. Pretty-printing that JSON stops at the 100K display cap so a nested result cannot expand into megabytes first, and a Claude JSON string is shown as the adapter sent it so 64-bit identifiers are not rounded.
- **Stopping a command still shows [Cancelled] when the browser is newer than the desk.** An older host that never sent a cancellation flag was being read as "not cancelled", so a genuine Stop lost its marker. The host now always says whether it was a kill.
- **Reopened conversations show shell command output again (#44).** Switching away from a live Claude conversation and back no longer drops the command's output.

## 3.12.3 — 2026-08-18

### Fixed

- **The desktop app no longer dies when a phone or browser connects.** Opening a remote client while the app happened to be refreshing its voice settings could crash it outright — a Windows error dialog and a dead window, not a degraded feature. A background file watcher was asking a client that had connected but not yet finished its handshake which project it was on, and treating "not ready yet" as a fatal error. It now waits for that client instead, and the same assumption has been corrected everywhere else it was made.
- **Dragging a panel edge follows your cursor when the UI is zoomed.** The rail and the file panel both jumped on grab and then drifted further from the pointer the further you dragged, because the drag was measured in screen pixels while the layout was in zoomed ones. Both now agree. At the default zoom nothing changes.
- **Codex shows which MCP tool it ran.** Calls to MCP servers appeared as a bare `Run`, so a row of them told you nothing — the name was on the wire, but a generic label was taking precedence over it. They now read as `mcp.<server>.<tool>`, matching how the same calls already appeared for Grok and Claude.

## 3.12.2 — 2026-08-18

### Fixed

- **Stray "New session" conversations stop piling up.** Checking whether an agent is signed in quietly started a real conversation and then tried to end it — but that particular cleanup never worked, so every check left an empty conversation behind. They showed up as identical "New session" rows you could not open (the CLI cannot load a conversation with no messages) and that survived **Clear all**. The check now runs somewhere harmless and removes after itself, so nothing new accumulates. Anything already on your disk stays where it is and is inert; it was never taking part in your work.
- **Clear all history finishes the job.** It deleted the files while the agent processes were still shutting down, so on Windows the delete could fail — or the CLI would write the conversation back — and the rows returned. It now waits for those processes to exit first, and refreshes the project list for projects other than the one you are looking at.

## 3.12.1 — 2026-08-17

### Fixed

- **The desktop app opens on a fresh install instead of hanging (#116).** Launching with no project configured sat on "Starting" forever. The app asked itself to open a conversation, found no folder to open it in, and returned without ever telling the window it had stopped working — so the loading state had nothing to clear it. Reported by @ffgrep, who also found the workaround: adding a project, or setting `workspaceRoots` by hand.
- **A first run now has somewhere to work.** Rather than asking you to understand projects before you can send a message, the app creates a **Grok Build** folder in your home directory and starts there. It happens once, only when you have no projects at all, and it is an ordinary project you can remove — adding your own stops it being offered again. Plenty of people want this for chat or knowledge work and have no reason to think about project organisation.
- **Removing every project gives you an empty state, not a spinner.** It names what is needed and offers **Add project folder**, and starting a conversation stays blocked until you add one — the same dead end was reachable that way too.

## 3.12.0 — 2026-08-17

### Added

- **Colour, rename and opening a conversation happen the moment you do them.** Picking a project colour, renaming a conversation, or opening one from the rail or history used to sit still for a second or two while the host was asked and answered — longest in the browser, where every confirmation makes a round trip to your desk. All three now apply immediately. Renaming anywhere updates every surface at once, so the top bar no longer shows the old name after you renamed it in the history list. Opening a conversation switches the title and holds the messages panel on a loading state instead of leaving the previous transcript sitting under the new name. Your desk stays the authority throughout: if it disagrees, or never answers, the display returns to what it actually says.
- **Maximize the file panel in the browser.** afkpilot.com on a monitor docks the panel beside the chat, exactly like the desktop app — but had no way to give it the whole window. It does now, with Escape to restore. On a phone nothing changes: the panel already fills the screen there.
- **Provider marks on Settings → Providers.** Each row carries its agent's mark, so Grok, Codex and Claude Code are identifiable at a glance rather than by reading down a column of names.

### Fixed

- **Opening a Grok conversation no longer runs it on a different agent.** With Grok disconnected, opening a Grok conversation from the rail reported "Failed to start Codex" — and it meant it: the conversation had been quietly handed to whichever agent could answer, because a freshly opened session looked empty before its history loaded. A conversation now keeps the agent it belongs to, and if that agent cannot answer you are told so by name. The wrong error text was the visible symptom; running your conversation on an agent you did not choose was the actual bug.
- **Refresh finds an agent you signed into somewhere else.** Approving Grok in a browser and pressing Refresh in Settings → Providers did nothing, because it only re-checked accounts already marked connected — which is precisely the case you press it to fix. Every installed agent is re-checked now.
- **The ⋯ menu stops closing itself while projects load.** Opening it during the first seconds after a window opens had it vanish every few seconds until the project list settled.
- **The browser matches the editor's text size.** afkpilot.com on a desktop rendered a size larger than the same UI in VS Code or the desktop app, because the browser has no editor font setting to inherit and fell back to its own default. It now matches at 13px. Phones and tablets are unchanged — text stays at the larger size the touch layout was designed around.

## 3.11.0 — 2026-08-17

### Added

- **Settings → Providers can be made to tell the truth.** The page said whether Grok, Codex and Claude were connected, but nothing ever re-checked: sign out inside a terminal, install a CLI, let a token lapse, and it kept repeating whatever it last heard. There's now a **Refresh** button above the list, and opening the page runs the same check on its own. It re-looks for each CLI and re-tests the accounts that are actually connected — it never marks an account connected on your behalf, so a refresh can only ever tell you what is true. The button says "Checking…" while it works. On the phone the list stays read-only, as it was, but it updates the moment your desk re-checks.

### Fixed

- **The VS Code settings tab keeps up with your accounts.** Opened as an editor tab, Settings → Providers only ever showed the state it started with — connect or sign out anywhere else and that tab never heard about it, so it could sit there contradicting the sidebar until you closed and reopened it. It now receives the same live updates every other surface gets.

## 3.10.1 — 2026-08-16

### Fixed

- **Grok can see the images it opens (#79).** Asking Grok to read a `.png` or `.jpg` came back `Cannot read binary file`, while the same CLI in a terminal described pictures happily. The cause was on this side: the extension told the CLI it could resolve files on its behalf, and that routed *every* read — images included — down a text-only path with no image branch. It no longer does, so reading a picture reaches the CLI's own image-aware path and the model actually sees it. Generated images, screenshots a subagent produced, anything Grok opens by path. Pasting and attaching images were never affected — those always sent the pixels, and still do. Applies to grok CLI 1.0.4 and newer, where that image-aware read exists; older CLIs keep their previous behaviour, and Codex sessions are unchanged.
- **Codex Auto accept stays Auto accept.** Codex reports Plan/Default and Agent/full-access as two options on every snapshot. Treating collaboration `default` as the host mode discarded `agent-full-access`, so picking Auto accept snapped back to Agent and approving a plan from full-access implemented under an Agent badge.
- **A rejected Plan switch no longer leaves the Plan badge up.** The toolbar followed the click, not `session/set_mode`. When that RPC failed, Claude and Codex stayed writable (no client gate) while the UI claimed Plan.
- **Plan mode blocks a command that arrives in the same stdout chunk as the switch.** Raising the client gate after `await setMode` left a window: readline can deliver the success reply and a `terminal/create` in one turn, and the handler still saw the gate down. A successful Plan reply now commits the gate in the response hook, before the next line is dispatched. A refused switch still leaves the badge and gate unchanged.

## 3.10.0 — 2026-08-15

### Added

- **Touch sizes for real fingers.** On phones and tablets the whole UI steps up: 15–16px text in the rail, file tree and panel (reading prose goes 12 → 15px), every row you tap is at least 36px tall — including the project headers and tree rows that quietly sat under the floor — and every tap target meets one universal 36px minimum with zero exceptions. Text inputs go 16px on touch, which stops iOS Safari's zoom-lurch when you focus the search or the composer. The code viewer deliberately keeps its smaller type: columns beat point size on a phone. Desktop and mouse layouts are pixel-identical to before.
- **File tabs that behave like tabs.** The file panel's strip stops scrolling: named tabs shrink to icon-only, then overflow into one "…" chip styled like a tab — and whatever fits shows its whole name, extension included, so `.env` and `CLAUDE.md` read fully instead of becoming `…`. The active tab always keeps its ✕ and its name; maximize/minimize sits pinned at the right and can never silently disappear; on desktop, maximize gives the panel the whole window until Escape.
- **A real mode switcher in the file viewer.** Reader and Source are a proper segmented control with a filled selected state; Cancel, Save and ⋯ sit at the right end; and both "…" menus now close when you tap their button again.
- **One icon scale everywhere.** Every top-bar icon rides the same 20px glyph in an invisible touch-sized hit box with color-only hover — chat header, file panel and rail now measure identical on the phone.

### Fixed

- **Refreshing the phone lands in your conversation, directly.** The page holds a quiet "Restoring conversation…" instead of flashing a blank New session (title bar included) and then swapping. Restores survive a just-reloaded desk (the host waits out its own cold start instead of refusing), a genuinely failed restore says so once and hands any queued text back to the composer — including text queued mid-turn, which used to vanish — and a brand-new empty session refreshes clean instead of announcing "could not restore" over phantom "queued actions".
- **Transient agent hiccups stop painting terminal errors.** A failed provider start retries quietly before surfacing; a process that dies mid-startup can no longer be treated as running (which could silently swallow an automatic sign-in retry); and "exited (code 0)" on an empty conversation — a clean exit with nothing to say — no longer renders as a red must-restart banner.
- **Worktree dialogs answer the conversation they were opened for.** Fork, apply and remove name their session on the wire and the host refuses a mismatch, so a confirmation answered after switching conversations can never land on the wrong one.
- **Just the conversation name.** The repository suffix under session names is gone on every surface — the rail already says which project you're in.
- **The `/` command popover hugs its content** instead of spanning the whole composer.

## 3.9.0 — 2026-08-14

### Added

- **Parallel subagents stop scrambling the chat.** The CLI streams every agent's words onto one wire, interleaved mid-sentence — and the transcript used to paint them that way (#62). Each subagent now gets its own card in the conversation: collapsed with a live one-line status while it works, expandable to its own transcript of prose and tool calls, with the parent's narration staying coherent above it all. Old CLI versions that never interleaved behave exactly as before.
- **All settings, one place.** A full settings surface — search with `/`, categories with icons, one row per setting with a sentence that says what it does. On desktop and the phone it opens over the app with **← Back to app** as the exit; in VS Code it's an editor tab plus a native gear icon on the Grok view's title bar. The gear popover slims down to quick actions and one Settings entry. **About** lives at the bottom of Settings now — versions, update check, report-a-bug and feature-request links, and a support contact. Restore defaults confirms first with a concrete list, and never touches things you wrote yourself (voice dictionary, send phrase).
- **Voice's fiddly bits are editable** — the spoken send phrase and the recognition dictionary, from any client including the phone, saved to the config scope that actually wins.
- **The telemetry switch is visible.** The existing anonymous-usage setting has a real toggle on desktop and a row everywhere, with the honest description: one anonymous session-start event, never prompts, code, paths, or identity; the IP address is discarded, never stored.
- **Devices tell afkpilot.com what they are.** Linking (and every reconnect) now reports the client kind and OS, so the device list can show "DESKTOP-X (VS Code extension, Windows 11)" with the right OS mark — existing devices label themselves on their next connect, no re-linking needed.
- **Unlink from the desktop app** — gear → Your account → "Unlink this device…", with a native confirmation naming the machine. The palette-less desktop finally has the deliberate path (#112's side-finding).

### Fixed

- **Desktop opens in its real layout.** The brief flash of the old panel-less UI before the rail and file panel arrived is gone — the full three-column chrome paints from the first frame.
- **Rail menus stop growing sideways.** Context menus cap at a sane width with ellipsis instead of stretching as wide as their longest entry.
- **The gray idle dot next to provider logos is gone** — the logo already says which agent owns the session; the dot only returns for states that mean something (working, needs you, unread, error).
- **"How it works" tells desktop users the truth** — "Keep this app open," not a list of editors you're not using.

## 3.8.0 — 2026-08-14

### Added

- **The desktop app updates itself.** Windows and macOS builds check quietly in the background, download the new version while you keep working, and the rail button becomes **Restart to update** when it's staged — one click installs silently and brings the app right back. A normal quit installs it too. No wizard, no SmartScreen detour, no download page: that whole trip now exists only as the fallback when the feed is unreachable. An in-flight reply is never interrupted — the update waits for your click or your next quit.
- **Typing part of a command's name finds it.** `/rev` matches `/code-review` now, not just commands that start with those letters — commands beginning with what you typed still list first (#110).
- **Anonymous usage telemetry knows the app from the editor.** The one existing session-start event now says whether it came from the desktop app or VS Code, and which settings shape the session (mode, model, effort, thinking traces, voice on/off, which agents are connected). Strictly enums and booleans — a new test proves no path, filename, or free text can enter the payload, and any value the app hasn't actually measured is omitted rather than guessed. The full field list is in docs/privacy.md.

### Fixed

- **The projects rail no longer vanishes on desktop startup.** Opening the app with a restored conversation could boot into a chat with no left rail at all — every time, on some machines — until a hard reload brought it back. The startup handshake was mistaking its own just-started session for a window reload and skipping the project list on the strength of it.
- **The desktop window can no longer open scrambled.** An occasional first paint had the content shifted and cropped at both edges, panels pushed off-screen, zoom applied twice. The window now shows only once the page can measure it, the app's zoom is the only zoom, and a boot-time focus can no longer scroll the layout into a stuck state.
- **Your history is there before the agent is.** With the CLI still starting — or not installed at all — conversations on disk now list and open read-only instead of showing an empty rail behind a blank onboarding screen.
- **Grok 4.6** replaces Grok 4.5 across the listing and manifest, and packaging keeps the Codex adapter's dependencies out of the shipped artifacts (5.2 MB vsix, 17 MB desktop asar — with the ~350 MB Codex platform binary provably excluded from both).

## 3.7.0 — 2026-08-13

### Added

- **OpenAI Codex can run alongside Grok.** Connect it from the gear in VS Code or Settings on the desktop; models from both providers share one picker, every conversation keeps the provider it started with, and both providers' sessions sit side by side in the rail. No Codex CLI installed? The app offers to install a pinned, checksummed copy for you. A phone sees which providers are connected; signing in and out stays at the desk.
- **Export a conversation as Markdown.** In the conversation's ⋯ menu on every surface — VS Code opens it as an untitled document, the desktop asks where to save, the browser downloads the file. Rewound turns and hidden bookkeeping never leak into it, and an export of a partial phone history says so instead of passing as the whole conversation.
- **The VS Code chat grew its own ⋯ menu.** Continue in a new chat moved there from the gear, alongside the new export — per-conversation actions live with the conversation now.
- **"View all" and proposed diffs open inside the desktop app.** A themed, syntax-highlighted overlay with Copy and Save As replaces the bare read-only window that knew a file's language but couldn't paint it.
- **Copy Link.** Right-click — or long-press on a phone — a link in the transcript to copy its real address; file references copy their path.
- **Shell scripts can be saved from the file panel.** Editing `deploy.sh` or a `.ps1` was refused with "executable path refused" — a check written to stop the operating system *launching* a file, reused to decide whether you were allowed to *write* one. It stopped only the person: ask grok to edit the same file and it always could. The refusal stays exactly where it belongs, on Open in default app and Reveal. `.bat` and `.cmd` also open in the panel now, which `.sh` and `.ps1` already did.
- **Opening a conversation logs where the time went.** One line in Output → Grok splits the open into its phases, so a "sometimes slow" report can carry numbers instead of an impression.

### Fixed

- **The chat no longer scrolls away from the bottom on its own.** With the UI zoomed and tool details expanded, answering a permission card — or just a growing reply — could unpin the view and bring the "Scroll to bottom" button back every turn. Only a real gesture (wheel, touch, scrollbar, paging keys) unpins now; a reader who scrolled up to read history stays exactly where they are.
- **"View all" opens with a language.** A command opens in your shell's language, and output is no longer forced to Plain Text, so the editor can recognize JSON, logs and generated code.
- **Copy and the timestamp under a message are readable without hovering.** They rest dimmed instead of invisible — and on a phone they take a direct tap, no gesture first.
- **Plan mode is no longer lost to a slow version check.** A first `grok --version` after install can time out (Windows antivirus is the usual cause). The last verified version for that binary is remembered, so a failed probe keeps Plan when the file has not changed. That memory is only a stand-in — picking Plan checks again — so a later update is not stuck behind a stale reading, and a live check still replaces the stand-in either way. A live reading of an old CLI is still refused. The disabled message now says the check failed and that picking Plan again or reloading retries it.
- **Windows machines can sleep with the chat panel open.** The first click created an audio session and never released it, even with every sound setting off. The session is created only when a sound is actually on, and it is suspended again once the tone finishes.
- **Everything you tap on a phone is at least 36px.** The rename pencil was 22px — below the accessibility minimum — and the file-panel toggle, the one you use to reach files at all, was 28. Save and Cancel were 26 tall. Mouse-driven windows keep their compact controls; the larger targets appear only where the pointer is a finger.

## 3.6.0 — 2026-08-12

### Added

- **Code in the file panel is syntax-highlighted — while you read it and while you type.** Every file that was not Markdown or JSON opened as flat grey text: fine for a glance, tiring for anything longer. Around sixty file types now colour their comments, strings and keywords, and the colours stay when you switch to editing rather than vanishing the moment you tap Edit. It is our own highlighter rather than a library — the panel runs under a strict content policy that cannot load one, and the alternative was ~200KB of parser in every page load for something you mostly skim.
- **`.sql` and about twenty more file types open in the panel at all.** They used to be handed to the operating system, which on the desk is a detour and from a phone means they could not be opened. `.scss`, `.ini`, `.conf`, `.rb`, `.php`, `.kt`, `.swift`, `.cs` and `.diff` are among the rest.
- **A link in a README opens the file it points at.** Tapping `_shared/auth.ts` in a rendered Markdown file was treated as a web address, so from a phone it navigated away from the app entirely. It now opens that file as a tab. Links that really do point at the web still go to the browser.

### Fixed

- **Referring to an image the agent could not find.** Attach a picture, attach another in a later message, and asking about the second failed with *"does not match any attached image"*. The tag said `#2` because it was the conversation's second image; grok counts the images on the message it is reading, where it was the first. Images are now numbered from 1 in every message — in the tag and in what you see — so the number you read is the number the agent was told. Two pictures in one conversation are both "Image #1" now, each in its own message, which is the trade that makes the reference work at all.
- **Deleting the last empty line of a file, and having it come back.** The editor said "Saved." while the file on disk kept the newline you had just removed. Saving a formatted `.json` had the mirror-image problem: it quietly *removed* the final newline every time, so `package.json` came back with a spurious change after any edit.
- **The file panel is the whole screen on a phone and a third column on a desktop — never something in between.** At tablet widths it floated over the middle of the chat with the projects rail showing behind it. Below the width where it can sit beside the conversation it now takes the screen, and the panel's own close button brings you back. Files no longer carry individual close buttons there — two small targets side by side, and a project tab that looked closable but was not.
- **A file that cannot be previewed opens as a tab, with the reason inside it.** The message used to be painted over the file tree with no tab at all, so nothing told you which file had failed, and the tree's search box stayed on screen above it. On the desk the file was also handed straight to your operating system before you could see what it applied to; *Open in default app* is now offered inside that tab instead of taken on your behalf.
- **"More actions" in the file viewer opens.** On Grok Build Desktop the button did nothing, silently — the click that opened the menu was also the click that closed it.
- **A conversation you send to rises up its project in the rail.** Sending in one project never told a connected browser that a *different* project had just become active, so its position there went stale.

## 3.5.0 — 2026-08-11

### Added

- **The browser gets the desktop's file panel — the same one.** Browsing files from your phone was a different piece of software from the panel in Grok Build Desktop: a flat list you stepped through, one file at a time, floating over the chat. It is now literally the same panel — a tree you expand in place, several files open at once as tabs, and on a wide screen it docks beside the conversation instead of covering it. On a phone it still opens as a drawer, because a phone has no room for a third column. There is one renderer now instead of two that drifted apart every time either was touched.
- **Version & about describes the machine you are driving.** On a phone the page said "This extension" over a "Checking for updates…" that never finished — the desk machine's own panel, shown to a device that is neither the extension nor able to update anything. It now says what you are holding, what it is connected to, and the two versions installed over there. No update button: the binaries live on the desk machine and only the desk can replace them.
- **Opening a conversation from GROK: PROJECTS brings the chat forward.** The rail has its own icon in the activity bar, so a click could load the conversation behind whatever view you were looking at and read as having done nothing.

### Fixed

- **Saving no longer throws you out of the file, or moves your cursor.** A successful save dropped you back to the read view, so carrying on meant clicking Edit again — for the ordinary habit of saving as you work. It also rebuilt the editor, which sent the caret to the top and lost your selection and scroll position. You now stay exactly where you were.
- **The right-click menu in the file panel respects zoom.** It was placed at raw pointer coordinates while the chat scales, so the further from the top-left you clicked, the further away the menu appeared. It also could not flip up and had no bottom clamp, so it could open off the screen.
- **The file panel's toolbar buttons are visible.** Every icon on the open-file row rendered as an empty box.
- **Markdown reads like every other file type again.** It had become the only kind with a worded toggle while everything else got an icon, so one toolbar looked like two designs.
- **Conversations sit at one spacing everywhere in the rail** — including under a section label, which used to sit noticeably further from its first row than the rows sat from each other.
- **The project name is no longer truncated when nothing sits beside it**, and the shading behind a row's hover actions matches the row rather than the panel.
- **The VS Code rail stopped re-reading every project on every refresh.** Each refresh asked every other project for its conversations again — a full pass over its history — even when nothing about it had changed.
- **A phone can no longer start a CLI update on your desk machine.** The status still travels, so you can see the CLI is behind; acting on it belongs to the machine it is installed on.

## 3.4.0 — 2026-08-10

### Added

- **Archived projects stay on the desk.** A project you have filed away no longer appears on your phone, and its conversations, files and pinned rows go with it. Working in it again at the desk brings it back. Opening it in VS Code keeps it visible throughout — filing something away was never meant to hide the thing you are looking at.
- **Opening a conversation now says where its time went.** The log records each phase of an open — waiting for the previous CLI to exit, checking its version, starting it, loading the transcript — so a slow one can be explained instead of guessed at. Measured first: ordering 1,786 conversations takes 190ms, so the wait was never the history list.

### Fixed

- **Renaming a conversation no longer makes the top bar jump.** The rename pencil is a fixed-height button and the tallest thing in that row, so hiding it collapsed the row and took 7px off the whole bar, dragging the project line and the separator up with it.
- **The top-bar icons sit level.** They were 2px from the top edge and 15px from the rule underneath, left behind when the conversation name grew a second line.
- **A file type is no longer linked as a file.** "The main `.md` files" turned `.md` into a link to nothing; a bare extension names a kind of file, not one you can open. `.env` and `.gitignore` still link, being real filenames.
- **A crashed CLI no longer keeps a worktree slot forever.** If it died while a worktree was still being copied, the dead process stayed referenced until the window closed.
- **The extension's own docs name SpaceXAI** where they describe who makes Grok. The trademark line still reads xAI, which is what the rights holder's own brand guidelines ask for.

## 3.3.1 — 2026-08-10

### Fixed

- **Menus in the projects rail stop running away from the pointer.** On a wide rail a menu opens at the right-hand edge, next to the ⋯ button — far enough from the click that the "you have walked away" rule closed it before you could reach it. Walking away is now something you can only do after arriving.
- **"Set color" opens its swatches where the menu was.** Right-clicking a project opens the menu under the pointer, but choosing Set color threw the colours back across the rail to the ⋯ button, out from under the cursor that was following them.

## 3.3.0 — 2026-08-10

### Added

- **A projects rail in VS Code**, with its own icon in the activity bar. Every project Grok has worked in, side by side: pinned conversations, the ten most recent across all of them, and each project's own list underneath. Until now VS Code showed you one project — whichever folder the window had open — and everything else was invisible unless you reopened the window somewhere else.
- **Open a conversation from any project without leaving the one you are in.** Nothing reloads. The chat follows the conversation, and so do New Session, worktrees, and the file chips — a conversation in another project no longer quietly attaches a file from the folder VS Code happens to have open.
- **Browse your project's files from a browser, and edit them.** Open a text file on your phone, change it, save it. Images preview but cannot be edited; nothing else can be read or written, and every path is checked against the repository that tab has selected.
- **Projects can be added to the rail and hidden from it.** Adding one records it rather than reopening the window — VS Code turns a single-folder window into a multi-root one and restarts the extension host, which is not a reasonable price for putting a folder in a list.
- **Projects file themselves away when they go quiet.** Anything untouched for a month, and anything with no conversations at all, moves to an archive group; working in one brings it straight back. Opening a project in VS Code always lifts it to the top, marked **Your IDE**.
- **Projects can have a colour in VS Code**, as they already could on desktop and the phone.

### Fixed

- **Worktrees work again, and the reason they didn't is worth stating.** Not every worktree the Grok CLI makes is a `git worktree` — for some repositories it makes a full copy instead, which the original repository's worktree list will never mention. So a perfectly good checkout was created and then rejected as unrecognised, and the retry that appeared to succeed had actually been waved through on the CLI's own say-so, sometimes onto an empty folder where the agent then failed to start. Both halves are fixed: git is asked first and always, and a copied checkout is verified from a file on disk rather than taken on trust.
- **"Remove worktree failed: Internal error."** The CLI deletes the checkout and *then* fails to deregister it, so what was left was an empty folder and an error you could do nothing about. That leftover is now removed for you. A creation that *is* rejected also tells you where the checkout was left, instead of leaving orphans behind silently.
- **The rail's menu did nothing.** Rename, Delete, Clear all history and Hide project were all silent — VS Code disables the browser prompts they relied on, and every one of them read that as "cancelled". They ask properly now, which is also why the lists had looked frozen: nothing had happened to refresh them.
- **Recent updates when you send a message.** It ranks by when a conversation last changed, and that clock is written by the agent, not by the extension — so there was no moment on our side to notice. The end of a turn is now that moment.
- **Menus close when you look away.** A click anywhere else in VS Code never reaches the rail, so an open menu had no way to know it had been left behind. Moving the pointer well away from it closes it too.
- **"Move to Projects" appeared on projects already in Projects**, because the menu read a stored flag while the rail places rows by how recently you worked in them. The action follows the group the project is actually shown in.
- **A conversation's project is named under its title**, not beside it, and the rename pencil stayed where it belongs instead of dropping to a line of its own.
- **Deleting a conversation no longer fails with a directory-not-empty error on Windows**, which happened when anything still had the folder open for a moment.
- **Plan mode stops disappearing because a version check was slow.** Only a CLI actually verified as too old turns it off now, and the message says the version could not be checked rather than implying the CLI is out of date.
- **Grok Build Desktop's prompts look like dialogs.** The worktree prompt in particular was a window with rules across the top and bottom, no padding, the stock Electron icon, and a maximise button — a small web page rather than a question.

### Changed

- **Clicking a conversation in the VS Code rail highlights it immediately**, instead of waiting for the conversation to load. It has always worked that way on desktop, where the rail and the chat share a window.
- **"Current" is now "Your IDE"**, and it means the folder VS Code has open — not whichever project you were last looking at in the rail.
- **Section labels in the VS Code rail scroll with their conversations** rather than staying pinned at the top of the panel.
- **xAI is named SpaceXAI** where the non-affiliation notice says who we are not affiliated with. The trademark line still reads "of xAI", which is what their own brand guidelines ask for.

## 3.2.11 — 2026-08-09

### Added

- **Projects can have a colour.** Give each project a coloured folder in the conversation rail — *Set color* in its ⋯ menu, six colours or none. The choice is stored with your projects rather than in one browser, so it follows you to your phone. Desktop and browser.
- **Right-click works wherever ⋯ does.** Projects and conversations in the rail, files and folders in Grok Build Desktop's file panel — right-clicking opens the same menu the ⋯ button does. Not on touch, where a long press already means something.
- **Folders can be revealed in Finder or Explorer**, not only files, and the file panel's row actions now live in a ⋯ menu like the conversation list's do.

### Fixed

- **Conversations stop jumping to the top of the list for being opened.** Opening one rewrites its record on disk, and the list read that as activity — so merely looking at an old conversation promoted it above ones you had actually been working in. The list now follows the conversation itself. Measured against a real store of 1,592 conversations: 46 were sitting higher than they had earned.
- **Closing a project takes one click.** Clicking an unselected project used to switch into it and force it open, so the first click on an already-open one appeared to do nothing. It also left the chat on one project while the rail claimed another; switching now follows from opening a conversation, which is what made that state coherent in the first place.
- **The conversation list stops flickering while a conversation opens.** The row buttons blinked under a stationary cursor, and an open ⋯ menu was closed again on every refresh — so it could not be used at the moment you most wanted it.
- **The store listing printed "Install" and "Quick start" twice.** It is generated from the project README, and the generator was adding its own copy on top of the one already there.

### Changed

- **Clicking a conversation highlights it immediately** instead of waiting for it to load, so a click never looks dropped. The few actions that act on "whichever conversation is open" — continue in a new chat, and worktree apply/remove — grey out for that moment, because until the load finishes there is genuinely no safe answer to which conversation they would act on.
- **One waiting animation everywhere.** The status line's growing ellipsis is gone; everything that is working now shows the same three blinking dots, and they hold still if your system asks for reduced motion.

## 3.2.10 — 2026-08-09

### Fixed

- **Generated videos play, and 3.2.9 was wrong about why they didn't.** That release said the browser engine ran out of video decoders and stopped reserving one per clip. It wasn't the decoders, and it didn't work. The real cause: Grok Build Desktop served every file whole, ignoring the "send me this part of it" requests a video player makes as it plays. Playback would start, run about a second, and die. The app answers those requests properly now. Measured against the clips that failed: 4 failures in 45 attempts before, none in 45 after. *This is Desktop only — in VS Code the editor serves the file itself, and that path is not ours to fix.*
- **A video shows its first frame again, instead of an empty box that jumps.** The preview 3.2.9 traded away comes back now the byte-range problem is actually fixed, and the clip is the right shape before you press play rather than snapping to it afterwards.
- **The chat scrollbar sits against the edge of the pane.** At a small chat font on a wide window it floated well inland — the further in, the smaller the font. The text column is still a comfortable reading width; it just no longer drags the scrollbar with it. Desktop only.
- **Clicking a conversation moves the file panel to its project.** Clicking a *project* always did, and so did starting a new conversation, which is what made it look arbitrary. Desktop only.
- **Links to a plan open the plan.** Plans are written outside your project, so clicking one did nothing at all — no window, no error.

### Changed

- **A generated image or video now offers "Show in folder" in Grok Build Desktop.** Opening the file gave you nothing you couldn't already see: clips play in the chat, and pictures enlarge in place. Finding the file is the useful thing. In VS Code the button still opens an editor tab, which is what an editor is for.
- **The composer drops the words beside its two icons when it is narrow.** "Agent mode" and the token count give way to the icon and the ring; the tooltips carry what the labels stopped saying, including which mode is active.
- **Recent lists ten conversations, not twenty**, and the file panel's title and tabs line up with the rows beneath them.

## 3.2.9 — 2026-08-08

### Fixed

- **Links to generated images open.** When Grok makes a picture it usually links to it in its reply as well, and it writes that link relative to the conversation rather than to your project — so clicking it went looking in your repository for a file that was never there. Grok Build Desktop answered *"File not found … It is not under the open project"*; VS Code simply opened nothing. Those links now find the picture that was actually generated. The image in the transcript was always right; it was only the link beneath it that missed.
- **The open-file button on a generated image works in Grok Build Desktop.** Generated pictures live in Grok's own conversation folder, which sits outside your project, so the button was refused every time it was pressed. It is now allowed for that one kind of file — a picture or video Grok generated for one of this project's conversations — and for nothing else. Everything the app opens on your behalf is still held to the same containment checks as before.
- **Generated videos play after the first few.** Every video in a conversation reserved a decoder the moment it appeared, whether or not anyone watched it, and enough of them in one chat exhausted the browser engine's pool — after which pressing play on some clips did nothing, and which clips varied. A video now reserves nothing until you press play. The trade is that a clip shows an empty frame rather than a preview until it starts.
- **A clearer answer when video generation is blocked by your account settings.** xAI refuses video generation on accounts with zero data retention, and says so by naming an API field you cannot supply. Grok Build now adds where the setting actually lives: the Grok CLI's `/settings` → Privacy → Coding data, retention, and training.

### Changed

- **Clicking a generated image enlarges it where there is no editor to open it in.** In Grok Build Desktop and in the browser client the picture now opens full-size in place. Previously the browser left it inert, and Desktop handed the file to whichever program your system uses for images — leaving the app to show you something already on screen. In VS Code the click still opens an editor tab, which is what an editor is for.

## 3.2.8 — 2026-08-08

### Fixed

- **The chat opens in Cursor.** Cursor reserves the secondary side bar for its own agent UI and refuses to place an extension there, so the panel Grok Build asks for was never created — the view was dropped into Explorer and every way of opening it answered "command not found". It now opens the view wherever the editor actually put it.
- **A fresh install lands somewhere you can see it.** On the very first run — and only then — a chat the editor has stashed somewhere unusable is moved into its own view. It has to happen without you opening anything, because someone whose chat is buried in an Explorer section has no way to open it. After that first run the placement is yours and nothing touches it again: there is no way for an extension to ask where its own view sits, so we cannot tell someone who deliberately moved it from someone who never did, and guessing would mean dragging your layout back after every update.

### Changed

- **Move view now appears only where the editor needs it**, as a single **Move view…** that opens the editor's own destination picker; **Grok: Move Chat View** does the same from the command palette. The three fixed destinations are gone. In an editor with a secondary side bar they duplicated a **Move To** it already offers, and in one without, all three led to the same place — because a container is not a location, and an editor is free to draw our containers wherever it likes. Its own picker moves by location, which is how it reaches docks we cannot name.
- **Move view is hidden in the browser client.** Where the chat sits is a property of the machine running the extension, so those entries could never do anything from a phone.

## 3.2.7 — 2026-08-08

### Changed

- **Grok Build Desktop for macOS is signed and notarised by Apple.** It opens on first double-click — no *unidentified developer* warning, no trip through Privacy & Security, and no *"damaged and can't be opened"* on Apple silicon. Installers on this release are the first signed ones.

### Fixed

- **Voice finds ffmpeg where it is actually installed.** The desktop app only searched the `PATH` it inherits, which on macOS leaves out Homebrew's directory — so `brew install ffmpeg` looked like it had done nothing, and voice kept reporting ffmpeg missing until you pointed a setting at the binary by hand. It now checks the standard install locations too.
- **A useful answer when ffmpeg is missing.** The error offered only *Open Settings*, which cannot help when the program isn't installed at all — it sent you to a text field to name a file you don't have. It now shows the install command, and on macOS offers to open a terminal with it typed ready to run. Pointing the setting at a folder instead of the program is also named as such, rather than failing as a permissions error.

## 3.2.6 — 2026-08-08

### Fixed

- **The extension loads again.** 3.2.0 through 3.2.5 failed to start: a module the sidebar needs at runtime was left out of the published package, so activation threw before a single command was registered — every `Grok:` command answered "command not found" and the sidebar never appeared. Update from any 3.2.x; the downgrade to 3.1.0 is no longer needed. Grok Build Desktop was never affected. Found and diagnosed in #101.
- **Packaging refuses to build a package that cannot load.** Every `require` in the packed code is now resolved against the files actually being shipped, so a missing module fails the build instead of reaching a marketplace.

## 3.2.5 — 2026-08-07

### Changed

- **"Update available" opens a page that just gives you the download.** It used to open the GitHub release, which lists ten files — installers for three platforms, their checksums, and the VS Code extension — with nothing saying which one is yours. Now it detects your platform, offers one button, and shows how to get past the first-launch warning.

## 3.2.4 — 2026-08-07

### Added

- **Hide a project from the desktop rail** — in a project's `⋯` menu. It leaves the list; nothing leaves your disk, and **+** adds it back.

### Changed

- **Projects are listed by name**, in the rail and the repository picker. They used to reorder by recent activity, so starting a conversation moved the project you were in to the top and shifted everything under your cursor.

### Fixed

- **A new conversation appears in the rail straight away.** The project moved to the top but gained no row, and only closing and reopening it made the conversation show up.
- **New session is never disabled.** While the app was switching projects, every **+** in the rail greyed out at once — and on a switch that opens no conversation it stayed that way.
- **"+" on another project starts the conversation there**, rather than switching and leaving you on whatever was already open.

## 3.2.3 — 2026-08-07

### Fixed

- **Grok Build Desktop opens on macOS.** Earlier builds were refused outright — *"Grok Build Desktop is damaged and can't be opened"* — because the app carried no signature at all, which Apple silicon will not load. It is now ad-hoc signed, so macOS asks whether to open it (*right-click → Open*, or *Privacy & Security → Open Anyway*) instead of telling you to bin it. Still not notarised; a certificate is on the way. If you already downloaded an earlier build, `xattr -dr com.apple.quarantine "/Applications/Grok Build Desktop.app"` recovers it.

## 3.2.2 — 2026-08-07

### Fixed

- **The Marketplace and Open VSX listing shows its screenshot again.** A screenshot removed in 3.2.1 was still referenced by the store page, which renders from its own copy of the README, so the listing showed alt text where the picture should be.

## 3.2.1 — 2026-08-07

### Fixed

- **The projects rail lists other projects' conversations from a phone again.** It said *"Update Grok Build to preview"* against a host that was fully up to date and had already answered — the reply was dropped on the way out because it described a project other than the one that browser tab was working in, which is exactly what the rail asks about.
- **Grok Build Desktop wears its own icon on Windows.** The Start menu, the taskbar and Task Manager showed Electron's default: the packaging step that stamps the icon and version details onto the app had been switched off. The installer wizard carries the mark now too.

## 3.2.0 — 2026-08-07

### Added

- **Grok Build Desktop (Community) — a standalone app for Windows and macOS.** The same coding agent, without an editor or a terminal in front of it: open a folder and start. Projects on the left, the conversation in the middle, your files on the right. The builds are **not code-signed yet** — Windows SmartScreen and macOS Gatekeeper will warn you the first time. [Download](https://afkpilot.com/desktop).
- **The desktop file panel edits text files, in tabs.** Several files open at once, each with its own unsaved-changes dot. Markdown opens as a preview with a source toggle, `Ctrl`/`Cmd+S` saves, **Cancel changes** reverts, and closing a tab with unsaved edits asks first. If the agent changed the file underneath you, the save is refused and you choose: reload its version, or keep yours. Silently winning that race in either direction is how people lose work.
- **The app tells you when a new version exists.** It checks on start and every twelve hours, and shows how to update. It does not install anything behind your back — and it cannot on macOS anyway, since an unsigned app can't be replaced automatically.
- **Add project folders from the rail.** A `+` on the PROJECTS heading, and the empty rail offers it too.
- **A project that turns off permission prompts now asks you first.** A repository can ship a `.grok/config.toml` setting `permission_mode = "always-approve"`, and it overrides your own setting — so cloning someone's code was enough to remove every prompt between the agent and your machine. Opening such a project now says so and waits for you. Your own global setting is unaffected and stays silent.

### Changed

- **"Continue in a new chat" moved to the conversation's `⋯` menu**, beside Rename and Delete — the things you do *to* a conversation. The composer's settings keep model and effort, which is what they are for. Worktree apply and remove moved with it.
- **The file tree and the projects rail can be resized** by dragging their edge, on desktop and in the browser.

### Fixed

- **File icons are visible in dark themes.** Around thirty file types drew almost black on a dark background, so `.dockerignore` and friends were nearly invisible.
- **Markdown files render properly in the desktop panel** — lists, tables and the rest, using the same renderer the conversation uses, rather than a reduced one that handled only links and headings.
- **The settings button under the composer opens settings on the first click** when the gear menu is already open, instead of only focusing the composer.
- **A phone's project drawer is full width again.** It had collapsed to about 150px in AFK Pilot.
- **Closing a project folder asks first when something is still running.** It ends every conversation in that folder and stops the agent, which discarded a turn in progress with no warning.
- **`--config-json` applies to one run.** It was merged into your real configuration and left there, so a throwaway setting passed once kept applying on every later launch, with nothing on screen explaining why.
- **Files in one project can no longer be opened from a conversation in another.** Having both projects open was treated as permission to reach either from either.
- **Markdown with Windows line endings renders properly.** Headings kept their `#` and bullets kept their `-`, while tables and links worked — so it looked like the renderer was mostly fine when the document's structure was actually gone. Affected chat messages too, not just the file panel.
- **A file saved after you switch projects goes to the file you opened**, not to a same-named file in the project you switched to.
- **Selecting a project no longer opens a conversation in it.** It shows you what is there; you choose what to open.
- **The `⋯` menus close when you click them again.**

## 3.1.0 — 2026-08-06

### Added

- **The panel says which conversation you are in.** The name sits at the top, the same one the history list shows, with the full text in a tooltip when it is too long to fit. Renaming happens there too: hover it and a pencil appears, or tap the name on a phone. Enter or clicking away saves, Escape cancels — no trip through the history list or the `⋯` menu.

### Changed

- **Conversation names, pinned and archived projects now live in `~/.grok/client-state/`** instead of inside VS Code. Nothing changes for you — your existing names, pins and archives move across on first launch and keep working — but they are now readable files rather than editor-private storage, so they can follow you to other Grok clients on the same machine. One visible consequence if you use **multiple VS Code profiles**: those profiles previously kept separate names and pins, and now share one set.

### Fixed

- **A question from Grok always offers a free-text answer** ([#85](https://github.com/phuryn/grok-build-vscode/issues/85)). "Other" only appeared when Grok itself supplied that choice, which it usually doesn't — so there was no way to answer anything the listed options didn't cover.
- **A long command no longer swallows the chat** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71), [#92](https://github.com/phuryn/grok-build-vscode/issues/92)). The six-line limit counted line breaks rather than the lines you actually see, so a few very long lines filled the bubble regardless — and the permission card showed the whole command with no limit at all. Both are bounded by what is drawn now, with **View all** for the rest, and nothing gained a scrollbar of its own.
- **"View all" opens a command in its own language** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71)). A Python command was always opened as a shell script; VS Code detects it now.
- **"Scroll to bottom" stops reappearing while you are already at the bottom** ([#92](https://github.com/phuryn/grok-build-vscode/issues/92)). Tool details growing above the view made the browser adjust the scroll position itself, which read as though you had scrolled away — the more the UI is scaled up, the more often it happened.
- **An unsent draft no longer gains a copy of itself** every time you leave a conversation and come back. Pulling a message back to the composer with **Edit** was recorded as part of the conversation, so re-opening it did the same thing again — and again.
- **The project you are working in can be folded** in AFK Pilot's project rail. It was held open so a fold could never hide where you are; now it re-opens only when a conversation actually moves into it, so folding the one you are in sticks.
- **Rewind no longer states a file count it can't stand behind.** The CLI can report a file it created but left on disk, so the message says what was rolled back and warns that anything created after that point may remain.
- **The panel wastes less width in VS Code.** The gutter that suits a browser tab is a visible slice of a narrow sidebar, so the desk gets its own — and the conversation's name lines up with the messages under it.
- **"Scroll to bottom" stops going see-through when you hover it.** It borrowed a colour themes intend as a tint over a toolbar, not as a background of its own, so on many themes the conversation showed through the button.
- **`Expand tool details` is documented as it behaves.** It has opened tool groups since 1.5.10; the README and the setting description still described the older behaviour.

## 3.0.1 — 2026-08-05

### Fixed

- **History filled up with "Untitled" conversations that would not open.** Sessions you never typed into were being left on disk — one for every window you opened on a project and closed again without asking anything. Nothing removed them, and some the CLI cannot load at all, so clicking one appeared to do nothing. They are cleaned up now, at startup and whenever you start or open a conversation. Anything you renamed, pinned, or actually used is left alone. ([#97](https://github.com/phuryn/grok-build-vscode/issues/97))
- **A conversation you have not renamed now shows the title Grok gave it** — the same one `grok sessions list` shows — instead of the first 50 characters of whatever you happened to type first. Your own renames still win, and names you have already given are untouched. ([#96](https://github.com/phuryn/grok-build-vscode/issues/96))

## 3.0.0 — 2026-08-05

### Added

- **A projects rail in AFK Pilot.** Every project with Grok history down the left, each showing its newest conversations, with your pinned conversations lifted above them across all projects and a search that filters both. You can start a new session in any project without switching to it first, and rename, delete or clear history from the row itself. On a phone it is a drawer behind the handle in the header.
- **Archived projects.** Put a project away from its `⋯` menu, and anything untouched for 30 days goes there on its own — into a folded section that stays out of your way. Nothing is lost: an archived project still works, and starting or continuing a conversation in one brings it back. The three most recent projects are never archived automatically, so the list can't empty itself out.
- **You can delete the conversation you have open**, in VS Code and in AFK Pilot. It closes and a new one starts in the same project.

### Changed

- **AFK Pilot's toolbar moved into the conversation.** The header names the conversation and its project, with Session history and New session beside it; the project controls live in the rail instead. Projects are ordered by their newest conversation rather than by when their folder was last written to, so clearing a project's history no longer moves it to the top.

### Fixed

- **A conversation could be wedged shut by a Stop that never landed.** If the CLI ignored a stop request, the turn never ended, and from then on every message you sent turned into a queued message that could never be sent — only reloading the window cured it. A stop that goes unanswered for ten seconds now restarts the CLI, keeping the conversation, rather than leaving it stuck.
- **A message sent while Grok was working appeared twice**, once as your bubble and once as the queued block.
- **Renaming, deleting and clearing history now work in a project you have not switched to**, instead of being refused — and clearing another project's history shows the result there rather than writing a line into whatever conversation you happen to be reading.

---

## 2.3.1 — 2026-08-02

### Changed

- **Dictation inserts where your cursor is** instead of always appending to the end, and replaces the text you had selected — so you can pause, correct a sentence in the middle, and carry on in place. Authored by [@tarcisiomiranda](https://github.com/tarcisiomiranda) in [#72](https://github.com/phuryn/grok-build-vscode/pull/72), co-authored here; it was ported onto the current voice transport rather than merged, because the branch predated the shared-PCM rewrite.
- **Clicking Send or Queue now turns the microphone off** and sends exactly the text you can see. A transcript still in flight can no longer refill the composer you just cleared. Saying **"grok send"** still submits hands-free and keeps listening — that flow is unchanged on purpose.

### Fixed

- **Dictation could wipe a draft you had already typed.** The composer position was only remembered when the extension believed voice was configured, but recording is the host's call — so when the two disagreed, the first words transcribed replaced everything in the box.

---

## 2.3.0 — 2026-08-01

### Added

- **You can see what you attached** ([#88](https://github.com/phuryn/grok-build-vscode/issues/88)). Images preview as thumbnails in the composer and in the conversation itself, in VS Code and in AFK Pilot, live and after a restore. Click or tap one to open it full size — on a phone that version is fetched on demand, so it arrives a moment after the preview instead of being carried around with every conversation. Photos work, not just screenshots: JPEG is decoded and downscaled on your own machine.
- **What a conversation cost.** A running total per conversation, taken from what the CLI reports and shown only when the whole conversation can be accounted for — a partial figure is worse than none.
- **AFK Pilot can read a shorter, speech-friendly version of each reply** ([#94](https://github.com/phuryn/grok-build-vscode/issues/94)), matching the switch VS Code already had. Each browser keeps its own preference.

### Changed

- **"Summarize before speaking" is now "Read simplified summaries", and defaults on.** The setting key is unchanged. If the summary fails or never arrives, the original reply is spoken rather than nothing.
- **Switching repository lands somewhere predictable** — that repository's newest conversation, or a new one if it has none — and says "Loading conversation" while it does, with the switcher held until it finishes.

### Fixed

- **Opening an older conversation from history no longer re-types itself** ([#93](https://github.com/phuryn/grok-build-vscode/issues/93)). It arrives in one update, as a reconnect already did.
- **The scrollbar reaches the bottom with "Expand tool detail" on** ([#92](https://github.com/phuryn/grok-build-vscode/issues/92)), and a clipped command can be revealed by tapping on a touch screen.
- **A phone no longer bounces between two repositories.** Reconnecting — which happens every time a phone tab goes to the background — re-asserted a repository that disagreed with the conversation it then restored, so the view flipped back and forth.
- **An attachment can no longer arrive in the wrong conversation.** If a phone reconnected while an image was still being written to disk, that image could land in whichever conversation VS Code happened to be showing.
- **Reading replies aloud no longer stops after switching conversation** on a phone.

---

## 2.2.0 — 2026-07-31

### Changed

- **Plan mode now uses the CLI's own approve/reject, instead of a workaround.** Older Grok Build CLIs treated *any* answer to a plan card as approval, so the extension shipped a hidden instruction message teaching the model to read your real verdict from a follow-up, and cancelled the planning turn to re-drive the work itself. The CLI fixed that, so all of it is gone. **Approve & implement** now continues straight into the work in the same turn rather than starting a second one, and **Keep planning** leaves Grok planning — sometimes it revises immediately, sometimes it waits for you to say what to change. A comment you attach to a verdict still reaches Grok *before* it starts implementing.
- **Plan mode needs Grok Build CLI 0.2.117 or newer.** Updating the extension updates the CLI on your next session. If it can't be updated — or its version can't be read — Plan is shown disabled with the reason, while Agent and Auto-accept carry on working. That's deliberate: the verdict handling above isn't safe on an older CLI.

### Fixed

- **A conversation opened on your phone no longer re-types itself.** Mobile browsers discard a backgrounded tab, so coming back to AFK Pilot rebuilt the conversation one message at a time. It now arrives in a single update, showing your recent exchanges. Opening an *older* session from the history list still streams — that one is next.
- **Grok Build CLI installs that resolve to a `grok.cmd` shim** (common on Windows) failed the version read, which in turn disabled Plan mode.
- **Conversations recorded by earlier versions still restore cleanly.** They contain the old hidden instruction message; it stays hidden, and plan cards stay where they belong.

---

## 2.1.1 — 2026-07-31

### Added

- **Custom voice keyterms** ([#73](https://github.com/phuryn/grok-build-vscode/issues/73)). `grok.voiceKeyterms` biases dictation toward your own vocabulary — cmdlets, hooks, internal package names — with User and Workspace scope. `grok.voiceLanguage` additionally formats spoken numbers, currencies and units.

### Fixed

- **Plan mode no longer refuses harmless exploration** ([#89](https://github.com/phuryn/grok-build-vscode/issues/89), [#91](https://github.com/phuryn/grok-build-vscode/issues/91)). Inspection commands — `file`, `ls`, `sips -g`, `git log … 2>$null`, read-only PowerShell conditionals — run while planning again, and answering a question card no longer reports "approve the plan first".
- **Security: plan mode could be bypassed, letting an agent change your workspace before you approved a plan.** Three routes: a parenthesised subexpression behind an allowlisted command (`echo (Set-Content …)`), agent-supplied environment overrides (`NODE_OPTIONS` on the allowlisted `node --version`), and a plan-file exemption that let any mutating command ride along with a plan write. Affects earlier releases — update when convenient.
- **Resumed conversations showed the time you opened them** ([#87](https://github.com/phuryn/grok-build-vscode/issues/87)) rather than when the messages were written.
- **A device revoked from the web left VS Code claiming it was still linked**, with no route out of the state. It now unlinks itself and offers to link again.
- **A prompt queued from a phone could be lost** when the send that consumed it failed — it is now kept and retried once the problem is cleared.

### Changed

- The device commands are now **AFK Pilot: Link this device** and **AFK Pilot: Unlink this device**, matching the product name.
- "Summarize before speaking" follows "Read replies aloud": switched off and disabled while replies aren't being spoken, so it can't silently bill an API call later.

---

## 2.1.0 — 2026-07-30

### Added

- **Voice input from AFK Pilot.** Dictate on your phone: the audio streams to your machine, which transcribes it with xAI speech-to-text and puts the text in the composer. End with "grok send" to submit hands-free.
- **Every browser tab is its own conversation, with its own repository.** Open several tabs against one linked machine, pick a different repo in each, and they stay independent across reloads, reconnects and phone tab-discards.
- **The same conversation can be open in VS Code and the browser at once**, live in both — start at the desk, carry on from the phone, switch back whenever. A tab that arrives with nothing of its own now continues what the desk is showing, instead of opening an empty session.
- **"Continue remotely" is one tap** from the chat toolbar on a linked machine, and *Add document*/*Add photo* now sit behind a phone-friendly picker.
- **"Other" answers take free text** ([#85](https://github.com/phuryn/grok-build-vscode/issues/85)), macOS gets Emacs-style `Ctrl+F`/`Ctrl+P` composer navigation ([#84](https://github.com/phuryn/grok-build-vscode/issues/84)), and a still-processing sound cue plus an opt-in "summarize before speaking" join the audio settings ([#78](https://github.com/phuryn/grok-build-vscode/issues/78)).

### Fixed

- **Security: a linked remote device could delete directories outside the session store.** A crafted session id (e.g. `../..`) passed through `deleteSession` without validation, so a remote client could recursively remove paths outside `~/.grok`. Session ids are now validated at the wire boundary *and* again before any filesystem operation. Affects earlier releases with Remote Control linked — update when convenient.
- **Expanding a Thinking block could land your click on "No, and tell Grok…"** ([#76](https://github.com/phuryn/grok-build-vscode/issues/76)) — the permission card's scroll no longer moves the buttons out from under the pointer.
- **Messages sent from a phone appear immediately** instead of vanishing until the round trip completes, which on a weak connection made a send look lost.
- **The gear no longer offers "Sign in (link this device)" before it knows the answer** — an already-linked machine could be invited to re-link itself during startup.

---

## 2.0.10 — 2026-07-27

### Added

- **Read completed replies aloud.** A new toggle (gear → Config & debug) speaks each finished reply via speech synthesis, skipping code blocks — separate on/off state for VS Code and for AFK Pilot.

### Fixed

- **AFK Pilot's text size no longer follows VS Code's own chat zoom.** The two are meant to be fully independent; changing the desktop zoom while a device was linked could silently affect AFK Pilot's own scale too.
- **Picking a different repository from AFK Pilot could get stuck showing the old one.** A live, not-yet-saved-to-disk session from whichever repository you'd been in could leak into the newly selected repository's history and be mistaken for "already open," so the screen sometimes never switched over.

---

## 2.0.9 — 2026-07-27

### Added

- **Attach documents from AFK Pilot.** The remote **+** picker gains *Add document* next to *Add photo* — `.md`, `.txt`, `.pdf`, `.csv`, `.xlsx`, and `.docx` (up to 20 MiB) attach as an explicit path chip, exactly like a local drag-and-drop, so Grok reads the file with its own tools. Linked devices on an older release simply don't see the option.

### Fixed

- **Security: a linked remote device could reference files outside your workspace via an `@`-mention.** Selecting a mention result resolved the picked path by joining it to the workspace root with no containment check, so a crafted path from a remote client could point outside the workspace and have its contents attached to the next message. Remote mentions are now resolved exclusively against the host's own indexed file catalog — the same list the autocomplete popup offered — never against an arbitrary path. Present since `@`-mention shipped (v1.7.5); if you use Remote Control (AFK Pilot), update when convenient.

---

## 2.0.8 — 2026-07-26

### Fixed

- **Long command output and diffs no longer scroll inside a small box** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71)). A command's captured output and an edit's inline diff now show a short preview that grows **inline** — *View all* / *Show more* — so the page scrolls normally instead of trapping you in a nested scrollbar. On a linked device, where there's no editor to open the full text, both expand in place.
- **Permission-card keyboard polish** ([#68](https://github.com/phuryn/grok-build-vscode/issues/68)): the option with keyboard focus now shows a clear outline, and answering a card returns focus to the composer.

---

## 2.0.7 — 2026-07-26

### Fixed

- **Switching repository from your phone no longer changes what VS Code shows.** The choice is shared across your remote devices on purpose — that's the point of it — but VS Code has no repository picker, so it now stays on the workspace you have open: its history list keeps showing that project's sessions, and *New session* starts there. Previously a phone switching projects silently re-scoped the list and pointed *New session* at a different checkout.

---

## 2.0.6 — 2026-07-26

### Fixed

- **Worktree sessions are back in their repository's history** ([2.0.5](#205--2026-07-26) regression). They were matched to their parent by comparing the repository's *git root* against the folder open in VS Code — the same path in the usual case, but not when you open a *subdirectory* of a repository, and then those sessions vanished from the list. The parent repository now lists every worktree session again, as it did before 2.0.5.
- **A worktree opened directly as your workspace is now a repository in its own right.** It was excluded from the picker as "not a repository you choose between", which left *Clear all history* pointing at an entry that wasn't in the list — so it silently did nothing after you confirmed it.

---

## 2.0.5 — 2026-07-26

### Added

- **Switch repositories from a linked AFK Pilot device.** The chat header on the web client gains a repo chip listing every project Grok has sessions for — pick one to browse its history, pin the ones you reach for, then *New session* to start Grok there. A project's worktrees come with it instead of appearing as separate entries. The chip is remote-only: in VS Code the window already *is* the repository.

### Fixed

- **Re-linking a machine no longer costs you a device slot.** Linking was tracked per link rather than per machine, so re-pairing after a reinstall or a failed connection added a *second* device and could push you past your device limit — for hardware you already had. A re-link now supersedes that machine's previous entry.

---

## 2.0.4 — 2026-07-26

### Fixed

- **The native diff editor shows the whole file**, opened on the first changed line, instead of a context-free preview of only the replaced lines ([#66](https://github.com/phuryn/grok-build-vscode/issues/66)). Grok never sends the file itself, so both sides are reconstructed from the copy on disk plus its per-site line metadata — anchored per site, so a repeated token can't become a phantom change. An unreadable, oversized, or since-modified file falls back to the previous region-only diff. Thanks to [@padixa](https://github.com/padixa) for the report and the follow-up that scoped it.

---

## 2.0.3 — 2026-07-26

### Added

- **Edit a sent message** — hover your latest message → *Edit*. It removes that turn (restoring any files it changed) and puts the text back in the composer so you can fix it and send again. The exact complement of Rewind, which is offered on every earlier message. ([#56](https://github.com/phuryn/grok-build-vscode/issues/56))
- **Rewind now returns the message's text to the composer** too — it always deleted that message, so it no longer discards what you wrote.
- **Keyboard on permission cards** ([#68](https://github.com/phuryn/grok-build-vscode/issues/68)): *Allow once* is ordered first and takes focus when the composer is idle, so Enter approves. Arrows move between options, Escape returns to the composer without answering, and typing any character jumps to the composer instead of pressing a button. A keystroke never selects *Allow always*.

### Fixed

- **Turning off the active-file context chip is now remembered** ([#67](https://github.com/phuryn/grok-build-vscode/issues/67)). The chip is rebuilt whenever you switch files, which silently re-enabled it — so dismissing it was futile. The eye-off choice now persists across file switches and restarts.
- **Rewind discarded one turn too many.** Grok's rewind removes the message it targets, not just what follows; the confirmation said the opposite. Both the wording and the targeting are corrected, so Rewind and Edit now remove exactly the turns they name.
- **Rewind left stale plan and permission cards behind.** Those cards are stored by the extension, not by Grok, so rewinding the conversation stranded the ones belonging to deleted turns — they reappeared at the bottom of the restored chat. Both actions now drop them.
- **Plan snapshot files no longer pile up.** Reopening a session re-wrote a fresh copy of every saved plan, so one session accumulated 13 identical files. Snapshots are now named by their content and reused, and a session's snapshots are deleted with the session.
- **Rewinding now refunds the discarded turns' tokens.** The session billing total counted turns that no longer exist. Usage is recorded per turn, so the total is recomputed from what survives. (Sessions from before this change keep their existing total — there's nothing stored to subtract.)
- **Rewind and Edit no longer reload the conversation.** They deleted the whole chat, showed the welcome screen and re-rendered every message; now only the removed turns disappear.
- **Confirmations for Rewind/Edit are now in-chat**, like every other destructive confirm — no native VS Code modal.
- **No confirmation dialog unless code will be reverted.** A conversation-only rewind or edit just happens — the message goes straight back to the composer. Turns that changed files on disk still ask, since that part cannot be undone.
- **Steered messages no longer break Rewind and Edit.** A message sent mid-turn isn't a separate prompt and has no restore point; counting it shifted every later message by one, so Rewind targeted the wrong turn (reverting the wrong files) and Edit failed. Steered messages are now excluded and offer neither action.

### Changed

- Gear → Remote Control: *Your AFK Pilot account* → *Your account*.

---

## 2.0.2 — 2026-07-25

### Fixed

- **Files missing from the composer's `@` autocomplete** in large workspaces ([#69](https://github.com/phuryn/grok-build-vscode/issues/69)). The file index was capped at 5000 entries, and past that cap VS Code returns an arbitrary subset — so real source files could be absent while less relevant ones still showed. Any file open as a tab is now always mentionable, and the new `grok.mentionIndexLimit` setting raises the cap for big repos. Thanks to [@datvm](https://github.com/datvm) for the diagnosis and the fix ([#70](https://github.com/phuryn/grok-build-vscode/pull/70)).

---

## 2.0.1 — 2026-07-25

### Added

- **Keep this machine awake while an [AFK Pilot](https://afkpilot.com) device is linked**, so a turn you started from your phone isn't cut off by idle sleep — `caffeinate` on macOS, `SetThreadExecutionState` on Windows, `systemd-inhibit` on Linux. Only system sleep is blocked (the display still sleeps), the lock is released the moment you sign out, and it never survives closing VS Code. Turn it off with `grok.remote.keepAwake`. A closed laptop lid still suspends on every OS.

---

## 2.0.0 — 2026-07-25

The extension pairs with **[AFK Pilot](https://afkpilot.com)** — a companion web client that brings your Grok sessions to your phone or any browser — and moves to a Fair Source license.

### Added

- **Remote control via [AFK Pilot](https://afkpilot.com)** — gear → *Remote Control* → **Sign in (link this device)** pairs this machine with the AFK Pilot web client: follow running turns, approve permissions, answer questions, and send or steer messages from a phone or any browser while away from your desk. The extension dials out to the service (no inbound port); **Sign out** unlinks the device here and revokes it on your account. The experimental `grok.remoteControl.relayUrl` setting is gone — pairing is one click now.
- **Touch-ready chat UI** — real tap targets on touch screens, always-visible actions on history rows / images / equations / diagrams (previously hover-only), roomier question and permission cards, and in-browser PNG download for generated images, math, and Mermaid diagrams. A resize (e.g. the mobile keyboard collapsing) no longer yanks the chat to the bottom.
- ` ```math ` / ` ```latex ` / ` ```tex ` code fences render as display equations, like ` ```mermaid ` already did for diagrams.

### Changed

- **License: MIT → FSL-1.1-MIT (Fair Source).** Free to use, modify, and redistribute for any purpose except a competing commercial product or service; each release automatically becomes plain **MIT two years after publication**. Versions up to and including 1.8.1 were published under MIT and remain MIT. ([LICENSE](LICENSE))
- **Destructive confirmations are now in-chat dialogs** (delete session, clear all history, apply/remove worktree, remote sign-out) instead of native VS Code modals, so they behave identically in the sidebar and the AFK Pilot browser client.
- Card titles render in the UI font instead of the editor's monospace.

---

Older releases (before 2.0.0): see [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).
