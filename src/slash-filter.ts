import { supportsCompaction, type AcpProvider } from "./acp-backend";

export interface SlashCmd {
  name: string;
  description?: string;
  /**
   * ACP `AvailableCommand._meta`. Skills are advertised with `scope` + `path`
   * (grok shell `available_commands()`); builtins omit those keys.
   */
  _meta?: { path?: unknown; scope?: unknown; [k: string]: unknown };
  meta?: { path?: unknown; scope?: unknown; [k: string]: unknown };
}

/**
 * A skill on the `available_commands_update` wire: `_meta.scope` + `_meta.path`
 * both present as non-empty strings. Builtins have no such meta. Name shape
 * (`user:commit`, `frontend-design:frontend-design`) is only the collision/
 * plugin qualifier — a skill with no collision is advertised as a bare name
 * (`imagine`, `commit`), so a colon is not the distinguisher.
 *
 * Source: grok-build-CLI `slash_commands.rs` `available_commands` and pager
 * `AcpSlashCommand::from` (`meta.path` + `meta.scope`).
 */
export function isAdvertisedSkill(cmd: SlashCmd | null | undefined): boolean {
  if (!cmd || typeof cmd !== "object") return false;
  const meta = cmd._meta || cmd.meta;
  if (!meta || typeof meta !== "object") return false;
  const path = meta.path;
  const scope = meta.scope;
  return typeof path === "string" && path.length > 0 && typeof scope === "string" && scope.length > 0;
}

function isAsciiWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

export type SlashQuery = { query: string; atStart: boolean };

/**
 * Slash commands the extension hides from both the autocomplete list and the
 * dispatch gate. `/always-approve` (#31) only mutates grok's *global*
 * config.toml — a surprising, sticky side effect that then silences permission
 * cards in every grok session — and is a no-op over ACP anyway. Grok's
 * `/context` (#39) renders only in the CLI's own TUI: over ACP stdio it streams
 * nothing back, so selecting it silently does nothing (`/session-info` is the
 * working equivalent). Filtered at ingestion (see `filterAdvertisedCommands`).
 */
export const HIDDEN_SLASH_COMMANDS: ReadonlySet<string> = new Set(["always-approve", "context"]);

/**
 * Agents whose adapter answers a hidden command in the chat, so it stays.
 * Claude's adapter runs `/context` locally and sends its table back as reply text.
 */
const SHOWN_FOR: Readonly<Record<string, ReadonlySet<string>>> = { claude: new Set(["context"]) };

/** Drop hidden commands from an advertised `available_commands_update` list. */
export function filterAdvertisedCommands<T extends { name: string }>(commands: T[], provider?: string): T[] {
  const shown = (provider && SHOWN_FOR[provider]) || undefined;
  return commands.filter((c) => !HIDDEN_SLASH_COMMANDS.has(c.name) || shown?.has(c.name) === true);
}

/**
 * Given the current composer text and cursor position, return the slash-token
 * query (chars after `/` up to the caret) or `null` if no popover is active.
 *
 * A `/` token is at position 0 of the whole message, or preceded by ASCII
 * whitespace (the same boundary grok's `parse_skill_references` uses). File
 * paths like `foo/bar` are not tokens. `atStart` is true only when `/` is
 * byte 0 — commands dispatch only there; skills load anywhere.
 */
export function getSlashQuery(text: string, caret: number): SlashQuery | null {
  const before = text.slice(0, caret);
  const m = before.match(/\/(\S*)$/);
  if (!m) return null;
  const slashIndex = before.length - m[0].length;
  if (slashIndex > 0 && !isAsciiWhitespace(before.charAt(slashIndex - 1))) return null;
  return { query: m[1], atStart: slashIndex === 0 };
}

export function filterCommands(commands: SlashCmd[], query: string): SlashCmd[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  // Name prefix, then mid-name, then description-only. Name hits always beat
  // a description-only hit. Walk once so each tier keeps advertised order (#110).
  // KEEP IN STEP with media/webview-helpers.js filterCommands.
  const prefix: SlashCmd[] = [];
  const substring: SlashCmd[] = [];
  const description: SlashCmd[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) substring.push(c);
    else if ((c.description || "").toLowerCase().includes(q)) description.push(c);
  }
  return prefix.concat(substring, description);
}

/**
 * The partial `/q` token the popover is completing, or null.
 *
 * Matches a `/token` at position 0 **or** after whitespace — skills load
 * mid-prompt, so the completer must be able to rewrite that token. Commands
 * are still only *offered* when {@link getSlashQuery} reports `atStart`
 * (they only dispatch at position 0 of the text block; #110).
 */
export const SLASH_TOKEN_RE = /\/(\S*)$/;

/** Replace the partial `/q` token under the caret with `/<name> `. */
export function applySlashPick(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const hit = getSlashQuery(text, caret);
  if (!hit) return { text, caret };
  const m = before.match(SLASH_TOKEN_RE);
  if (!m) return { text, caret };
  const slashIndex = before.length - m[0].length;
  const newBefore = before.slice(0, slashIndex) + `/${name} `;
  return { text: newBefore + after, caret: newBefore.length };
}

/**
 * The slash command a typed message dispatches, or `null` for ordinary prose.
 *
 * The CLI only recognizes a slash command when it sits at position 0 of the
 * prompt's text block — editor-injected context in front of it silently turns
 * `/compact` into a normal LLM turn (verified against grok 0.2.87 in
 * research/compact-probe.cjs). The caller uses a match to move that context
 * BEHIND the command text instead (see buildPrompt), so this must never match
 * prose: the token boundary rejects Unix paths (`/tmp/foo` — `tmp` is followed
 * by `/`, not whitespace/end), and a known-commands check rejects things shaped
 * like commands that grok never advertised. An empty `commandNames` means the
 * `available_commands_update` hasn't arrived yet — fall back to shape alone,
 * since a wrongly-trailing envelope (broken dispatch) costs far more than a
 * wrongly-leading one (grok just reads the context first).
 */
export function matchSlashCommand(text: string, commandNames: string[]): string | null {
  const m = text.match(/^\/([A-Za-z0-9][\w.:-]*)(?:\s|$)/);
  if (!m) return null;
  if (commandNames.length === 0) return m[1];
  return commandNames.includes(m[1]) ? m[1] : null;
}

export function matchProviderSlashCommand(provider: AcpProvider, text: string, commandNames: string[]): string | null {
  const command = matchSlashCommand(text, commandNames);
  return command === "compact" && !supportsCompaction(provider) ? null : command;
}
