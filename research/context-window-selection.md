# Native Grok context-window selection

The model picker opens context choices after the host confirms a Grok model, then returns to the existing reasoning-effort controls. The context popup exposes the same choices. New sessions retain the native CLI default; resumed sessions and model switches query the effective native state. `/context-window`, `/context-window 500k`, and `/context-window 500000` are host-routed controls that preserve composer drafts and attachments.

`AcpClient.contextWindowSelection` carries the session/model identity, generation, offered/default/confirmed sizes, availability, changing flag and stale state. Only positive safe integer sizes advertised in `_meta.contextWindows` are selectable, in native order; `_meta.totalContextTokens` is a single-size fallback. Offered sizes do not prove server allowance. Context usage stays in upstream's existing `contextUsage` flow; this feature introduces no context catalog or budget framework.

The verified native Windows CLI 1.0.46 path is `session/set_model` with `_meta.contextWindow` and the current reasoning effort, followed by `_x.ai/session/info` confirmation. This path requires a live verified Grok version >=1.0.46. If the CLI explicitly advertises `context-window` as an ACP command, the client uses that native command instead. An unsupported typed command never becomes ordinary model prose.

Controls are locked during startup, a turn, or a context change. The host and client validate offered size and session/model/generation identity. Native rejection or missing confirmation keeps the last confirmed view, marks it stale and reports an error; a successful native refresh clears the stale flag. Native auto-compaction owns shrinking behavior. Tagged old updates are ignored; untagged delayed events have only the identity supplied by the CLI.

Desktop IPC validates the complete choice. Remote choices require propose access and a bound session; outbound state follows the owning session's project scope. Reconnect snapshots restore the selection without opening the picker.

FireInWinter identified the native feature in [upstream issue #202](https://github.com/phuryn/grok-build-vscode/issues/202#issuecomment-5936310443). The implementation is selectively ported from fork commit `5b7e205`. Binary-free tests cover client, fake CLI, host routing, IPC and both UI controls. `npm run compile && node research/context-window-probe.cjs` is an optional manual native-CLI probe for default, enlargement, refresh, model carry-over, shrinking and resume; it is not part of CI.
