# Host waiting and retained renderer intent

`GrokHostWait` is a shared component in `media/webview-helpers.js`, in the existing vendored helper bundle. `chat.js` and `file-panel.js` register operations at action boundaries. It mounts one body-level strip outside the transcript and overlays; its measured height reserves space below chat, Settings and overlay file panels. Confirmations retain the highest layer.

The adapter reads `window.afkpilotHostLink` at mount and on use. The shell replaces that snapshot and dispatches `{type: "hostLink", link}` on every change. No global means permanently available and no strip.

`hostLink` is deliberately not `hostReachable`. That one is a command: the renderer answers it by abandoning every in-flight file request and re-running `git status` for whatever is on screen, so a shell that fired it on each phase change would turn a flapping uplink into a storm of those. A page that sends `hostLink` therefore ignores `hostReachable` entirely; a page that predates it keeps the abandon-and-refresh path unchanged.

`link.connection` counts the shell's sockets, because that is the one fact the renderer cannot see and cannot infer. A machine quiet for twelve seconds keeps its socket and its outstanding requests; a reconnect is issued a new client id, and the host addresses a reply to the id that asked.

An operation owns its verb, target, completion evidence and explicit retry. A disconnected link shows “Waking your machine.” and the verb; a long waking phase shows elapsed time from `link.since`. A reachable link shows the operation still running, not a claim that the machine is still starting. Time alone establishes neither failure nor success. Confirmed results clear after three seconds. Failures name the operation and offer scoped retry.

## Reads

File tabs exist before the read resolves. A failed tab retains its path and retry control; reconnect can replace it. Closed/superseded reads abort the renderer consumer and ignore obsolete replies. Reconnect never reloads dirty or saving tabs. An untouched missing-file draft is not dirty and may be refreshed.

The five shell-held shapes are `listProjectDir`, `readProjectFile`, `readProviderConfig`, `gitStatus` and `gitFileDiff`. Linked reads have no flat timeout. An attempt issued during restore belongs to the shell until it flushes or explicitly refuses it. The renderer does not independently reissue that attempt. A live read lost with its socket, or an explicitly refused attempt during restore, is reissued after restore with a new request ID and its original provider/cwd/path. Correlation checks retain the target fence. A provider-config refusal may omit its path, but must still match the request ID and provider. After cancellation or a retry, an uncorrelated legacy answer cannot satisfy the newer attempt.

## Preferences and writes

`pendingPreferences` explicitly lists ordinary host preferences: app purpose, voice phrase/keyterms, telemetry, feedback buttons, repository colour/archive and routine pause. Unsent changes coalesce by field and target. An existing harmless `listSessions` request triggers connection activity while setters remain in renderer memory. Only a restored link releases those setters.

Fresh host observations of the corresponding field and value establish success: `appPurpose`/`initialState`, `voiceConfigured`, telemetry/feedback state, `repos`, or `routines`. The settings control continues to show the confirmed value with the requested change marked pending. A sent preference whose connection dropped is never automatically replayed: a different value on reconnect remains the host's value and offers explicit retry. Missing confirmation stays pending.

`setMode`, `setModel` and `setEffort` are not retained or automatically retried. Their handlers have contextual side effects. Chat delivery continues through the existing send/outbox/recovery paths; the strip finishes only on the matching host user-message echo. Saves retain their buffers and are never replayed after an unanswered write. A save attempted while the link is known unavailable is explicitly refused before sending bytes; the retry is the person's action. A linked write waits for its correlated outcome for as long as its own connection lasts. When that connection is replaced the answer can no longer arrive, so the write ends as a named failure that does not claim the bytes were not written -- neither replayed nor left saying "Saving…" until the tab is reloaded.

`test/host-wait.dom.test.ts` drives the actual renderer with shell snapshots, restore-time refusals, interrupted live reads, late replies, concurrent target changes and host observations. Existing remote-file tests cover the legacy `hostReachable` path. `hostLink` is declared alongside `hostReachable` in `src/protocol.ts` and both outbound tables in `src/remote-policy.ts` (`host-local`, `none`) -- `test/protocol.test.ts` asserts set-equality with `HOST_MESSAGE_TYPES` in both directions. No INBOUND wire type, no enum value and no desktop validator change is needed.
