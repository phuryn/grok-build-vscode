# Measuring the quota work

Two tools, for two different questions.

## 1. `research/agy-quota-bench.cjs` — did the mechanism change?

```bash
node research/agy-quota-bench.cjs
```

Compiles the current `src/agy-acp-adapter.ts` **and** the one at `HEAD`
(override with `BENCH_BASELINE_REF`), then drives both in-process against
`test/fixtures/fake-agy.cjs` — a stand-in CLI that speaks the real NDJSON
stream-json protocol and appends every token it bills to a ledger with
`appendFileSync` as it generates. A process killed halfway leaves exactly what
it had charged for; a process nobody stopped keeps charging.

The adapter is reached through its own `spawnFn` injection point, so the stub is
spawned the way the real binary is. No network, no account, no quota.

Exact (read from the ledger or from a pure function):

| Scenario | What is measured |
|---|---|
| Stop pressed 150 ms into a 600 ms turn | tokens billed *after* the click |
| Reasoning effort left on "Default" | which `--effort` reaches the CLI |
| Model switched mid-turn | tokens billed but never delivered |
| Conversation reopened in a fresh adapter | whether `--conversation` carries the same id |
| 3000-line editor selection | characters in the built prompt |

Modelled, and labelled as such in the output: how much a reasoning level costs.
`EFFORT_MULTIPLIER` in the fixture puts `high` at 4× the thinking of no flag.
The *flag* is measured; its price is an assumption.

Exit code is non-zero if the current adapter fails an expectation, so it doubles
as a hand-run regression gate. It is deliberately not in `npm test`: it shells
out to `tsc` and spawns real processes. The same properties are locked down
cheaply in `test/agy-acp-adapter.test.ts`.

Measured 2026-09-05, current tree vs `8568efb`:

```
Stop: tokens billed after the click          6400  ->      0
Stop: how the turn was answered          end_turn  ->  cancelled
"Default" effort: flag sent                  high  ->  medium
"Default" effort: tokens per turn            2400  ->   2200   (see below: not a cost lever)
Model with no effort tier: flag sent         high  ->  (none)
Model with no effort tier: can start           no  ->    yes   (the CLI refuses the flag)
Model switch mid-turn: tokens discarded 1200-1600  ->      0   (chunk timing)
Reopened chat: context                       lost  ->   kept
3000-line selection: chars per message     102830  ->    166
```

## 2. `research/usage-report.cjs` — did a real session get cheaper?

```bash
node research/usage-report.cjs before.log after.log
```

Sums the per-turn lines the host now writes for every agent
(`[usage] <provider> turn in=… out=… reasoning=… cacheRead=… cacheWrite=… total=…`,
from `accumulateUsage`) plus the adapter's own `[agy] turn complete …`. Save the
Output panel ("Grok Build") to a file after a run.

This is the only way to see the provider-wide items — the summarize-restart
turns, effort inheritance, the auth resend — because they are turns, not flags.
Model output is not deterministic: run the same task more than once per build
before believing a small delta. The mechanical wins belong to the bench above.

## 3. `research/agy-live-probe.cjs` — and against the real CLI?

```bash
npm run compile && node research/agy-live-probe.cjs
```

Runs the compiled adapter against `~/.gemini/bin/agy.exe`. Spends real quota (a
handful of tiny turns), so it is manual and never part of `npm test`. It exists
because the stub can only confirm what we already believe about the wire.

Against 1.1.26 on 2026-09-05, 11/11 passed: a turn completes and reports usage,
a follow-up keeps its context, a reopened conversation resumes through
`--conversation` after the adapter restarts, and Stop both answers `cancelled`
and leaves no CLI process behind.

The effort contract in `modelRequiresEffort` was derived here, not guessed:
`--model gemini-3.8-flash` alone is refused ("requires --effort"), and
`--model gpt-oss-120b-medium --effort high` is refused ("conflicts"). The same
refusal applies to both Claude models, which is why they could never start at
all while the adapter sent the flag unconditionally.

## 4. `research/agy-live-ab.cjs` — and does it save tokens in practice?

```bash
npm run compile && node research/agy-live-ab.cjs 2
```

The same three-turn script through both adapters, against the real CLI. Measured
2026-09-05, two runs a side:

```
HEAD   73432 tokens (458 thinking)   --effort high
now    73336 tokens (377 thinking)   --effort medium
delta  0%
```

**On the like-for-like path this work saves nothing**, and that is worth stating
plainly. The reasoning level is a correctness matter, not a cost lever: 80
thinking tokens out of 73 000.

What actually drives the bill, from the same measurement — input per turn was
6 638, then 21 555, then 28 496, against 141/259/392 output+thinking. Roughly
15 000 tokens of system prompt and 57 tool schemas as a floor, and the whole
conversation re-billed every turn (`cache_read_tokens` was 0 throughout).

So the savings here are categorical rather than incremental: a turn that is no
longer run to completion after Stop (tens of thousands of tokens per click at
those sizes), a paid turn no longer discarded on a model switch, a selection no
longer added to the history that every later turn re-pays for, and three models
that could not start at all.
