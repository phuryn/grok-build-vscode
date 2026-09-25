# Subscription usage in the context popover (#159)

The account capacity section is separate from context occupancy and appears in
both app purposes. Session total, Last turn, and the structured context breakdown
retain their existing coding-purpose gate. Missing measurements show “No
subscription usage reported yet.”, without a meter.

## Provider contract

Based on the owner's probes of 2026-09-13; this implementation does not run new
provider probes or model turns to obtain capacity.

- Grok: `_x.ai/billing`, with `{}` parameters. Only
  `config.creditUsagePercent` and `config.currentPeriod.{type,start,end}` are
  consumed. The measured period is weekly, and that is the only label we claim:
  `creditUsagePercent` sits on `config` rather than on the period, so an
  unrecognized period type keeps the number under the neutral label "Current
  period" instead of blanking the panel for a plan we have never seen. A missing
  or non-string type is still rejected. The optional-method handling latches
  `-32601` for the lifetime of the process and logs the missing capability once.
- Claude: `usage_update._meta["_claude/rateLimit"]`, on the update itself, passes
  through `normalizeClaudeUpdate`. A parent-session event replaces the last
  named window; ordinary usage updates without this metadata leave it alone.
  `utilization` is a fraction (0..1); `resetsAt` is Unix seconds. The fraction
  is **measured**, not inferred from the typing, because the SDK's other
  `utilization` — `SDKControlGetUsageResponse.rate_limits`, behind `/usage` —
  is documented "0-100" and rendered as a percent by the adapter. Same word,
  opposite scale. In the shipped Claude binary `rate_limit_info` is built from
  the `anthropic-ratelimit-unified-*` response headers and the CLI's own key
  for those objects is `Math.round(utilization * 100)`. Labels distinguish
  five-hour, weekly, Opus, Sonnet, included overage, and overage windows. The SDK
  may omit reset time and never supplies period start here: these remain absent,
  with an explicit “Reset time not reported.” when necessary. A new Claude
  process starts empty, even if another process reported a window previously.
- Muse: MSP `usage/read` after each completed turn, and the `usage/changed`
  notification, which carries no session id. The adapter forwards the raw
  payload as `_muse/subscription_usage` `{sessionId, usage}` only once a
  session exists. A failed read is logged and does not fail the turn. An
  omitted `usage` member (nothing observed yet) sends nothing, so it does not
  clear a window already on screen. `museSubscriptionWindows` keeps the
  rolling window and the weekly block. `usedPercent` is already 0..100 and is
  clamped by `percentage()`. `resetsAtMs` is epoch milliseconds — Claude and
  Codex reset fields are Unix seconds. The rolling window's label is
  `codexWindowLabel(windowDurationMins)` (300 is "5-hour"); the weekly block
  is "Weekly". A malformed window is dropped. `tier` is not shown. The
  popover does not trigger a read. A new Muse process starts empty.
- Codex supplies no ACP subscription surface. There is no fallback to `/status`
  or `/usage`, nor any Codex-specific acquisition path.

## Cache and delivery

`src/subscription-usage.ts` normalizes fresh objects containing only
`usedPercent`, `label`, `periodType`, optional `periodStart`/`periodEnd`, and
`observedAt`. Never forward `config`, subscription tier, balances, on-demand
amounts, unified-billing flags, or billing-period dates. In particular,
`billingPeriodEnd` is not the reset boundary.

Grok reads share a memory-only cache under an opaque digest of the credential
context: provider, effective auth home, relevant environment overrides, and auth
file contents. Claude observations stay process-local because OS keychain
identity is not portably readable. Muse's credential key is the constant
`muse:cli-owned` — the host does not read Muse's credential file — so its
observations are process-local too. A shared cache would show one login's
windows on the next process. Digests and credentials never cross the wire.
Sign-out or a credential failure invalidates bindings; subsequent snapshots and
events also check for file/environment changes and discard late responses.
Unreadable credential files cannot yield a reusable context.

An invalidated process is not rebound: the CLI can retain the old login. A fresh
session process binds the new context. This deliberately also clears observations
on credential-file token rotation; distinguishing rotation from an account switch
without a portable identity contract is left to the provider. An external switch
held only in Claude's OS keychain requires restarting that CLI session.

`refreshSubscriptionUsage` reads on a real popover open, and at session
startup, for Grok (the billing RPC) and Codex (the rollout file). Claude and
Muse are not read from the popover. Grok's minimum interval is 60 seconds, including
failed attempts, with in-flight coalescing. There are no refresh timers: auxiliary
ACP responses re-arm pending prompt idle timers, so polling would mask a hung
prompt. Existing `refreshContextDetails` traffic does not refresh subscription
usage. Incoming UI frames only redraw this section.

The dedicated `subscriptionUsage { windows: [...] }` message mirrors to an
authenticated phone under the session's project scope. It is transient and never
enters transcript buffers, persisted history, or exports. `sessionUiSnapshot`
and history snapshot delivery send the latest value (including an empty list),
so reconnects and focus changes cannot recover old billing snapshots.

## Verification

`subscription-usage.test.ts`, `subscription-usage.dom.test.ts`, and the ACP client
tests cover normalization, explicit remote field omissions, unsupported methods,
credential changes and late responses, cache coalescing without timers, the
Claude update/envelope distinction, Muse millisecond resets and per-process
caches, singular replacement, empty states, independent
context occupancy, both app purposes, and reconnect snapshots.
