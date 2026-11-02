# Sound when input is needed (#228)

`grok.inputNeededSound` is off by default, independent of `soundNotifications`
and `processingSound`. Settings → Notifications exposes it on IDE, desktop,
and remote clients. The host persists the IDE/desktop setting and rebroadcasts
configuration changes to chat, including changes made in the separate IDE
Settings webview. Like `setProcessingSound`, its setter is host-local in
`remote-policy.ts`; a remote switch changes that page's playback state, not the
host's global configuration. No telemetry field is added.

`observeInputNeededSound` in `media/chat.js` observes `sessionDot`: only a live
`working` → `needs-you` delta can chime. The host already maps permissions,
questions, and plan approvals to this status; several cards arriving during one
wait share a single status transition. Card messages never trigger audio.
Desk clients receive dots for this window's conversations. Remote clients
receive background dots for their selected repo, including its worktrees;
other repos are outside that existing broadcast's scope. No new host signal or
cross-repo subscription is introduced.

The observer keeps its own per-conversation baseline. Catalog dots establish
current state silently. `initialState`, replay start, `hostReachable`, and a
disconnected or changed `hostLink` clear earlier baselines. Dots inside replay
are ignored. An unknown first `needs-you` dot cannot chime, and pending cards
or `permissionOptions` restored after replay cannot either. A page that has not
observed working state waits for a later working → waiting transition.

Playback uses the same away condition as completion sounds:
`document.visibilityState === "hidden" || !document.hasFocus()`. Each page
synthesizes its own high-low-high sine chime (784, 659, 784 Hz, about half a
second) through `playNotificationTone`. `soundFeaturesOn()` includes this flag
so gesture unlock and suspend-when-silent apply with only this feature enabled.
The existing completion, error, and processing tone branches are unchanged.

Tests: `test/input-needed-sound.dom.test.ts`, `test/input-needed-sound.test.ts`,
`test/settings-surface.dom.test.ts`, `test/remote-policy.test.ts`, and
`test/protocol.test.ts`.
